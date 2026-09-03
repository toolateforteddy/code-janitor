import { execFileSync } from 'child_process';
import { FixProposal, getProposalChanges, JANITOR_BRANCH_PREFIX } from './config.js';

/**
 * A previously-opened Code Janitor pull request, used to suppress re-proposing a fix
 * the janitor has already submitted. Nightly runs re-observe the same red main branch
 * until the repair PR is actually merged, so without this the same fix is proposed --
 * and a fresh PR opened -- every single night.
 */
export interface ExistingJanitorPR {
    number: number;
    title: string;
    headRefName: string;
    /** Slug parsed out of the `janitor/<slug>-<timestamp>` branch name. */
    slug: string;
    /** Repo-relative paths the PR touches (empty when `gh` didn't report them). */
    files: string[];
    /** 'open' PRs are still pending; 'closed' ones were rejected by a human without merging. */
    state: 'open' | 'closed';
}

interface GhPullRequest {
    number?: number;
    title?: string;
    headRefName?: string;
    mergedAt?: string | null;
    files?: Array<{ path?: string }>;
}

/**
 * Recovers the proposal slug from a janitor branch name. Branches are minted as
 * `janitor/<slug>-<epoch-millis>` (see processFixWorktree), so the timestamp suffix
 * has to come back off before the slug can be compared against a new proposal.
 */
export function extractSlugFromBranch(branch: string): string {
    if (!branch) return '';
    let slug = branch.trim();
    if (slug.startsWith(JANITOR_BRANCH_PREFIX)) {
        slug = slug.slice(JANITOR_BRANCH_PREFIX.length);
    }
    return slug.replace(/-\d{10,}$/, '').toLowerCase();
}

