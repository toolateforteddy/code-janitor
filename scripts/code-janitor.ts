import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { execSync, execFileSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Set API key fallback for Google provider
if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

// Environment Configurations
const provider = (process.env.AI_PROVIDER || 'google').toLowerCase();
const modelName = process.env.AI_MODEL || 'gemini-3.6-flash';
const testCmd = process.env.TEST_CMD || 'go test ./...';
const testTimeoutMinutes = parseInt(process.env.TEST_TIMEOUT || '5', 10);
const testTimeoutMs = (isNaN(testTimeoutMinutes) || testTimeoutMinutes <= 0 ? 5 : testTimeoutMinutes) * 60 * 1000;
const lintCmd = process.env.LINT_CMD || '';
const mode = (process.env.JANITOR_MODE || 'auto').toLowerCase();
const targetPath = process.env.TARGET_PATH || '.';
const excludePathsStr = process.env.EXCLUDE_PATHS || '.github/workflows/**, vendor/**, generated/**, dist/**';
const enableTestGen = process.env.ENABLE_TEST_GEN === 'true';
const maxPRs = parseInt(process.env.MAX_PRS || '3', 10);
const maxLineDiff = parseInt(process.env.MAX_LINE_DIFF || '100', 10);
const reviewers = process.env.REVIEWERS || '';
const isDraft = process.env.DRAFT_PR === 'true';
const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY || '3', 10);

export const STATE_FILE = '.janitor-state.json';

export interface JanitorState {
    lastAnalyzedCommit: string;
    lastRunTimestamp: string;
}

// Schema for proposed atomic fixes
const fixProposalSchema = z.object({
    slug: z.string().describe('Short url-safe string for git branch, e.g., fix-nil-pointer'),
    title: z.string().describe('Concise PR title'),
    description: z.string().describe('Explanation of the refactor or added test'),
    filePath: z.string().describe('Relative path to the target file'),
    updatedContent: z.string().describe('Full new content for the file'),
});

const fixesResponseSchema = z.object({
    fixes: z.array(fixProposalSchema).max(maxPRs),
});

export type FixProposal = z.infer<typeof fixProposalSchema>;

export function getModel(prov: string, mod: string) {
    switch (prov) {
        case 'anthropic':
            return anthropic(mod || 'claude-3-5-sonnet-20241022');
        case 'openai':
            return openai(mod || 'gpt-4o');
        case 'google':
        default:
            return google(mod || 'gemini-3.6-flash');
    }
}

export function runCmd(command: string, label: string, timeoutMs?: number, cwd?: string): { success: boolean; output: string } {
    console.log(`Running ${label} command: ${command}`);
    try {
        const execOptions: ExecSyncOptionsWithStringEncoding = {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: cwd || process.cwd(),
        };
        if (timeoutMs && timeoutMs > 0) {
            execOptions.timeout = timeoutMs;
        }
        const stdout = execSync(command, execOptions);
        if (stdout.trim()) {
            console.log(stdout.trim());
        }
        return { success: true, output: stdout };
    } catch (err: any) {
        const stdout = err.stdout ? err.stdout.toString() : '';
        const stderr = err.stderr ? err.stderr.toString() : '';
        let combined = (stdout + '\n' + stderr).trim();
        if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
            const timeoutMinutes = timeoutMs ? timeoutMs / 60000 : 0;
            const timeoutMsg = `❌ Command timed out after ${timeoutMinutes} minute(s).`;
            combined = combined ? `${combined}\n${timeoutMsg}` : timeoutMsg;
        } else if (!combined) {
            combined = err.message || 'Command failed';
        }
        console.error(`❌ ${label} command failed:\n${combined}`);
        return { success: false, output: combined };
    }
}

