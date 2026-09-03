import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FixProposal } from './config.js';
import {
    extractSlugFromBranch,
    normalizeSlug,
    normalizeTitle,
    findDuplicatePR,
    filterDuplicateProposals,
    describeExistingJanitorPRs,
    fetchExistingJanitorPRs,
    ExistingJanitorPR,
} from './dedupe.js';

function pr(overrides: Partial<ExistingJanitorPR> = {}): ExistingJanitorPR {
    return {
        number: 42,
        title: '🚨 Fix nil deref in parser',
        headRefName: 'janitor/fix-nil-deref-1717171717171',
        slug: 'fix-nil-deref',
        files: ['src/parser.go'],
        state: 'open',
        ...overrides,
    };
}

function proposal(overrides: Partial<FixProposal> = {}): FixProposal {
    return {
        slug: 'fix-nil-deref',
        title: 'Fix nil deref in parser',
        description: 'Guard the nil case',
        changes: [{ filePath: 'src/parser.go', updatedContent: 'package main\n' }],
        ...overrides,
    };
}

describe('dedupe module test suite', () => {

    describe('extractSlugFromBranch()', () => {
        it('strips the janitor prefix and the epoch-millis suffix', () => {
            assert.equal(extractSlugFromBranch('janitor/fix-nil-deref-1717171717171'), 'fix-nil-deref');
        });

        it('leaves short numeric suffixes that are part of the slug alone', () => {
            // A real slug may legitimately end in a small number (e.g. "fix-http2"),
            // so only a 10+ digit timestamp is treated as the minted suffix.
            assert.equal(extractSlugFromBranch('janitor/fix-http2-1717171717171'), 'fix-http2');
            assert.equal(extractSlugFromBranch('janitor/fix-error-500'), 'fix-error-500');
        });

        it('handles branches without the janitor prefix and empty input', () => {
            assert.equal(extractSlugFromBranch('feature/some-branch'), 'feature/some-branch');
            assert.equal(extractSlugFromBranch(''), '');
        });
    });

    describe('normalizeSlug() and normalizeTitle()', () => {
        it('normalizes case and separators in slugs', () => {
            assert.equal(normalizeSlug('Fix_Nil--Deref'), 'fix-nil-deref');
            assert.equal(normalizeSlug('fix-nil-deref'), 'fix-nil-deref');
        });

        it('strips emoji and conventional-commit prefixes from titles', () => {
            assert.equal(normalizeTitle('🚨 Fix nil deref in parser'), 'nil deref in parser');
            assert.equal(normalizeTitle('fix: nil deref in parser'), 'nil deref in parser');
            assert.equal(normalizeTitle('🧹 Refactor duplicated retry loop'), 'duplicated retry loop');
        });
    });

    describe('findDuplicatePR()', () => {
        it('matches an existing PR by slug', () => {
            const found = findDuplicatePR(proposal({ title: 'A completely different title' }), [pr()], 'repair');
            assert.equal(found?.number, 42);
        });

        it('matches an existing PR by normalized title even when the slug differs', () => {
            const found = findDuplicatePR(proposal({ slug: 'repair-parser-crash' }), [pr()], 'repair');
            assert.equal(found?.number, 42);
        });

        it('matches by identical file set in repair mode', () => {
            const found = findDuplicatePR(
                proposal({ slug: 'another-slug', title: 'Another title entirely' }),
                [pr()],
                'repair'
            );
            assert.equal(found?.number, 42);
        });

        it('does NOT match by file set in refactor mode', () => {
            // Two refactors touching the same file are routinely different improvements,
            // so the file-set signal is deliberately limited to repair sweeps.
            const found = findDuplicatePR(
                proposal({ slug: 'another-slug', title: 'Another title entirely' }),
                [pr()],
                'refactor'
            );
            assert.equal(found, null);
        });

        it('returns null when nothing matches', () => {
            const found = findDuplicatePR(
                proposal({ slug: 'unrelated', title: 'Unrelated work', changes: [{ filePath: 'src/other.go', updatedContent: 'x\n' }] }),
                [pr()],
                'repair'
            );
            assert.equal(found, null);
        });

        it('returns null against an empty PR list', () => {
            assert.equal(findDuplicatePR(proposal(), [], 'repair'), null);
        });

        it('ignores empty file sets so two path-less proposals do not collide', () => {
            const emptyFilesPR = pr({ slug: 'x', title: 'x', files: [] });
            const noChangeProposal = proposal({ slug: 'y', title: 'y', changes: undefined });
            assert.equal(findDuplicatePR(noChangeProposal, [emptyFilesPR], 'repair'), null);
        });
    });

    describe('filterDuplicateProposals()', () => {
        it('drops proposals already covered by an open janitor PR', () => {
            const kept = filterDuplicateProposals([proposal()], [pr()], 'repair');
            assert.equal(kept.length, 0);
        });

        it('drops proposals a human already closed without merging', () => {
            const kept = filterDuplicateProposals([proposal()], [pr({ state: 'closed' })], 'repair');
            assert.equal(kept.length, 0);
        });

        it('keeps genuinely new proposals', () => {
            const fresh = proposal({
                slug: 'fix-timeout',
                title: 'Fix flaky timeout',
                changes: [{ filePath: 'src/client.go', updatedContent: 'package main\n' }],
            });
            const kept = filterDuplicateProposals([fresh], [pr()], 'repair');
            assert.deepEqual(kept.map(f => f.slug), ['fix-timeout']);
        });

        it('collapses duplicates within the same batch', () => {
            const first = proposal({ slug: 'fix-a', title: 'Fix A' });
            const second = proposal({ slug: 'fix-a', title: 'Fix A restated' });
            const kept = filterDuplicateProposals([first, second], [], 'repair');
            assert.equal(kept.length, 1);
            assert.equal(kept[0].title, 'Fix A');
        });

        it('is a no-op when there are no existing PRs', () => {
            const fixes = [proposal({ slug: 'a', title: 'A' }), proposal({ slug: 'b', title: 'B', changes: [{ filePath: 'b.go', updatedContent: 'x\n' }] })];
            assert.equal(filterDuplicateProposals(fixes, [], 'refactor').length, 2);
        });
    });

    describe('describeExistingJanitorPRs()', () => {
        it('returns an empty string with no PRs', () => {
            assert.equal(describeExistingJanitorPRs([]), '');
        });

        it('labels open and closed PRs distinctly and includes touched files', () => {
            const text = describeExistingJanitorPRs([pr(), pr({ number: 43, state: 'closed' })]);
            assert.match(text, /#42: 🚨 Fix nil deref in parser \(still open, awaiting review\)/);
            assert.match(text, /#43: .*\(closed without merging \(rejected\)\)/);
            assert.match(text, /src\/parser\.go/);
        });

        it('caps the number of rendered entries', () => {
            const many = Array.from({ length: 50 }, (_, i) => pr({ number: i }));
            assert.equal(describeExistingJanitorPRs(many, 5).split('\n').length, 5);
        });
    });

    describe('fetchExistingJanitorPRs()', () => {
        it('fails open (returns an empty list) when gh cannot list PRs', () => {
            // Non-repo working directory: `gh pr list` errors out. Deduplication must
            // degrade to a no-op rather than aborting the sweep.
            const result = fetchExistingJanitorPRs(process.env.TMPDIR || '/tmp');
            assert.ok(Array.isArray(result));
        });
    });

});
