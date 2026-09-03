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
} from './config.js';
import {
    runVerification,
    getDefaultBranch,
    buildPathSpecArgs,
    getGitDiff,
    updateCursor,
} from './git.js';
import {
    generateRepairProposals,
    generateFixProposals,
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
    console.log(`🧹 Code Janitor initializing [provider: ${provider} | model: ${modelName} | mode: ${mode}]`);
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

async function runJanitor() {
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
    const { diff: recentDiff, currentHead } = getGitDiff(pathSpecArgs);

    if (!recentDiff.trim()) {
        console.log("No recent diff content detected. Janitor task completed.");
        recordNote('No recent diff content in the analysis window; nothing to review.');
        if (currentHead) {
            updateCursor(currentHead);
        }
        return;
    }

    const proposedFixes = await generateFixProposals(recentDiff, process.cwd(), existingPRContext);
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