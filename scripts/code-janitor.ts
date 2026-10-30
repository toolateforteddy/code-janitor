import { execFileSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    provider,
    modelName,
    testCmd,
    testTimeoutMs,
    lintCmd,
    mode,
    targetPath,
    excludePathsStr,
    dedupePRs,
    triageThresholdChars,
    architectureDocs,
    DOCS_ONLY_MODE,
    sweepEnabled,
} from './config.js';
import { runArchitectureDocs } from './archdocs.js';
import {
    runVerification,
    getDefaultBranch,
    buildPathSpecArgs,
    getGitDiff,
    getDiffOverview,
    filterDiffToFiles,
    updateCursor,
} from './git.js';
import {
    generateRepairProposals,
    generateFixProposals,
    selectFilesForReview,
    extractFilePathsFromDiff,
    modelFallback,
} from './ai.js';
import { processFixes } from './pr.js';
import { installMissingDependencies } from './deps.js';
import {
    fetchExistingJanitorPRs,
    filterDuplicateProposals,
    describeExistingJanitorPRs,
    ExistingJanitorPR,
} from './dedupe.js';
import {
    createRunSummary,
    setSummary,
    getSummary,
    recordNote,
    writeJobSummary,
} from './summary.js';

export async function main() {
    const fallbackNote = modelFallback.hasFallback
        ? ` | fallback: ${modelFallback.fallbackLabel}`
        : '';
    console.log(`🧹 Code Janitor initializing [provider: ${provider} | model: ${modelName}${fallbackNote} | mode: ${mode}]`);
    const summary = createRunSummary(provider, modelName, mode);
    setSummary(summary);
    try {
        await runJanitor();
    } catch (err) {
        recordNote(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    } finally {
        // Always publish the summary, including on the early returns and on a fatal error,
        // so a run that stops short still explains itself in the Actions UI.
        writeJobSummary(summary);
    }
}

/**
 * One run: the code sweep, when there is new work and the mode allows it, then the
 * architecture-docs refresh, whenever `architecture_docs` is set. The refresh does not
 * depend on the sweep: it runs on a red main, on a night with nothing new to sweep, and
 * after a sweep that failed.
 */
async function runJanitor() {
    const docsOnly = mode === DOCS_ONLY_MODE;
    const refreshDocs = docsOnly || architectureDocs.length > 0;
    const startHead = currentHead();

    let sweepError: unknown = null;
    if (docsOnly) {
        console.log(`📚 janitor_mode is '${DOCS_ONLY_MODE}': no code sweep this run.`);
    } else if (!sweepEnabled) {
        console.log('🧹 Nothing new since the last sweep; only the architecture docs are checked this run.');
        recordNote('No new commits since the last sweep; code sweep skipped.');
    } else {
        try {
            await runSweep();
        } catch (err) {
            sweepError = err;
        }
    }

    if (refreshDocs) {
        try {
            returnToHead(startHead);
            await runArchitectureDocs(architectureDocs, process.cwd(), startHead);
        } catch (err) {
            if (sweepError) recordNote(`Code sweep failed: ${sweepError instanceof Error ? sweepError.message : String(sweepError)}`);
            throw err;
        }
    }
    if (sweepError) throw sweepError;
}

function currentHead(): string {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
        return '';
    }
}

/**
 * Puts the checkout back on the commit the run started from. Only the sequential fallback
 * (no worktree support) leaves it elsewhere, on the branch of the last PR it opened.
 */
