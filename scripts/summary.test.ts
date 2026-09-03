import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createRunSummary,
    setSummary,
    getSummary,
    recordFixResult,
    recordNote,
    renderSummary,
    writeJobSummary,
    formatDuration,
    escapeCell,
} from './summary.js';
import { extractPrUrl } from './pr.js';

describe('summary module test suite', () => {

    beforeEach(() => {
        setSummary(createRunSummary('google', 'gemini-3.6-flash', 'auto', 0));
    });

    describe('formatDuration()', () => {
        it('renders seconds and minutes, and clamps nonsense input', () => {
            assert.equal(formatDuration(0), '0s');
            assert.equal(formatDuration(4200), '4s');
            assert.equal(formatDuration(65_000), '1m 5s');
            assert.equal(formatDuration(-1), '0s');
            assert.equal(formatDuration(NaN), '0s');
        });
    });

    describe('escapeCell()', () => {
        it('neutralizes pipes and newlines so table rows stay intact', () => {
            assert.equal(escapeCell('a | b'), 'a \\| b');
            assert.equal(escapeCell(' first\nsecond \r\nthird '), 'first second third');
        });
    });

    describe('renderSummary()', () => {
        it('reports run metadata and per-fix outcomes', () => {
            const s = getSummary();
            s.sweep = 'refactor';
            s.branchHealth = 'green';
            s.proposed = 2;
            s.duplicatesSkipped = 1;
            s.existingJanitorPRs = 4;
            recordFixResult({ slug: 'a', title: 'Simplify parser', modeType: 'refactor', outcome: 'pr-created', prUrl: 'https://github.com/o/r/pull/12' });
            recordFixResult({ slug: 'b', title: 'Add edge case tests', modeType: 'refactor', outcome: 'verification-failed', detail: 'Failed at test' });

            const md = renderSummary(s, 65_000);

            assert.match(md, /^## 🧹 Code Janitor/);
            assert.match(md, /\| Sweep \| 🧹 Refactor \|/);
            assert.match(md, /\| Main branch health \| ✅ Green \|/);
            assert.match(md, /\| Proposals \| 2 \|/);
            assert.match(md, /\| Skipped as duplicates \| 1 \|/);
            assert.match(md, /\| Existing janitor PRs \| 4 \|/);
            assert.match(md, /\| PRs opened \| 1 \|/);
            assert.match(md, /\| Duration \| 1m 5s \|/);
            assert.match(md, /\[Simplify parser\]\(https:\/\/github\.com\/o\/r\/pull\/12\)/);
            assert.match(md, /❌ Verification failed \| Add edge case tests \| Failed at test \|/);
        });

        it('omits optional sections when there is nothing to report', () => {
            const md = renderSummary(getSummary(), 0);
            assert.doesNotMatch(md, /Proposed fixes/);
            assert.doesNotMatch(md, /### Notes/);
            assert.doesNotMatch(md, /Skipped as duplicates/);
            assert.doesNotMatch(md, /Existing janitor PRs/);
            assert.match(md, /\| Main branch health \| ❔ Not checked \|/);
            assert.match(md, /\| Sweep \| — None \|/);
        });

        it('renders notes and titles without breaking the table', () => {
            recordNote('Main branch failing at test.');
            recordFixResult({ slug: 'c', title: 'Fix a | b split', modeType: 'repair', outcome: 'error', detail: 'boom\nstack' });
            const md = renderSummary(getSummary(), 0);
            assert.match(md, /- Main branch failing at test\./);
            assert.match(md, /💥 Error \| Fix a \\\| b split \| boom stack \|/);
            // Every row of the fixes table must have exactly three cells; an unescaped pipe
            // or a newline in a title would silently add or split one.
            const fixRows = md.split('### Proposed fixes')[1].split('\n').filter(l => l.startsWith('| '));
            for (const line of fixRows) {
                assert.equal(line.split(/(?<!\\)\|/).length, 5, `unexpected column count in: ${line}`);
            }
        });

        it('shows an empty detail cell as a dash', () => {
            recordFixResult({ slug: 'd', title: 'No detail', modeType: 'refactor', outcome: 'no-changes' });
            assert.match(renderSummary(getSummary(), 0), /⚠️ No changes produced \| No detail \| — \|/);
        });
    });

    describe('writeJobSummary()', () => {
        const originalEnv = process.env.GITHUB_STEP_SUMMARY;
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-summary-'));
        });

        afterEach(() => {
            if (originalEnv === undefined) delete process.env.GITHUB_STEP_SUMMARY;
            else process.env.GITHUB_STEP_SUMMARY = originalEnv;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('appends the rendered summary to $GITHUB_STEP_SUMMARY', () => {
            const target = path.join(tmpDir, 'step-summary.md');
            fs.writeFileSync(target, '# existing\n', 'utf-8');
            process.env.GITHUB_STEP_SUMMARY = target;

            assert.equal(writeJobSummary(getSummary(), 0), true);

            const written = fs.readFileSync(target, 'utf-8');
            assert.match(written, /^# existing\n/);
            assert.match(written, /## 🧹 Code Janitor/);
            assert.match(written, /\n$/);
        });

        it('is a no-op outside GitHub Actions', () => {
            delete process.env.GITHUB_STEP_SUMMARY;
            assert.equal(writeJobSummary(getSummary(), 0), false);
        });

        it('never throws when the summary file is unwritable', () => {
            process.env.GITHUB_STEP_SUMMARY = path.join(tmpDir, 'missing-dir', 'summary.md');
            assert.equal(writeJobSummary(getSummary(), 0), false);
        });
    });

    describe('extractPrUrl()', () => {
        it('pulls the PR URL out of gh output surrounded by noise', () => {
            assert.equal(
                extractPrUrl('Warning: 3 uncommitted changes\nhttps://github.com/owner/repo/pull/42\n'),
                'https://github.com/owner/repo/pull/42',
            );
            assert.equal(extractPrUrl('https://ghe.example.com/o/r/pull/7'), 'https://ghe.example.com/o/r/pull/7');
            assert.equal(extractPrUrl('no url here'), undefined);
        });
    });
});
