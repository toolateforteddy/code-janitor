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
export const fileChangeSchema = z.object({
    filePath: z.string().describe('Relative path to the file being created or modified'),
    updatedContent: z.string().describe('Full new content for the file'),
});

export type FileChange = z.infer<typeof fileChangeSchema>;

export const fixProposalSchema = z.object({
    slug: z.string().describe('Short url-safe string for git branch, e.g., fix-nil-pointer'),
    title: z.string().describe('Concise PR title'),
    description: z.string().describe('Explanation of the refactor, added test, or callsite updates'),
    changes: z.array(fileChangeSchema).min(1).max(5).describe('List of file changes included in this atomic fix (e.g. prod file refactor + separate test file, or function signature change + updated callsites)').optional(),
    filePath: z.string().optional().describe('Deprecated single file path; prefer "changes" array'),
    updatedContent: z.string().optional().describe('Deprecated single file updated content; prefer "changes" array'),
});

const fixesResponseSchema = z.object({
    fixes: z.array(fixProposalSchema).max(maxPRs),
});

export type FixProposal = z.infer<typeof fixProposalSchema>;

export function getProposalChanges(fix: FixProposal): FileChange[] {
    if (fix.changes && Array.isArray(fix.changes) && fix.changes.length > 0) {
        return fix.changes;
    }
    if (fix.filePath && fix.updatedContent !== undefined) {
        return [{ filePath: fix.filePath, updatedContent: fix.updatedContent }];
    }
    return [];
}

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

export function extractTopLevelDeclarations(content: string, _ext: string): string[] {
    const lines = content.split(/\r?\n/);
    const declarations: string[] = [];

    for (const line of lines) {
        if (/^\s+/.test(line)) continue;

        const match = line.match(/^(?:export\s+)?(?:pub\s+)?(?:async\s+)?(?:@\w+(?:\([^)]*\))?\s+)*(?:fun|function|class|interface|object|struct|enum|trait|def|fn)\s+([A-Za-z0-9_]+)/);
        if (match && match[1]) {
            declarations.push(match[1]);
        }
    }
    return declarations;
}