function returnToHead(head: string): void {
    if (!head || currentHead() === head) return;
    execFileSync('git', ['checkout', '-q', '--detach', head], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function runSweep() {
    const summary = getSummary();

    const defaultBranch = getDefaultBranch();

    // Pull the janitor's own prior PRs up front so both the prompt and the post-hoc
    // filter can suppress work that's already submitted. A nightly repair sweep sees
    // the same red main branch until the pending fix merges, so without this it opens
    // a brand-new PR for the same fix on every run.
    let existingPRs: ExistingJanitorPR[] = [];
    if (dedupePRs) {
        existingPRs = fetchExistingJanitorPRs();
        summary.existingJanitorPRs = existingPRs.length;
        console.log(`🔁 Deduplication: found ${existingPRs.length} existing janitor PR(s) to compare proposals against.`);
    } else {
        console.log("🔁 Deduplication disabled (DEDUPE_PRS=false).");
        recordNote('Deduplication disabled (DEDUPE_PRS=false).');
    }
    const existingPRContext = dedupePRs ? describeExistingJanitorPRs(existingPRs) : '';

    // -------------------------------------------------------------
    // STEP 1: INITIAL HEALTH CHECK
    // -------------------------------------------------------------
    console.log("🔍 Checking main branch health...");
    installMissingDependencies(process.cwd());
    const verifResult = runVerification(lintCmd, testCmd, testTimeoutMs);

    let isBroken = false;
    let buildErrorLogs = '';

    if (!verifResult.success) {
        isBroken = true;
        buildErrorLogs = verifResult.failureOutput;
        summary.branchHealth = 'broken';
        recordNote(`Main branch failing at ${verifResult.failedStep || 'verification'}.`);
        console.log("⚠️ Failures detected on main branch!");
    } else {
        summary.branchHealth = 'green';
        console.log("✅ Main branch is clean and healthy!");
    }

    // -------------------------------------------------------------
    // STEP 2: REPAIR SWEEP (Triggers if main is broken)
    // -------------------------------------------------------------
    if (isBroken) {
        if (mode === 'refactor-only') {
            console.log("⛔ Main branch is failing and mode is 'refactor-only'. Aborting run to avoid bad refactors.");
            recordNote("Main branch is failing and mode is 'refactor-only'; run aborted to avoid refactoring broken code.");
            return;
        }

        console.log("🔧 Entering REPAIR mode to fix failing tests/lints...");
        summary.sweep = 'repair';
        const proposedRepairs = await generateRepairProposals(buildErrorLogs, process.cwd(), existingPRContext);
        const repairFixes = dedupePRs ? filterDuplicateProposals(proposedRepairs, existingPRs, 'repair') : proposedRepairs;
        const skippedRepairs = proposedRepairs.length - repairFixes.length;
        summary.proposed = repairFixes.length;
        summary.duplicatesSkipped = skippedRepairs;
        console.log(`Found ${repairFixes.length} proposed repair tasks${skippedRepairs > 0 ? ` (${skippedRepairs} skipped as duplicates of existing janitor PRs)` : ''}.`);
        if (repairFixes.length > 0) {
            console.log("Planned Repair PRs:");
            repairFixes.forEach((fix, idx) => {
                console.log(`  ${idx + 1}. 🚨 ${fix.title}`);
            });
        }

        await processFixes(repairFixes, defaultBranch, 'repair');
        console.log("🛑 Repair sweep complete. Skipping refactor sweep until main is green.");
        return; // STOP EXECUTION HERE — Do not attempt refactoring broken code
    }

    // -------------------------------------------------------------
    // STEP 3: REFACTOR SWEEP (Triggers only if main is clean)
    // -------------------------------------------------------------
    if (mode === 'repair-only') {
        console.log("✅ Main branch is clean and mode is 'repair-only'. Nothing to fix.");
        recordNote("Main branch is clean and mode is 'repair-only'; nothing to fix.");
        return;
    }

    console.log("✨ Main branch is clean. Entering REFACTOR mode...");
    summary.sweep = 'refactor';
    const pathSpecArgs = buildPathSpecArgs(targetPath, excludePathsStr);
    const { diff: recentDiff, currentHead, baseCommit, failed: diffFailed, janitorCommits } = getGitDiff(pathSpecArgs);

    if (diffFailed) {
        // Leave the cursor where it is so the next run retries this window.
        recordNote('Could not compute the diff for the analysis window; cursor left unchanged.');
        return;
    }

    if (!recentDiff.trim()) {
        console.log("No recent diff content detected. Janitor task completed.");
        recordNote(janitorCommits
            ? `Only the janitor's own commits (${janitorCommits}) in the analysis window, or none outside them in scope; nothing to review.`
            : 'No recent diff content in the analysis window; nothing to review.');
        if (currentHead) {
            updateCursor(currentHead);
        }
        return;
    }

    let reviewDiff = recentDiff;
    if (recentDiff.length > triageThresholdChars) {
        // Too large to send whole: let the model choose from the commit log and the
        // per-file stat, then send only the files it picked.
        const candidates = extractFilePathsFromDiff(recentDiff);
        console.log(`📚 Diff is ${recentDiff.length} characters across ${candidates.length} files; triaging before review.`);
        const picked = await selectFilesForReview(getDiffOverview(baseCommit, currentHead, pathSpecArgs), candidates, existingPRContext);
        if (picked.length === 0) {
            recordNote(`Triage of ${candidates.length} changed files picked none worth reviewing.`);
            if (currentHead) {
                updateCursor(currentHead);
            }
            return;
        }
        recordNote(`Large window (${candidates.length} changed files); reviewed the ${picked.length} the model picked: ${picked.join(', ')}.`);
        reviewDiff = filterDiffToFiles(recentDiff, picked);
    }

    const proposedFixes = await generateFixProposals(reviewDiff, process.cwd(), existingPRContext);
    const fixes = dedupePRs ? filterDuplicateProposals(proposedFixes, existingPRs, 'refactor') : proposedFixes;
    const skippedFixes = proposedFixes.length - fixes.length;
    summary.proposed = fixes.length;
    summary.duplicatesSkipped = skippedFixes;
    console.log(`Found ${fixes.length} proposed atomic improvements${skippedFixes > 0 ? ` (${skippedFixes} skipped as duplicates of existing janitor PRs)` : ''}.`);
    if (fixes.length > 0) {
        console.log("Planned PRs:");
        fixes.forEach((fix, idx) => {
            console.log(`  ${idx + 1}. 🧹 ${fix.title}`);
        });
    }

    await processFixes(fixes, defaultBranch, 'refactor');

    if (currentHead) {
        updateCursor(currentHead);
    }
}

export function isDirectExecution(): boolean {
    if (!process.argv[1]) return false;
    try {
        const entryPath = path.resolve(process.argv[1]);
        const currentPath = fileURLToPath(import.meta.url);
        return entryPath === currentPath;
    } catch {
        return false;
    }
}

if (isDirectExecution()) {
    const targetWorkspace = process.argv[2] || process.cwd();
    process.chdir(targetWorkspace);

    main().catch((err) => {
        console.error("Fatal Janitor Engine Error:", err);
        process.exit(1);
    });
}