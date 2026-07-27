import { execSync, execFileSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import { STATE_FILE, JanitorState, FixProposal } from './config.js';

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

export function getUncachedBaseCommit(currentHead: string, cwd?: string): string {
    if (!currentHead) return '';
    const execCwd = cwd || process.cwd();

    let count24h = 0;
    try {
        const revList24h = execSync('git rev-list --since="24 hours ago" HEAD', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: execCwd,
        }).trim();
        if (revList24h) {
            count24h = revList24h.split('\n').filter(Boolean).length;
        }
    } catch {
        count24h = 0;
    }

    const targetCount = Math.max(count24h, 10);
    console.log(`⏳ Uncached run: last 24h has ${count24h} commit(s). Looking back ${targetCount} commit(s) (24h vs 10 commits max).`);

    try {
        return execSync(`git rev-parse HEAD~${targetCount}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: execCwd,
        }).trim();
    } catch {
        try {
            const allCommits = execSync('git rev-list HEAD', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: execCwd,
            }).trim().split('\n').filter(Boolean);

            if (allCommits.length > 1) {
                const rootCommit = allCommits[allCommits.length - 1];
                console.log(`📍 Repo has ${allCommits.length} total commits (< ${targetCount}). Using root commit: ${rootCommit.slice(0, 7)}`);
                return rootCommit;
            } else if (allCommits.length === 1) {
                return allCommits[0];
            }
        } catch {}
        return currentHead;
    }
}

export function getGitDiff(pathSpecArgs: string, stateFilePath: string = STATE_FILE, cwd?: string): { diff: string; currentHead: string; baseCommit: string } {
    const execCwd = cwd || process.cwd();
    let currentHead = '';
    try {
        currentHead = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: execCwd }).trim();
    } catch {
        currentHead = '';
    }

    let baseCommit = '';

    if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
            const raw = fs.readFileSync(stateFilePath, 'utf-8');
            const state: JanitorState = JSON.parse(raw);
            if (state.lastAnalyzedCommit) {
                execSync(`git cat-file -e ${state.lastAnalyzedCommit}`, { stdio: 'ignore', cwd: execCwd });
                baseCommit = state.lastAnalyzedCommit;
                console.log(`📍 Found previous cursor at commit: ${baseCommit.slice(0, 7)}`);
            }
        } catch {
            console.log("⚠️ Stale or invalid state cursor. Falling back to uncached commit window.");
        }
    }

    if (!baseCommit && currentHead) {
        baseCommit = getUncachedBaseCommit(currentHead, execCwd);
    }

    if (baseCommit && currentHead && baseCommit === currentHead) {
        return { diff: '', currentHead, baseCommit };
    }

    try {
        const diffRange = baseCommit && currentHead ? `${baseCommit}..${currentHead}` : 'HEAD~1 HEAD';
        console.log(`🔍 Calculating diff across window: [${diffRange}]`);
        const diff = execSync(`git diff ${diffRange}${pathSpecArgs}`, { encoding: 'utf-8', cwd: execCwd });
        return { diff, currentHead, baseCommit };
    } catch {
        console.warn("Unable to fetch diff using revision range, reading current workspace diff...");
        try {
            const diff = execSync(`git diff${pathSpecArgs}`, { encoding: 'utf-8', cwd: execCwd });
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