/** Collapses a slug to a comparable form (case, separators and surrounding noise removed). */
export function normalizeSlug(slug: string): string {
    return (slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Collapses a PR title to a comparable form. Drops the mode emoji and the
 * `fix:`/`refactor:` style prefix so `🚨 Fix nil deref` and `Fix nil deref` match.
 */
export function normalizeTitle(title: string): string {
    return (title || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/^\s*(fix|fixes|repair|refactor|chore)\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeFileSet(files: string[]): string {
    return Array.from(new Set(files.map(f => f.trim().replace(/^\.\//, '').replace(/^\/+/, '')).filter(Boolean)))
        .sort()
        .join('|');
}

/**
 * Lists the janitor's own previously-created pull requests via the GitHub CLI.
 *
 * Both open and closed-but-unmerged PRs are returned: an open one means the fix is
 * already awaiting review, and a closed unmerged one means a human explicitly
 * rejected it. Re-opening either is noise. Merged PRs are deliberately excluded --
 * if a merged fix didn't hold, the janitor should be free to try again.
 *
 * Fails open: if `gh` is missing, unauthenticated, or errors, this returns an empty
 * list so the run proceeds without deduplication rather than aborting the sweep.
 */
export function fetchExistingJanitorPRs(cwd: string = process.cwd(), limit: number = 100): ExistingJanitorPR[] {
    const collected: ExistingJanitorPR[] = [];

    for (const state of ['open', 'closed'] as const) {
        let raw = '';
        try {
            raw = execFileSync('gh', [
                'pr', 'list',
                '--state', state,
                '--limit', String(limit),
                '--json', 'number,title,headRefName,mergedAt,files',
            ], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
            console.warn(`⚠️ Unable to list ${state} pull requests for deduplication (continuing without it):`, err instanceof Error ? err.message : String(err));
            continue;
        }

        let parsed: GhPullRequest[];
        try {
            parsed = JSON.parse(raw || '[]');
        } catch {
            console.warn(`⚠️ Unable to parse '${state}' pull request list JSON for deduplication (continuing without it).`);
            continue;
        }
        if (!Array.isArray(parsed)) continue;

        for (const pr of parsed) {
            const headRefName = pr.headRefName || '';
            if (!headRefName.startsWith(JANITOR_BRANCH_PREFIX)) continue;
            // A merged PR's change already landed; if it didn't hold, re-proposing is legitimate.
            if (state === 'closed' && pr.mergedAt) continue;

            collected.push({
                number: pr.number ?? 0,
                title: pr.title || '',
                headRefName,
                slug: extractSlugFromBranch(headRefName),
                files: Array.isArray(pr.files) ? pr.files.map(f => f?.path || '').filter(Boolean) : [],
                state,
            });
        }
    }

    return collected;
}

/**
 * Returns the existing janitor PR that already covers `fix`, or null.
 *
 * Three signals, in descending confidence:
 *  1. same slug -- the branch the janitor would mint is effectively the same one;
 *  2. same normalized title;
 *  3. (repair mode only) an identical set of touched files. A repair run re-reads the
 *     same failure logs every night and lands on the same files; two refactor proposals
 *     touching one file, by contrast, are routinely genuinely different improvements.
 */
export function findDuplicatePR(
    fix: FixProposal,
    existingPRs: ExistingJanitorPR[],
    modeType: 'repair' | 'refactor' = 'refactor'
): ExistingJanitorPR | null {
    const slug = normalizeSlug(fix.slug);
    const title = normalizeTitle(fix.title);
    const fileSet = normalizeFileSet(getProposalChanges(fix).map(c => c.filePath));

    for (const pr of existingPRs) {
        if (slug && normalizeSlug(pr.slug) === slug) return pr;
        if (title && normalizeTitle(pr.title) === title) return pr;
        if (modeType === 'repair' && fileSet && normalizeFileSet(pr.files) === fileSet) return pr;
    }
    return null;
}

/**
 * Drops proposals already covered by an existing janitor PR, and collapses duplicates
 * within the batch itself (two proposals sharing a slug would otherwise race to create
 * near-identical branches in the same run).
 */
export function filterDuplicateProposals(
    fixes: FixProposal[],
    existingPRs: ExistingJanitorPR[],
    modeType: 'repair' | 'refactor' = 'refactor'
): FixProposal[] {
    const kept: FixProposal[] = [];
    const seen: ExistingJanitorPR[] = [];

    for (const fix of fixes) {
        const duplicate = findDuplicatePR(fix, existingPRs, modeType);
        if (duplicate) {
            const reason = duplicate.state === 'open'
                ? `already open as #${duplicate.number}`
                : `previously closed unmerged as #${duplicate.number}`;
            console.log(`⏭️ Skipping proposal '${fix.slug}' (${fix.title}) — ${reason} (${duplicate.headRefName}).`);
            continue;
        }

        const batchDuplicate = findDuplicatePR(fix, seen, modeType);
        if (batchDuplicate) {
            console.log(`⏭️ Skipping proposal '${fix.slug}' (${fix.title}) — duplicates '${batchDuplicate.slug}' earlier in this same batch.`);
            continue;
        }

        kept.push(fix);
        seen.push({
            number: 0,
            title: fix.title,
            headRefName: `${JANITOR_BRANCH_PREFIX}${fix.slug}`,
            slug: fix.slug,
            files: getProposalChanges(fix).map(c => c.filePath),
            state: 'open',
        });
    }

    return kept;
}

/**
 * Renders existing janitor PRs as prompt context so the model avoids re-proposing them
 * in the first place, rather than relying solely on the post-hoc filter above.
 */
export function describeExistingJanitorPRs(existingPRs: ExistingJanitorPR[], maxEntries: number = 30): string {
    if (existingPRs.length === 0) return '';
    const entries = existingPRs.slice(0, maxEntries).map(pr => {
        const status = pr.state === 'open' ? 'still open, awaiting review' : 'closed without merging (rejected)';
        const files = pr.files.length > 0 ? ` [files: ${pr.files.slice(0, 5).join(', ')}${pr.files.length > 5 ? ', ...' : ''}]` : '';
        return `- #${pr.number}: ${pr.title} (${status})${files}`;
    });
    return entries.join('\n');
}
