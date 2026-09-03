import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    countDiffLines,
    summarizeLineBudget,
    validateLineBudget,
    formatLineBudgetSummary,
} from './linebudget.js';

const lines = (n: number, prefix = 'line') =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';

describe('linebudget module test suite', () => {

    describe('countDiffLines()', () => {
        it('counts nothing for identical content', () => {
            assert.deepEqual(countDiffLines('a\nb\nc\n', 'a\nb\nc\n'), { added: 0, removed: 0 });
        });

        it('ignores a missing trailing newline the way git does', () => {
            assert.deepEqual(countDiffLines('a\nb', 'a\nb\n'), { added: 0, removed: 0 });
        });

        it('counts every line of a new file as added', () => {
            assert.deepEqual(countDiffLines('', 'a\nb\nc\n'), { added: 3, removed: 0 });
        });

        it('counts a modified line as one added and one removed', () => {
            assert.deepEqual(countDiffLines('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
        });

        it('counts pure insertions and deletions separately', () => {
            assert.deepEqual(countDiffLines('a\nc\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
            assert.deepEqual(countDiffLines('a\nb\nc\n', 'a\nc\n'), { added: 0, removed: 1 });
        });

        it('handles CRLF line endings', () => {
            assert.deepEqual(countDiffLines('a\r\nb\r\n', 'a\r\nB\r\n'), { added: 1, removed: 1 });
        });

        it('stays exact on large files where only a small region changes', () => {
            const original = lines(5000);
            const updated = original.replace('line 2500\n', 'line 2500 modified\nline 2500 extra\n');
            assert.deepEqual(countDiffLines(original, updated), { added: 2, removed: 1 });
        });

        it('falls back to an estimate instead of hanging on two large, fully different files', () => {
            const original = lines(6000, 'old');
            const updated = lines(6000, 'new');
            const { added, removed } = countDiffLines(original, updated);
            assert.equal(added, 6000);
            assert.equal(removed, 6000);
        });
    });

    describe('summarizeLineBudget()', () => {
        it('splits production and test diff lines by file path', () => {
            const originals = new Map([
                ['src/service.ts', lines(10)],
                ['src/service.test.ts', ''],
            ]);
            const report = summarizeLineBudget(originals, [
                { filePath: 'src/service.ts', updatedContent: lines(12) },
                { filePath: 'src/service.test.ts', updatedContent: lines(40, 'test') },
            ]);

            assert.equal(report.productionLines, 2);
            assert.equal(report.testLines, 40);
            assert.equal(report.files.find(f => f.filePath === 'src/service.test.ts')?.isTest, true);
            assert.equal(report.files.find(f => f.filePath === 'src/service.ts')?.isTest, false);
        });

        it('treats a change with no recorded original as a new file', () => {
            const report = summarizeLineBudget(new Map(), [
                { filePath: 'internal/new.go', updatedContent: lines(7) },
            ]);
            assert.equal(report.productionLines, 7);
        });
    });

    describe('validateLineBudget()', () => {
        it('accepts a proposal inside both budgets', () => {
            const originals = new Map([['src/a.ts', lines(50)]]);
            const res = validateLineBudget(originals, [
                { filePath: 'src/a.ts', updatedContent: lines(60) },
            ], 100, 200);
            assert.equal(res.valid, true);
            assert.equal(res.reason, '');
        });

        it('accepts a proposal exactly at the budget', () => {
            const res = validateLineBudget(new Map(), [
                { filePath: 'src/a.ts', updatedContent: lines(100) },
            ], 100, 200);
            assert.equal(res.valid, true);
        });

        it('rejects a proposal over the production budget and names the offending files', () => {
            const res = validateLineBudget(new Map(), [
                { filePath: 'src/a.ts', updatedContent: lines(80) },
                { filePath: 'src/b.ts', updatedContent: lines(80) },
            ], 100, 200);
            assert.equal(res.valid, false);
            assert.match(res.reason, /Line Budget Check Failed/);
            assert.match(res.reason, /160 diff lines/);
            assert.match(res.reason, /MAX_LINE_DIFF/);
            assert.match(res.reason, /src\/a\.ts \(\+80\/-0\)/);
        });

        it('does not count test lines against the production budget', () => {
            const res = validateLineBudget(new Map(), [
                { filePath: 'src/a.ts', updatedContent: lines(90) },
                { filePath: 'src/a.test.ts', updatedContent: lines(150, 'test') },
            ], 100, 200);
            assert.equal(res.valid, true);
        });

        it('rejects a proposal over the test budget on its own', () => {
            const res = validateLineBudget(new Map(), [
                { filePath: 'internal/store/store_test.go', updatedContent: lines(250, 'test') },
            ], 100, 200);
            assert.equal(res.valid, false);
            assert.match(res.reason, /MAX_TEST_LINE_DIFF/);
            assert.doesNotMatch(res.reason, /MAX_LINE_DIFF\b/);
        });

        it('reports both violations when a proposal blows through both budgets', () => {
            const res = validateLineBudget(new Map(), [
                { filePath: 'src/a.ts', updatedContent: lines(300) },
                { filePath: 'src/a.test.ts', updatedContent: lines(300, 'test') },
            ], 100, 200);
            assert.equal(res.valid, false);
            assert.match(res.reason, /MAX_LINE_DIFF/);
            assert.match(res.reason, /MAX_TEST_LINE_DIFF/);
        });

        it('counts deletions, not just additions, against the budget', () => {
            const originals = new Map([['src/a.ts', lines(300)]]);
            const res = validateLineBudget(originals, [
                { filePath: 'src/a.ts', updatedContent: lines(250) },
            ], 20, 200);
            assert.equal(res.valid, false);
            assert.match(res.reason, /50 diff lines/);
        });
    });

    describe('formatLineBudgetSummary()', () => {
        it('reports usage against both budgets', () => {
            const summary = formatLineBudgetSummary(new Map(), [
                { filePath: 'src/a.ts', updatedContent: lines(5) },
                { filePath: 'src/a.test.ts', updatedContent: lines(9, 'test') },
            ], 100, 200);
            assert.equal(summary, 'production 5/100 diff lines, tests 9/200 diff lines');
        });
    });
});
