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
import {
    fetchExistingJanitorPRs,
    filterDuplicateProposals,
    describeExistingJanitorPRs,
    ExistingJanitorPR,
} from './dedupe.js';

export async function main() {
    console.log(`🧹 Code Janitor initializing [provider: ${provider} | model: ${modelName} | mode: ${mode}]`);

    const defaultBranch = getDefaultBranch();

    // Pull the janitor's own prior PRs up front so both the prompt and the post-hoc
    // filter can suppress work that's already submitted. A nightly repair sweep sees
    // the same red main branch until the pending fix merges, so without this it opens
    // a brand-new PR for the same fix on every run.
    let existingPRs: ExistingJanitorPR[] = [];
    if (dedupePRs) {
        existingPRs = fetchExistingJanitorPRs();
        console.log(`🔁 Deduplication: found ${existingPRs.length} existing janitor PR(s) to compare proposals against.`);
    } else {
        console.log("🔁 Deduplication disabled (DEDUPE_PRS=false).");
    }
    const existingPRContext = dedupePRs ? describeExistingJanitorPRs(existingPRs) : '';

    // -------------------------------------------------------------
    // STEP 1: INITIAL HEALTH CHECK
    // -------------------------------------------------------------
    console.log("🔍 Checking main branch health...");
    const verifResult = runVerification(lintCmd, testCmd, testTimeoutMs);

    let isBroken = false;
    let buildErrorLogs = '';

    if (!verifResult.success) {
        isBroken = true;
        buildErrorLogs = verifResult.failureOutput;
        console.log("⚠️ Failures detected on main branch!");
    } else {
        console.log("✅ Main branch is clean and healthy!");
    }

    // -------------------------------------------------------------
    // STEP 2: REPAIR SWEEP (Triggers if main is broken)
    // -------------------------------------------------------------
    if (isBroken) {
        if (mode === 'refactor-only') {
            console.log("⛔ Main branch is failing and mode is 'refactor-only'. Aborting run to avoid bad refactors.");
            return;
        }

        console.log("🔧 Entering REPAIR mode to fix failing tests/lints...");
        const proposedRepairs = await generateRepairProposals(buildErrorLogs, process.cwd(), existingPRContext);
        const repairFixes = dedupePRs ? filterDuplicateProposals(proposedRepairs, existingPRs, 'repair') : proposedRepairs;
        const skippedRepairs = proposedRepairs.length - repairFixes.length;
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
        return;
    }

    console.log("✨ Main branch is clean. Entering REFACTOR mode...");
    const pathSpecArgs = buildPathSpecArgs(targetPath, excludePathsStr);
    const { diff: recentDiff, currentHead } = getGitDiff(pathSpecArgs);

    if (!recentDiff.trim()) {
        console.log("No recent diff content detected. Janitor task completed.");
        if (currentHead) {
            updateCursor(currentHead);
        }
        return;
    }

    const proposedFixes = await generateFixProposals(recentDiff, process.cwd(), existingPRContext);
    const fixes = dedupePRs ? filterDuplicateProposals(proposedFixes, existingPRs, 'refactor') : proposedFixes;
    const skippedFixes = proposedFixes.length - fixes.length;
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