export function validateSingleFileIntegrity(originalContent: string, updatedContent: string, filePath: string): { valid: boolean; reason: string } {
    if (!originalContent || !originalContent.trim()) {
        return { valid: true, reason: '' };
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    const isProductionPath = (normalizedPath.includes('/src/main/') || normalizedPath.startsWith('src/main/'));
    if (isProductionPath) {
        const testImportRegex = /import\s+(?:org\.junit|org\.testng|junit\.framework|kotlin\.test|org\.scalatest|@jest\/globals)/i;
        if (testImportRegex.test(updatedContent) && !testImportRegex.test(originalContent)) {
            return {
                valid: false,
                reason: `Integrity Check Failed: Attempted to add test framework imports into production source file '${filePath}'. Test code must be placed in appropriate test files or test source sets (e.g., src/test/).`
            };
        }
    }

    const ext = path.extname(filePath).toLowerCase();
    const origDeclarations = extractTopLevelDeclarations(originalContent, ext);
    const updatedDeclarations = new Set(extractTopLevelDeclarations(updatedContent, ext));

    const missingDeclarations = origDeclarations.filter(decl => !updatedDeclarations.has(decl));

    if (missingDeclarations.length > 0) {
        return {
            valid: false,
            reason: `Integrity Check Failed: Fix omitted top-level declaration(s) in ${filePath}: [${missingDeclarations.join(', ')}]. Do not remove existing top-level functions or classes.`
        };
    }

    const origLines = originalContent.split(/\r?\n/).length;
    const updatedLines = updatedContent.split(/\r?\n/).length;

    if (origLines > 25 && updatedLines < origLines * 0.5) {
        return {
            valid: false,
            reason: `Integrity Check Failed: Fix removed ${origLines - updatedLines} lines (${Math.round((1 - updatedLines / origLines) * 100)}% of file in ${filePath}), which exceeds allowable deletion limits.`
        };
    }

    return { valid: true, reason: '' };
}

export function validateFixIntegrity(
    originalContentOrMap: string | Map<string, string>,
    updatedContentOrChanges: string | FileChange[],
    filePath?: string
): { valid: boolean; reason: string } {
    if (typeof originalContentOrMap === 'string' && typeof updatedContentOrChanges === 'string' && filePath) {
        return validateSingleFileIntegrity(originalContentOrMap, updatedContentOrChanges, filePath);
    }

    const changes = Array.isArray(updatedContentOrChanges) ? updatedContentOrChanges : [];
    const origMap = originalContentOrMap instanceof Map ? originalContentOrMap : new Map<string, string>();

    for (const change of changes) {
        const orig = origMap.get(change.filePath) || '';
        const res = validateSingleFileIntegrity(orig, change.updatedContent, change.filePath);
        if (!res.valid) {
            return res;
        }
    }
    return { valid: true, reason: '' };
}

export async function generateRepairProposals(buildErrorLogs: string): Promise<FixProposal[]> {
    const repairPrompt = `
    You are an expert software engineer and debugger.
    The project build or test suite is currently FAILING on the main branch.

    Analyze the build errors provided below and generate minimal, atomic fixes to resolve the issue and make the test suite pass.
    
    RULES:
    1. Fix ONLY what is necessary to resolve the build or test failures.
    2. Do NOT introduce new features or unnecessary refactoring.
    3. Keep diffs as concise as possible (under ~${maxLineDiff} total diff lines across all modified files).
    4. MULTI-FILE PROPOSALS SUPPORTED: Include all modified files in the 'changes' array. You can modify up to 5 related files in a single proposal (e.g., fixing a function signature and updating callers/test files).
    5. PRESERVE ALL EXISTING TOP-LEVEL DECLARATIONS: Each file's 'updatedContent' MUST contain the full updated file. Do NOT delete or omit existing top-level functions, composables, classes, or declarations.
    6. PRESERVE API CONTRACTS: If you modify a function signature, update all relevant caller sites across modified files in 'changes'.
    7. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT resolve warnings or errors by adding language suppression annotations (e.g. @Suppress) or deleting callers. Ensure imported standard library functions exist and are valid.
    8. RESPECT IDIOMATIC TEST PLACEMENT: Only embed in-file tests if the target language natively supports conditional test compilation within source files (e.g., #[cfg(test)] in Rust). In languages where tests belong in separate test files or directories (e.g. Java/Kotlin src/test/, Go *_test.go, JS/TS *.test.ts or __tests__/), put tests in a dedicated test file in 'changes'.
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
    2. Do NOT propose changes larger than ~${maxLineDiff} total diff lines across all modified files.
    3. MULTI-FILE PROPOSALS SUPPORTED: Each proposal specifies a 'changes' array containing 1 to 5 file modifications. You can pair a production file refactor with a separate unit test file (e.g., in src/test/, *.test.ts, *_test.go) or update caller sites when modifying a signature.
    4. ${enableTestGen ? 'Feel free to generate unit tests for uncovered paths using language-idiomatic test patterns in a separate test file in "changes". ONLY embed in-file tests if the target language natively supports conditional test compilation within source files (e.g. #[cfg(test)] in Rust).' : 'Do NOT generate test files or test classes; focus only on code refactoring.'}
    5. Focus on idiomatic improvements, resource cleanup, performance, or edge-case bug fixes.
    6. PRESERVE ALL EXISTING TOP-LEVEL DECLARATIONS: 'updatedContent' MUST contain the full updated content for each file. Do NOT delete or omit existing top-level functions, composables, classes, or declarations.
    7. PRESERVE API CONTRACTS: If you modify a function signature, update all relevant call sites across modified files in 'changes'.
    8. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT swallow warnings or delete callers. Verify that all standard library functions and imports exist before using them.
    9. RESPECT IDIOMATIC TEST PLACEMENT: Follow language conventions for test file structure and placement. Do not pollute production source files with test framework imports or test runner annotations.
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
    currentChanges: FileChange[],
    workDir: string,
    originalContents?: Map<string, string>
): Promise<{ success: boolean; updatedChanges: FileChange[]; verifResult: ReturnType<typeof runVerification> }> {
    console.log(`\n⚠️ Verification/Integrity failed during ${failedStep}. Attempting auto-fix retry...`);

    const retrySchema = z.object({
        explanation: z.string().describe('Explanation of how the failure or integrity issue is fixed'),
        changes: z.array(fileChangeSchema).min(1).describe('Full updated file contents for all modified files'),
    });

    const retrySystemPrompt = `
    You are an expert software engineer fixing a failing test, lint check, or file integrity violation caused by a refactoring attempt.
    Analyze the failure log output, original file contents, and current file contents across all modified files in 'changes', then generate revised versions of the file contents that resolve all failures and integrity errors while preserving the core refactoring intent.

    STRICT RULES:
    1. PRESERVE ALL EXISTING TOP-LEVEL DECLARATIONS: Do NOT delete, truncate, or omit existing top-level functions, composables, or classes from the original files. 'updatedContent' MUST contain the ENTIRE file for each change.
    2. PRESERVE API CONTRACTS: Keep existing parameter signatures intact or update callers consistently across modified files.
    3. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT swallow warnings, delete caller functions, or use non-existent library imports.
    4. RESPECT IDIOMATIC TEST PLACEMENT: Follow language conventions for test placement. Do not add test framework imports or test runner annotations to production source files.
`;
    try {
        const fileContentsText = currentChanges.map(c => {
            const orig = originalContents?.get(c.filePath);
            return `--- File: ${c.filePath} ---\n${orig ? `Original Content:\n${orig}\n\n` : ''}Current Content:\n${c.updatedContent}`;
        }).join('\n\n');

        const retryPromptText = `Proposed Fix Title: ${fix.title}\n\nFailure Output (${failedStep}):\n${failureOutput}\n\nModified Files:\n${fileContentsText}`;

        const retryResponse = await generateObject({
            model: getModel(provider, modelName),
            schema: retrySchema,
            system: retrySystemPrompt,
            prompt: retryPromptText,
        });

        console.log(`🤖 Auto-fix proposal: ${retryResponse.object.explanation}`);
        const updatedChanges = retryResponse.object.changes;
        for (const change of updatedChanges) {
            const absolutePath = path.resolve(workDir, change.filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, change.updatedContent, 'utf-8');
        }

        console.log(`Rerunning verification after auto-fix attempt...`);
        const verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
        return { success: verifResult.success, updatedChanges, verifResult };
    } catch (retryErr) {
        console.error(`Failed during auto-fix generation/execution:`, retryErr);
        return {
            success: false,
            updatedChanges: currentChanges,
            verifResult: { success: false, failureOutput: String(retryErr), failedStep: 'retry' }
        };
    }
}

export function createAndSubmitPR(fix: FixProposal, branchName: string, workDir: string, modeType: 'repair' | 'refactor' = 'refactor') {
    console.log(`Tests passed! Creating commit and PR...`);
    const execOpts = { cwd: workDir };
    const emoji = modeType === 'repair' ? '🚨' : '🧹';
    const prPrefix = modeType === 'repair' ? 'fix' : 'refactor';

    const changes = getProposalChanges(fix);

    execFileSync('git', ['config', 'user.name', 'Code Janitor Bot'], execOpts);
    execFileSync('git', ['config', 'user.email', 'bot@codejanitor.local'], execOpts);
    for (const change of changes) {
        execFileSync('git', ['add', change.filePath], execOpts);
    }
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

        const changes = getProposalChanges(fix);
        const originalContents = new Map<string, string>();

        for (const change of changes) {
            const absolutePath = path.resolve(worktreePath, change.filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            const orig = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
            originalContents.set(change.filePath, orig);
            fs.writeFileSync(absolutePath, change.updatedContent, 'utf-8');
        }

        const diffStat = execSync('git diff --shortstat', { encoding: 'utf-8', cwd: worktreePath });
        console.log(`Diff summary (${fix.slug}): ${diffStat.trim()}`);

        const integrity = validateFixIntegrity(originalContents, changes);
        let verifResult: ReturnType<typeof runVerification>;

        if (!integrity.valid) {
            console.warn(`⚠️ Integrity validation failed for '${fix.slug}': ${integrity.reason}`);
            verifResult = { success: false, failureOutput: integrity.reason, failedStep: 'integrity' };
        } else {
            verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, worktreePath);
        }

        if (!verifResult.success) {
            const autoFixRes = await attemptAutoFix(fix, verifResult.failedStep, verifResult.failureOutput, changes, worktreePath, originalContents);
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
        const changes = getProposalChanges(fix);
        const originalContents = new Map<string, string>();

        for (const change of changes) {
            const absolutePath = path.resolve(workDir, change.filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            const orig = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
            originalContents.set(change.filePath, orig);
            fs.writeFileSync(absolutePath, change.updatedContent, 'utf-8');
        }

        const diffStat = execSync('git diff --shortstat', { encoding: 'utf-8', cwd: workDir });
        console.log(`Diff summary: ${diffStat.trim()}`);

        const integrity = validateFixIntegrity(originalContents, changes);
        let verifResult: ReturnType<typeof runVerification>;

        if (!integrity.valid) {
            console.warn(`⚠️ Integrity validation failed for '${fix.slug}': ${integrity.reason}`);
            verifResult = { success: false, failureOutput: integrity.reason, failedStep: 'integrity' };
        } else {
            verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
        }

        if (!verifResult.success) {
            const autoFixRes = await attemptAutoFix(fix, verifResult.failedStep, verifResult.failureOutput, changes, workDir, originalContents);
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