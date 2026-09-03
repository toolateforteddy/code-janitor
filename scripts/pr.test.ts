import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'node:child_process';
import { FixProposal } from './config.js';
import { createAndSubmitPR } from './pr.js';

describe('pr module test suite', () => {

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
                execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
                const res = createAndSubmitPR(mockFix, 'janitor/dummy-branch', tempDir);
                assert.equal(res, false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('does not mistake unstaged working-tree dirt for something to commit', () => {
            // Regression: the staged-changes check used to run `git status --porcelain`
            // over the whole working tree, so an untracked leftover file (e.g. from a
            // test run) would look like "something to commit" even with an empty index,
            // and `git commit` would then fail with a confusing "nothing to commit" error.
            const mockFix: FixProposal = {
                filePath: 'dummy.txt',
                slug: 'dummy-fix',
                title: 'Dummy Fix: with multi word message',
                description: 'A dummy fix description',
                changes: []
            };
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-dirty-tree-'));
            try {
                execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
                fs.writeFileSync(path.join(tempDir, 'leftover-build-artifact.log'), 'not part of the proposal');
                const res = createAndSubmitPR(mockFix, 'janitor/dummy-branch', tempDir);
                assert.equal(res, false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('uses resolvedChanges (post-remap/post-auto-fix paths) instead of re-deriving from the original fix proposal', () => {
            // Regression: createAndSubmitPR used to always call getProposalChanges(fix),
            // which still carries the model's ORIGINAL proposed path even after
            // processFixWorktree/processFixSequential remapped it to the real on-disk
            // path (or attemptAutoFix rewrote the file list entirely). Without `-A` to
            // paper over the mismatch, that file would silently never get staged.
            const mockFix: FixProposal = {
                filePath: 'wrong-original-path.txt',
                slug: 'dummy-fix',
                title: 'Dummy Fix: remapped path',
                description: 'A dummy fix description',
                changes: []
            };
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-resolved-'));
            try {
                execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
                fs.writeFileSync(path.join(tempDir, 'actual-remapped-path.txt'), 'the real content');

                assert.throws(() => {
                    createAndSubmitPR(mockFix, 'janitor/dummy-branch', tempDir, 'refactor', [
                        { filePath: 'actual-remapped-path.txt', updatedContent: 'the real content' },
                    ]);
                }, /Failed to push branch/);

                // Push fails (no remote), but the commit itself must have succeeded and
                // must contain the resolved path, not the original wrong one.
                const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD'], { cwd: tempDir, encoding: 'utf-8' }).trim();
                assert.equal(committedFiles, 'actual-remapped-path.txt');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

});
