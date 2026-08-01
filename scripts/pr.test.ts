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
    });

});