export function runVerification(lCmd: string, tCmd: string, tTimeoutMs?: number, cwd?: string): { success: boolean; failureOutput: string; failedStep: string } {
    if (lCmd) {
        const lintRes = runCmd(lCmd, 'lint', undefined, cwd);
        if (!lintRes.success) {
            return { success: false, failureOutput: lintRes.output, failedStep: 'lint' };
        }
    }
    if (tCmd) {
        const testRes = runCmd(tCmd, 'test', tTimeoutMs, cwd);
        if (!testRes.success) {
            return { success: false, failureOutput: testRes.output, failedStep: 'test' };
        }
    }
    return { success: true, failureOutput: '', failedStep: '' };
}

export function getDefaultBranch(): string {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim() || 'main';
    } catch {
        return 'main';
    }
}

export function buildPathSpecArgs(target: string, excludesStr: string): string {
    let pathSpecArgs = '';
    if (target && target !== '.') {
        pathSpecArgs += ` -- "${target}"`;
    }
    if (excludesStr) {
        const excludes = excludesStr.split(',').map(p => p.trim()).filter(Boolean);
        for (const ex of excludes) {
            pathSpecArgs += ` ":(exclude)${ex}"`;
        }
    }
    return pathSpecArgs;
}

export function getGitDiff(pathSpecArgs: string, stateFilePath: string = STATE_FILE): { diff: string; currentHead: string; baseCommit: string } {
    let currentHead = '';
    try {
        currentHead = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    } catch {
        currentHead = '';
    }

    let baseCommit = '';

    if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
            const raw = fs.readFileSync(stateFilePath, 'utf-8');
            const state: JanitorState = JSON.parse(raw);
            if (state.lastAnalyzedCommit) {
                execSync(`git cat-file -e ${state.lastAnalyzedCommit}`, { stdio: 'ignore' });
                baseCommit = state.lastAnalyzedCommit;
                console.log(`📍 Found previous cursor at commit: ${baseCommit.slice(0, 7)}`);
            }
        } catch {
            console.log("⚠️ Stale or invalid state cursor. Falling back to HEAD~1.");
        }
    }

    if (!baseCommit && currentHead) {
        try {
            baseCommit = execSync('git rev-parse HEAD~1', { encoding: 'utf-8' }).trim();
        } catch {
            baseCommit = currentHead;
        }
    }

    if (baseCommit && currentHead && baseCommit === currentHead) {
        return { diff: '', currentHead, baseCommit };
    }

    try {
        const diffRange = baseCommit && currentHead ? `${baseCommit}..${currentHead}` : 'HEAD~1 HEAD';
        console.log(`🔍 Calculating diff across window: [${diffRange}]`);
        const diff = execSync(`git diff ${diffRange}${pathSpecArgs}`, { encoding: 'utf-8' });
        return { diff, currentHead, baseCommit };
    } catch {
        console.warn("Unable to fetch diff using revision range, reading current workspace diff...");
        try {
            const diff = execSync(`git diff${pathSpecArgs}`, { encoding: 'utf-8' });
            return { diff, currentHead, baseCommit };
        } catch {
            return { diff: '', currentHead, baseCommit };
        }
    }
}

export function updateCursor(newHead: string, stateFilePath: string = STATE_FILE): void {
    if (!newHead) return;
    const state: JanitorState = {
        lastAnalyzedCommit: newHead,
        lastRunTimestamp: new Date().toISOString(),
    };
    try {
        fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
        console.log(`📌 Advanced Janitor cursor to ${newHead.slice(0, 7)}`);
    } catch (err) {
        console.warn(`Failed to update cursor file ${stateFilePath}:`, err);
    }
}

export async function generateRepairProposals(buildErrorLogs: string): Promise<FixProposal[]> {
    const repairPrompt = `
    You are an expert software engineer and debugger.
    The project build or test suite is currently FAILING on the main branch.

    Analyze the build errors provided below and generate minimal, atomic fixes to resolve the issue and make the test suite pass.
    
    RULES:
    1. Fix ONLY what is necessary to resolve the build or test failures.
    2. Do NOT introduce new features or unnecessary refactoring.
    3. Keep diffs as concise as possible (under ~${maxLineDiff} total diff lines).
  `;

    console.log("🔧 Querying model for repair proposals...");
    const response = await generateObject({
        model: getModel(provider, modelName),
        schema: fixesResponseSchema,
        system: repairPrompt,
        prompt: `Build/Test Error Logs:\n\n${buildErrorLogs.slice(0, 15000)}`,
    });

    return response.object.fixes;
}

