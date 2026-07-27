import { execSync, execFileSync, ExecFileSyncOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
    isDraft,
    reviewers,
    maxConcurrency,
    lintCmd,
    testCmd,
    testTimeoutMs,
    FileChange,
    FixProposal,
    getProposalChanges,
} from './config.js';
import { runVerification, logFailedDiff, cleanupWorktree } from './git.js';
import { validateFixIntegrity } from './integrity.js';
import { attemptAutoFix } from './ai.js';

export function createAndSubmitPR(fix: FixProposal, branchName: string, workDir: string, modeType: 'repair' | 'refactor' = 'refactor') {
    const execOpts: ExecFileSyncOptions = { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] };
    const emoji = modeType === 'repair' ? '🚨' : '🧹';
    const prPrefix = modeType === 'repair' ? 'fix' : 'refactor';

    const changes = getProposalChanges(fix);

    try {
        execFileSync('git', ['config', 'user.name', 'Code Janitor Bot'], execOpts);
        execFileSync('git', ['config', 'user.email', 'bot@codejanitor.local'], execOpts);
        for (const change of changes) {
            if (change.filePath) {
                execFileSync('git', ['add', change.filePath.trim()], execOpts);
            }
        }
        execFileSync('git', ['add', '-A'], execOpts);

        const status = execFileSync('git', ['status', '--porcelain'], { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
        if (!status.trim()) {
            const targetFile = fix.filePath || (changes.length > 0 ? changes.map(c => c.filePath).join(', ') : fix.slug);
            throw new Error(`No staged changes found in worktree for file: ${targetFile}`);
        }

        const commitMessage = `${prPrefix}: ${fix.title}`;
        execFileSync('git', ['commit', '-m', commitMessage], execOpts);
    } catch (err) {
        console.error(`❌ Failed to commit changes for branch '${branchName}':`, err);
        throw new Error(`Failed to commit changes for branch '${branchName}': ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`Creating PR for: ${fix.title}...`);

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
