import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JanitorState } from './config.js';
import {
    runCmd,
    runVerification,
    getDefaultBranch,
    buildPathSpecArgs,
    getGitDiff,
    getUncachedBaseCommit,
    updateCursor,
    cleanupWorktree,
} from './git.js';

describe('git module test suite', () => {

    describe('buildPathSpecArgs()', () => {
        it('returns empty string when target is dot and no excludes', () => {
            const result = buildPathSpecArgs('.', '');
            assert.equal(result, '');
        });

        it('formats target path correctly when non-root', () => {
            const result = buildPathSpecArgs('src', '');
            assert.equal(result, ' -- "src"');
        });

        it('formats workflow exclude path correctly', () => {
            const result = buildPathSpecArgs('.', '.github/workflows/**');
            assert.equal(result, ' ":(exclude).github/workflows/**"');
        });

        it('formats multiple comma-separated exclude paths correctly', () => {
            const result = buildPathSpecArgs('.', '.github/workflows/**, vendor/**, dist/**, generated/**');
            assert.equal(result, ' ":(exclude).github/workflows/**" ":(exclude)vendor/**" ":(exclude)dist/**" ":(exclude)generated/**"');
        });

        it('combines target path and exclude paths with extra whitespace trimmed', () => {
            const result = buildPathSpecArgs('pkg/sub', ' vendor/** , build/* ');
            assert.equal(result, ' -- "pkg/sub" ":(exclude)vendor/**" ":(exclude)build/*"');
        });
    });

    describe('runCmd()', () => {
        it('executes a successful shell command and returns output', () => {
            const res = runCmd('node -v', 'test-node-version');
            assert.equal(res.success, true);
            assert.match(res.output, /^v\d+/);
        });

        it('captures failure when a command exits non-zero', () => {
            const res = runCmd('node -e "process.exit(1)"', 'test-failure');
            assert.equal(res.success, false);
            assert.ok(res.output.length > 0);
        });

        it('handles command execution timeouts', () => {
            const start = Date.now();
            const res = runCmd('node -e "setTimeout(() => {}, 10000)"', 'test-timeout', 200);
            const elapsed = Date.now() - start;
            assert.equal(res.success, false);
            assert.match(res.output, /timed out/i);
            assert.ok(elapsed < 5000, `Execution should have timed out early, took ${elapsed}ms`);
        });

        it('executes command in specified custom working directory', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-cwd-'));
            try {
                const res = runCmd('node -e "console.log(process.cwd())"', 'test-cwd', undefined, tempDir);
                assert.equal(res.success, true);
                assert.equal(path.resolve(res.output.trim()), path.resolve(tempDir));
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('runVerification()', () => {
        it('returns success when both lint and test commands pass', () => {
            const res = runVerification('node -v', 'node -v');
            assert.equal(res.success, true);
            assert.equal(res.failedStep, '');
            assert.equal(res.failureOutput, '');
        });

        it('stops early and returns lint failure when lint command fails', () => {
            const res = runVerification('node -e "process.exit(1)"', 'node -v');
            assert.equal(res.success, false);
            assert.equal(res.failedStep, 'lint');
            assert.ok(res.failureOutput.length > 0);
        });

        it('returns test failure when lint passes but test command fails', () => {
            const res = runVerification('node -v', 'node -e "process.exit(1)"');
            assert.equal(res.success, false);
            assert.equal(res.failedStep, 'test');
            assert.ok(res.failureOutput.length > 0);
        });

        it('skips lint step when lint command is empty', () => {
            const res = runVerification('', 'node -v');
            assert.equal(res.success, true);
            assert.equal(res.failedStep, '');
        });
    });

    describe('getDefaultBranch()', () => {
        it('returns a non-empty branch string', () => {
            const branch = getDefaultBranch();
            assert.equal(typeof branch, 'string');
            assert.ok(branch.length > 0);
        });
    });

    describe('getUncachedBaseCommit()', () => {
        it('returns empty string when currentHead is empty', () => {
            const res = getUncachedBaseCommit('');
            assert.equal(res, '');
        });

        it('returns a valid commit hash for uncached repository HEAD', () => {
            const headRes = getGitDiff('');
            if (headRes.currentHead) {
                const base = getUncachedBaseCommit(headRes.currentHead);
                assert.ok(base);
                assert.equal(typeof base, 'string');
                assert.ok(base.length >= 7);
            }
        });
    });

    describe('updateCursor() and getGitDiff() cursor state handling', () => {
        it('writes cursor state to specified state file path', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const testHash = 'a1b2c3d4e5f67890123456789012345678901234';
                updateCursor(testHash, tempFile);
                assert.equal(fs.existsSync(tempFile), true);

                const data: JanitorState = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
                assert.equal(data.lastAnalyzedCommit, testHash);
                assert.ok(data.lastRunTimestamp);
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });

        it('returns empty diff when cursor matches current HEAD', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const headRes = getGitDiff('', tempFile);
                if (headRes.currentHead) {
                    updateCursor(headRes.currentHead, tempFile);
                    const sameRes = getGitDiff('', tempFile);
                    assert.equal(sameRes.diff, '');
                    assert.equal(sameRes.baseCommit, headRes.currentHead);
                }
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });

        it('falls back gracefully if state file contains invalid/stale commit', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const fakeState = { lastAnalyzedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', lastRunTimestamp: new Date().toISOString() };
                fs.writeFileSync(tempFile, JSON.stringify(fakeState), 'utf-8');

                const diffRes = getGitDiff('', tempFile);
                assert.notEqual(diffRes.baseCommit, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
                assert.ok(diffRes.baseCommit);
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });

        it('uses uncached base commit determination when state file does not exist', () => {
            const nonExistentState = path.join(os.tmpdir(), `non-existent-janitor-state-${Date.now()}.json`);
            const diffRes = getGitDiff('', nonExistentState);
            assert.ok(diffRes.baseCommit);
            assert.equal(typeof diffRes.baseCommit, 'string');
        });
    });

    describe('cleanupWorktree()', () => {
        it('removes directory safely if it exists', () => {
            const tempWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-worktree-test-'));
            assert.equal(fs.existsSync(tempWorktree), true);

            cleanupWorktree(tempWorktree);

            assert.equal(fs.existsSync(tempWorktree), false);
        });

        it('does not throw when attempting to clean up a non-existent path', () => {
            const fakePath = path.join(os.tmpdir(), `non-existent-worktree-${Date.now()}`);
            assert.doesNotThrow(() => {
                cleanupWorktree(fakePath);
            });
        });
    });

});