export async function generateFixProposals(diff: string): Promise<FixProposal[]> {
    const systemPrompt = `
    You are an expert static analyzer and software maintainer.
    Analyze the recent git diffs and identify up to ${maxPRs} distinct, high-value improvements or edge-case unit tests.
    
    RULES:
    1. Each fix MUST be completely self-contained and atomic.
    2. Do NOT propose changes larger than ~${maxLineDiff} total diff lines.
    3. ${enableTestGen ? 'Feel free to generate table-driven unit tests for uncovered paths.' : 'Do NOT generate new test files; focus only on code refactoring.'}
    4. Focus on idiomatic improvements, resource cleanup, performance, or edge-case bug fixes.
  `;

    console.log("🤖 Querying model for refactor proposals...");
    const response = await generateObject({
        model: getModel(provider, modelName),
        schema: fixesResponseSchema,
        system: systemPrompt,
        prompt: `Recent codebase diffs:\n\n${diff.slice(0, 15000)}`,
    });

    return response.object.fixes;
}

export async function attemptAutoFix(
    fix: FixProposal,
    failedStep: string,
    failureOutput: string,
    currentContent: string,
    workDir: string
): Promise<{ success: boolean; updatedContent: string; verifResult: ReturnType<typeof runVerification> }> {
    console.log(`\n⚠️ Verification failed during ${failedStep}. Attempting auto-fix retry...`);

    const retrySchema = z.object({
        explanation: z.string().describe('Explanation of how the test/lint failure is fixed'),
        updatedContent: z.string().describe('Full updated file content'),
    });

    const retrySystemPrompt = `
    You are an expert software engineer fixing a failing test or lint check caused by a recent refactoring attempt.
    Analyze the failure log output and the target file content, then generate a revised version of the file content that resolves the failures while preserving the core refactoring intent.
`;
    try {
        const retryResponse = await generateObject({
            model: getModel(provider, modelName),
            schema: retrySchema,
            system: retrySystemPrompt,
            prompt: `Target File: ${fix.filePath}\n\nProposed Fix Title: ${fix.title}\n\nFailure Output (${failedStep}):\n${failureOutput}\n\nCurrent File Content:\n${currentContent}`,
        });

        console.log(`🤖 Auto-fix proposal: ${retryResponse.object.explanation}`);
        const updatedContent = retryResponse.object.updatedContent;
        const absolutePath = path.resolve(workDir, fix.filePath);
        fs.writeFileSync(absolutePath, updatedContent, 'utf-8');

        console.log(`Rerunning verification after auto-fix attempt...`);
        const verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
        return { success: verifResult.success, updatedContent, verifResult };
    } catch (retryErr) {
        console.error(`Failed during auto-fix generation/execution:`, retryErr);
        return {
            success: false,
            updatedContent: currentContent,
            verifResult: { success: false, failureOutput: String(retryErr), failedStep: 'retry' }
        };
    }
}

