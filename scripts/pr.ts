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
import { prepareWorktreeDependencies } from './deps.js';
import { validateFixIntegrity } from './integrity.js';
import { attemptAutoFix, findFileInWorkspaceByBasename, sanitizeRelativePath } from './ai.js';

export function createAndSubmitPR(fix: FixProposal, branchName: string, workDir: string, modeType: 'repair' | 'refactor' = 'refactor', resolvedChanges?: FileChange[]): boolean {
    const execOpts: ExecFileSyncOptions = { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] };
    const emoji = modeType === 'repair' ? '🚨' : '🧹';
    const prPrefix = modeType === 'repair' ? 'fix' : 'refactor';

    // Prefer the caller's already-resolved changes (correct post-remap/post-auto-fix file
    // paths) over re-deriving from `fix`, which still carries the model's original proposed
    // paths -- those can differ from what actually ended up on disk.
    const changes = resolvedChanges ?? getProposalChanges(fix);

    try {
        execFileSync('git', ['config', 'user.name', 'Code Janitor Bot'], execOpts);
        execFileSync('git', ['config', 'user.email', 'bot@codejanitor.local'], execOpts);
        for (const change of changes) {
            if (change.filePath) {
                const cleanPath = sanitizeRelativePath(workDir, change.filePath);
                if (cleanPath && fs.existsSync(path.resolve(workDir, cleanPath))) {
                    execFileSync('git', ['add', cleanPath], execOpts);
                }
            }
        }

        // Stage only the files the proposal (and any auto-fix retry) actually touched --
        // NOT `git add -A`, which would also sweep in whatever the test/lint run left
        // behind (build artifacts, caches, a stray .janitor-state.json) into the PR.
        // Check the INDEX specifically (not full working-tree status): unstaged/untracked
        // dirt left over from a test run would otherwise look like "something to commit"
        // and send us into `git commit` with nothing actually staged.
        const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
        if (!stagedFiles.trim()) {
            const targetFile = fix.filePath || (changes.length > 0 ? changes.map(c => c.filePath).join(', ') : fix.slug);
            console.warn(`⚠️ No staged changes found in worktree for fix '${fix.slug}' (${targetFile}). Skipping PR creation.`);
            return false;
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
        return true;
    } catch (err) {
        console.error(`❌ Failed to create pull request via GitHub CLI:`, err);
        throw new Error(`Failed to create pull request via GitHub CLI: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export async function processFixWorktree(fix: FixProposal, defaultBranch: string, modeType: 'repair' | 'refactor' = 'refactor'): Promise<boolean> {
    const timestamp = Date.now();
    const branchName = `janitor/${fix.slug}-${timestamp}`;
    const mainWorkspace = process.cwd();
    const worktreePath = path.resolve(mainWorkspace, `.janitor-worktree-${fix.slug}-${timestamp}`);

    try {
        console.log(`\n--- Processing Fix (Worktree): ${fix.title} ---`);
        execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, defaultBranch]);

        const changes = getProposalChanges(fix);
        const originalContents = new Map<string, string>();

        console.log(`📝 Applying ${changes.length} file change(s) for '${fix.slug}':`);
        for (const change of changes) {
            let cleanPath = sanitizeRelativePath(worktreePath, change.filePath) ?? '';
            if (!cleanPath) {
                throw new Error(`Refusing to write outside workspace: "${change.filePath}"`);
            }
            let absolutePath = path.resolve(worktreePath, cleanPath);

            if (!fs.existsSync(absolutePath)) {
                const baseName = path.basename(cleanPath);
                const existingRelPath = findFileInWorkspaceByBasename(worktreePath, baseName);
                if (existingRelPath && existingRelPath !== cleanPath) {
                    console.log(`   ℹ️ Remapped proposed path '${cleanPath}' to existing canonical path '${existingRelPath}'`);
                    cleanPath = existingRelPath;
                    absolutePath = path.resolve(worktreePath, cleanPath);
                }
            }

            change.filePath = cleanPath;
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            const isNew = !fs.existsSync(absolutePath);
            const orig = isNew ? '' : fs.readFileSync(absolutePath, 'utf-8');
            originalContents.set(cleanPath, orig);
            fs.writeFileSync(absolutePath, change.updatedContent, 'utf-8');
            const isSame = orig === change.updatedContent;
            console.log(`   - ${cleanPath} [${isNew ? 'NEW FILE' : 'MODIFIED'}] (${orig.length}b -> ${change.updatedContent.length}b${isSame ? ' ⚠️ UNCHANGED!' : ''})`);
        }

        const statusPorcelain = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8', cwd: worktreePath }).trim();
        if (!statusPorcelain) {
            console.warn(`⚠️ No file diffs or untracked changes detected for '${fix.slug}'. Skipping...`);
            return false;
        }
        console.log(`Working tree status (${fix.slug}):\n${statusPorcelain.split('\n').map(l => '  ' + l).join('\n')}`);

        // A fresh worktree is a clean checkout: gitignored dependency trees
        // (node_modules, .venv) don't come along, so lint/test would fail with
        // "Cannot find module" no matter how good the proposal is. Do this only
        // after the status check above so linked dep dirs can't be mistaken for
        // proposal changes.
        prepareWorktreeDependencies(mainWorkspace, worktreePath);

        const integrity = validateFixIntegrity(originalContents, changes);
        let verifResult: ReturnType<typeof runVerification>;
        let finalChanges = changes;

        if (!integrity.valid) {
            console.warn(`⚠️ Integrity validation failed for '${fix.slug}': ${integrity.reason}`);
            verifResult = { success: false, failureOutput: integrity.reason, failedStep: 'integrity' };
        } else {
            verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, worktreePath);
        }

        if (!verifResult.success) {
            const autoFixRes = await attemptAutoFix(fix, verifResult.failedStep, verifResult.failureOutput, changes, worktreePath, originalContents);
            verifResult = autoFixRes.verifResult;
            finalChanges = autoFixRes.updatedChanges;

            if (verifResult.success) {
                const postFixIntegrity = validateFixIntegrity(originalContents, autoFixRes.updatedChanges);
                if (!postFixIntegrity.valid) {
                    console.warn(`⚠️ Integrity validation failed after auto-fix for '${fix.slug}': ${postFixIntegrity.reason}`);
                    verifResult = { success: false, failureOutput: postFixIntegrity.reason, failedStep: 'integrity' };
                }
            }
        }

        if (!verifResult.success) {
            console.error(`❌ Verification failed for fix '${fix.slug}'. Cleaning up...`);
            logFailedDiff(fix, worktreePath);
            return false;
        }

        return createAndSubmitPR(fix, branchName, worktreePath, modeType, finalChanges);
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

        console.log(`📝 Applying ${changes.length} file change(s) for '${fix.slug}':`);
        for (const change of changes) {
            const cleanPath = sanitizeRelativePath(workDir, change.filePath);
            if (!cleanPath) {
                throw new Error(`Refusing to write outside workspace: "${change.filePath}"`);
            }
            change.filePath = cleanPath;
            const absolutePath = path.resolve(workDir, cleanPath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            const isNew = !fs.existsSync(absolutePath);
            const orig = isNew ? '' : fs.readFileSync(absolutePath, 'utf-8');
            originalContents.set(cleanPath, orig);
            fs.writeFileSync(absolutePath, change.updatedContent, 'utf-8');
            const isSame = orig === change.updatedContent;
            console.log(`   - ${cleanPath} [${isNew ? 'NEW FILE' : 'MODIFIED'}] (${orig.length}b -> ${change.updatedContent.length}b${isSame ? ' ⚠️ UNCHANGED!' : ''})`);
        }

        const statusPorcelain = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8', cwd: workDir }).trim();
        if (!statusPorcelain) {
            console.warn(`⚠️ No file diffs or untracked changes detected for '${fix.slug}'. Discarding branch...`);
            try {
                execFileSync('git', ['checkout', defaultBranch]);
                execFileSync('git', ['reset', '--hard', defaultBranch]);
            } catch { /* ignore */ }
            return false;
        }
        console.log(`Working tree status (${fix.slug}):\n${statusPorcelain.split('\n').map(l => '  ' + l).join('\n')}`);

        const integrity = validateFixIntegrity(originalContents, changes);
        let verifResult: ReturnType<typeof runVerification>;
        let finalChanges = changes;

        if (!integrity.valid) {
            console.warn(`⚠️ Integrity validation failed for '${fix.slug}': ${integrity.reason}`);
            verifResult = { success: false, failureOutput: integrity.reason, failedStep: 'integrity' };
        } else {
            verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
        }

        if (!verifResult.success) {
            const autoFixRes = await attemptAutoFix(fix, verifResult.failedStep, verifResult.failureOutput, changes, workDir, originalContents);
            verifResult = autoFixRes.verifResult;
            finalChanges = autoFixRes.updatedChanges;

            if (verifResult.success) {
                const postFixIntegrity = validateFixIntegrity(originalContents, autoFixRes.updatedChanges);
                if (!postFixIntegrity.valid) {
                    console.warn(`⚠️ Integrity validation failed after auto-fix for '${fix.slug}': ${postFixIntegrity.reason}`);
                    verifResult = { success: false, failureOutput: postFixIntegrity.reason, failedStep: 'integrity' };
                }
            }
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

        return createAndSubmitPR(fix, branchName, workDir, modeType, finalChanges);
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
