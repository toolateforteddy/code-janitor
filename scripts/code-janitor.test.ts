import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
    getModel,
    STATE_FILE,
    JanitorState,
    FixProposal,
    getProposalChanges,
} from './config.js';
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
import {
    extractTopLevelDeclarations,
    validateFixIntegrity,
} from './integrity.js';
import {
    generateRepairProposals,
} from './ai.js';
import {
    createAndSubmitPR,
} from './pr.js';
import {
    isDirectExecution,
} from './code-janitor.js';


describe('code-janitor engine test suite', () => {

    describe('getModel()', () => {
        it('returns a model object for google provider', () => {
            const model = getModel('google', 'gemini-3.6-flash');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });

        it('returns a model object for anthropic provider', () => {
            const model = getModel('anthropic', 'claude-3-5-sonnet-20241022');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });

        it('returns a model object for openai provider', () => {
            const model = getModel('openai', 'gpt-4o');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });

        it('defaults to google model for unknown provider', () => {
            const model = getModel('unknown', 'custom-model');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });
    });

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

    describe('isDirectExecution()', () => {
        it('returns false when code-janitor is imported from test runner', () => {
            const direct = isDirectExecution();
            assert.equal(direct, false);
        });
    });

    describe('generateRepairProposals()', () => {
        it('is defined as an async function', () => {
            assert.equal(typeof generateRepairProposals, 'function');
        });
    });

    describe('createAndSubmitPR() and push failure error propagation', () => {
        it('throws an error when git push fails in non-git directory', () => {
            const mockFix: FixProposal = {
                filePath: 'dummy.txt',
                slug: 'dummy-fix',
                title: 'Dummy Fix',
                description: 'A dummy fix description',
                updatedContent: 'hello world'
            };
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-pushfail-'));
            try {
                assert.throws(() => {
                    createAndSubmitPR(mockFix, 'janitor/dummy-branch', tempDir);
                });
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('returns false when no changes are staged to commit', () => {
            const mockFix: FixProposal = {
                filePath: 'dummy.txt',
                slug: 'dummy-fix',
                title: 'Dummy Fix: with multi word message',
                description: 'A dummy fix description',
                changes: []
            };
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-nostaged-'));
            try {
                const { execFileSync } = require('child_process');
                execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
                const res = createAndSubmitPR(mockFix, 'janitor/dummy-branch', tempDir);
                assert.equal(res, false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('extractTopLevelDeclarations() & validateFixIntegrity()', () => {
        it('extracts top-level declarations across languages', () => {
            const ktCode = `
package fyi.teddy.grocery
@Composable
fun NeedPhaseContent() { }
@OptIn
fun NeedItemTile() { }
`;
            const decls = extractTopLevelDeclarations(ktCode, '.kt');
            assert.deepEqual(decls, ['NeedPhaseContent', 'NeedItemTile']);
        });

        it('detects when top-level functions are omitted in refactored code', () => {
            const original = `
@Composable
fun NeedPhaseContent() {
    // 50 lines of layout
}
@Composable
fun NeedItemTile() { }
`;
            const brokenUpdated = `
@Composable
fun NeedItemTile() {
    // refactored swipe
}
`;
            const res = validateFixIntegrity(original, brokenUpdated, 'NeedPhaseContent.kt');
            assert.equal(res.valid, false);
            assert.match(res.reason, /NeedPhaseContent/);
        });

        it('passes integrity check when all declarations are preserved', () => {
            const original = `
fun TopA() {}
fun TopB() {}
`;
            const validUpdated = `
fun TopA() { /* modified */ }
fun TopB() { /* modified */ }
`;
            const res = validateFixIntegrity(original, validUpdated, 'File.kt');
            assert.equal(res.valid, true);
        });

        it('allows brand new files', () => {
            const res = validateFixIntegrity('', 'fun NewFun() {}', 'NewFile.kt');
            assert.equal(res.valid, true);
        });

        it('rejects test framework imports added to production source files', () => {
            const original = `package com.example\nfun mainApp() {}\n`;
            const updatedWithJUnit = `package com.example\nimport org.junit.Test\nfun mainApp() {}\nclass AppTest { @Test fun t() {} }`;
            const res = validateFixIntegrity(original, updatedWithJUnit, 'src/main/java/com/example/App.kt');
            assert.equal(res.valid, false);
            assert.match(res.reason, /test framework imports/i);
        });

        it('validates multi-file changes correctly via Map and Array', () => {
            const origMap = new Map<string, string>([
                ['src/main/java/App.kt', 'fun mainApp() {}\n'],
                ['src/test/java/AppTest.kt', '']
            ]);
            const changes = [
                { filePath: 'src/main/java/App.kt', updatedContent: 'fun mainApp() { println("hello") }\n' },
                { filePath: 'src/test/java/AppTest.kt', updatedContent: 'import org.junit.Test\nclass AppTest { @Test fun t() {} }\n' }
            ];
            const res = validateFixIntegrity(origMap, changes);
            assert.equal(res.valid, true);
        });
    });

    describe('getProposalChanges()', () => {
        it('returns changes array when present', () => {
            const fix: FixProposal = {
                slug: 'test-slug',
                title: 'Test PR',
                description: 'Description',
                changes: [
                    { filePath: 'src/main.rs', updatedContent: 'fn main() {}' },
                    { filePath: 'tests/main_test.rs', updatedContent: '#[test] fn test() {}' }
                ]
            };
            const changes = getProposalChanges(fix);
            assert.equal(changes.length, 2);
            assert.equal(changes[0].filePath, 'src/main.rs');
            assert.equal(changes[1].filePath, 'tests/main_test.rs');
        });

        it('falls back to single filePath and updatedContent for legacy proposals', () => {
            const fix: FixProposal = {
                slug: 'legacy-slug',
                title: 'Legacy PR',
                description: 'Legacy description',
                filePath: 'src/lib.rs',
                updatedContent: 'pub fn lib() {}'
            };
            const changes = getProposalChanges(fix);
            assert.equal(changes.length, 1);
            assert.equal(changes[0].filePath, 'src/lib.rs');
            assert.equal(changes[0].updatedContent, 'pub fn lib() {}');
        });
    });

});