export function createAndSubmitPR(fix: FixProposal, branchName: string, workDir: string, modeType: 'repair' | 'refactor' = 'refactor') {
    console.log(`Tests passed! Creating commit and PR...`);
    const execOpts = { cwd: workDir };
    const emoji = modeType === 'repair' ? '🚨' : '🧹';
    const prPrefix = modeType === 'repair' ? 'fix' : 'refactor';

    execFileSync('git', ['config', 'user.name', 'Code Janitor Bot'], execOpts);
    execFileSync('git', ['config', 'user.email', 'bot@codejanitor.local'], execOpts);
    execFileSync('git', ['add', fix.filePath], execOpts);
    execFileSync('git', ['commit', '-m', `${prPrefix}: ${fix.title}`], execOpts);

    try {
        execFileSync('git', ['push', 'origin', branchName], execOpts);
    } catch (err) {
        console.error(`❌ Failed to push branch '${branchName}' to origin:`, err);
        throw new Error(`Failed to push branch '${branchName}' to origin: ${err instanceof Error ? err.message : String(err)}`);
    }

    const prArgs = [
        'pr', 'create',
        '--title', `${emoji} ${fix.title}`,
        '--body', `${fix.description}\n\n_Generated automatically by Code Janitor [${modeType.toUpperCase()} mode]_`,
        '--head', branchName
    ];
    if (isDraft) prArgs.push('--draft');
    if (reviewers) prArgs.push('--reviewer', reviewers);

    try {
        execFileSync('gh', prArgs, { stdio: 'inherit', cwd: workDir });
        console.log(` Successfully created PR for: ${fix.title}`);
    } catch (err) {
        console.error(`❌ Failed to create pull request via GitHub CLI:`, err);
        throw new Error(`Failed to create pull request via GitHub CLI: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function logFailedDiff(fix: FixProposal, workDir: string) {
    try {
        let failedDiff = '';
        try {
            failedDiff = execSync('git diff HEAD', { encoding: 'utf-8', cwd: workDir });
        } catch {
            failedDiff = execSync('git diff', { encoding: 'utf-8', cwd: workDir });
        }
        console.log(`\n=================== FAILED FIX DIFF (${fix.slug}) ===================`);
        console.log(failedDiff.trim() || '(No diff output detected)');
        console.log(`====================================================================\n`);
    } catch (diffErr) {
        console.error(`Failed to print git diff for '${fix.slug}':`, diffErr);
    }
}

export function cleanupWorktree(worktreePath: string) {
    try {
        if (fs.existsSync(worktreePath)) {
            execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { stdio: 'ignore' });
        }
    } catch {
        try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
            execFileSync('git', ['worktree', 'prune'], { stdio: 'ignore' });
        } catch {}
    }
}

export async function processFixWorktree(fix: FixProposal, defaultBranch: string, modeType: 'repair' | 'refactor' = 'refactor'): Promise<boolean> {
    const timestamp = Date.now();
    const branchName = `janitor/${fix.slug}-${timestamp}`;
    const worktreePath = path.resolve(process.cwd(), `.janitor-worktree-${fix.slug}-${timestamp}`);

    try {
        console.log(`\n--- Processing Fix (Worktree): ${fix.title} ---`);
        execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, defaultBranch]);

        const absolutePath = path.resolve(worktreePath, fix.filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        let currentContent = fix.updatedContent;
        fs.writeFileSync(absolutePath, currentContent, 'utf-8');

        const diffStat = execSync('git diff --shortstat', { encoding: 'utf-8', cwd: worktreePath });
        console.log(`Diff summary (${fix.slug}): ${diffStat.trim()}`);

        let verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, worktreePath);

        if (!verifResult.success) {
            const autoFixRes = await attemptAutoFix(fix, verifResult.failedStep, verifResult.failureOutput, currentContent, worktreePath);
            verifResult = autoFixRes.verifResult;
        }

        if (!verifResult.success) {
            console.error(`❌ Verification failed for fix '${fix.slug}'. Cleaning up...`);
            logFailedDiff(fix, worktreePath);
            return false;
        }

        createAndSubmitPR(fix, branchName, worktreePath, modeType);
        return true;
    } catch (error) {
        console.error(`❌ Error processing fix '${fix.slug}':`, error);
        throw error;
    } finally {
        cleanupWorktree(worktreePath);
    }
}

export async function processFixSequential(fix: FixProposal, defaultBranch: string, modeType: 'repair' | 'refactor' = 'refactor'): Promise<boolean> {
    const timestamp = Date.now();
    const branchName = `janitor/${fix.slug}-${timestamp}`;
    const workDir = process.cwd();

    console.log(`\n--- Processing Fix (Sequential): ${fix.title} ---`);
    execFileSync('git', ['checkout', defaultBranch]);
    try {
        execFileSync('git', ['reset', '--hard', `origin/${defaultBranch}`]);
    } catch {
        execFileSync('git', ['reset', '--hard', defaultBranch]);
    }
    execFileSync('git', ['checkout', '-b', branchName]);

    try {
        const absolutePath = path.resolve(workDir, fix.filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        let currentContent = fix.updatedContent;
        fs.writeFileSync(absolutePath, currentContent, 'utf-8');

        const diffStat = execSync('git diff --shortstat', { encoding: 'utf-8', cwd: workDir });
        console.log(`Diff summary: ${diffStat.trim()}`);

        let verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);

        if (!verifResult.success) {
            const autoFixRes = await attemptAutoFix(fix, verifResult.failedStep, verifResult.failureOutput, currentContent, workDir);
            verifResult = autoFixRes.verifResult;
        }

        if (!verifResult.success) {
            console.error(`❌ Verification failed for fix '${fix.slug}'. Discarding branch...`);
            logFailedDiff(fix, workDir);
            try {
                execFileSync('git', ['checkout', defaultBranch]);
                execFileSync('git', ['reset', '--hard', defaultBranch]);
            } catch { /* ignore */ }
            return false;
        }

        createAndSubmitPR(fix, branchName, workDir, modeType);
        return true;
    } catch (error) {
        console.error(`❌ Error processing fix '${fix.slug}':`, error);
        try {
            execFileSync('git', ['checkout', defaultBranch]);
            execFileSync('git', ['reset', '--hard', defaultBranch]);
        } catch { /* ignore */ }
        throw error;
    }
}

export async function processFixes(fixes: FixProposal[], defaultBranch: string, modeType: 'repair' | 'refactor' = 'refactor') {
    if (fixes.length === 0) return;

    let supportsWorktrees = false;
    const testWorktreePath = path.resolve(process.cwd(), `.janitor-test-worktree-${Date.now()}`);
    try {
        execFileSync('git', ['worktree', 'add', '--detach', testWorktreePath, defaultBranch], { stdio: 'ignore' });
        execFileSync('git', ['worktree', 'remove', '--force', testWorktreePath], { stdio: 'ignore' });
        supportsWorktrees = true;
    } catch {
        supportsWorktrees = false;
    }

    const pushErrors: Error[] = [];

    if (supportsWorktrees && maxConcurrency > 1) {
        console.log(`⚡ Processing ${fixes.length} fixes in parallel (max concurrency: ${maxConcurrency})...`);
        const queue = [...fixes];
        const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, async () => {
            while (queue.length > 0) {
                const fix = queue.shift();
                if (fix) {
                    try {
                        await processFixWorktree(fix, defaultBranch, modeType);
                    } catch (err) {
                        pushErrors.push(err instanceof Error ? err : new Error(String(err)));
                    }
                }
            }
        });
        await Promise.all(workers);
    } else {
        console.log(`🔄 Processing ${fixes.length} fixes sequentially...`);
        for (const fix of fixes) {
            try {
                if (supportsWorktrees) {
                    await processFixWorktree(fix, defaultBranch, modeType);
                } else {
                    await processFixSequential(fix, defaultBranch, modeType);
                }
            } catch (err) {
                pushErrors.push(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    if (pushErrors.length > 0) {
        throw new Error(`Failed to push/submit ${pushErrors.length} PR(s):\n` + pushErrors.map(e => ` - ${e.message}`).join('\n'));
    }
}

export async function main() {
    console.log(`🧹 Code Janitor initializing [provider: ${provider} | model: ${modelName} | mode: ${mode}]`);

    const defaultBranch = getDefaultBranch();

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
        const repairFixes = await generateRepairProposals(buildErrorLogs);
        console.log(`Found ${repairFixes.length} proposed repair tasks.`);
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

    const fixes = await generateFixProposals(recentDiff);
    console.log(`Found ${fixes.length} proposed atomic improvements.`);
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