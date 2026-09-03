import * as fs from 'fs';

/** What ultimately happened to a single proposed fix. */
export type FixOutcome = 'pr-created' | 'verification-failed' | 'no-changes' | 'error';

export interface FixResult {
    slug: string;
    title: string;
    modeType: 'repair' | 'refactor';
    outcome: FixOutcome;
    /** Short human-readable reason, e.g. the failed verification step. */
    detail?: string;
    prUrl?: string;
}

export type BranchHealth = 'green' | 'broken' | 'unknown';
export type Sweep = 'repair' | 'refactor' | 'none';

export interface RunSummary {
    provider: string;
    model: string;
    mode: string;
    startedAt: number;
    branchHealth: BranchHealth;
    sweep: Sweep;
    existingJanitorPRs: number | null;
    proposed: number;
    duplicatesSkipped: number;
    results: FixResult[];
    notes: string[];
}

export function createRunSummary(provider: string, model: string, mode: string, startedAt: number = Date.now()): RunSummary {
    return {
        provider,
        model,
        mode,
        startedAt,
        branchHealth: 'unknown',
        sweep: 'none',
        existingJanitorPRs: null,
        proposed: 0,
        duplicatesSkipped: 0,
        results: [],
        notes: [],
    };
}

// The run summary is a module-level singleton because outcomes are recorded deep inside
// the PR pipeline (pr.ts), which would otherwise need the summary threaded through every
// call. Tests reset it explicitly via setSummary().
let current: RunSummary = createRunSummary('', '', '');

export function setSummary(summary: RunSummary): void {
    current = summary;
}

export function getSummary(): RunSummary {
    return current;
}

export function recordFixResult(result: FixResult): void {
    current.results.push(result);
}

export function recordNote(note: string): void {
    if (note) current.notes.push(note);
}

export function formatDuration(ms: number): string {
    if (!isFinite(ms) || ms < 0) return '0s';
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** GitHub renders summaries as markdown tables, so cell content must not break the row. */
export function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

const OUTCOME_LABELS: Record<FixOutcome, string> = {
    'pr-created': '✅ PR opened',
    'verification-failed': '❌ Verification failed',
    'no-changes': '⚠️ No changes produced',
    'error': '💥 Error',
};

const HEALTH_LABELS: Record<BranchHealth, string> = {
    green: '✅ Green',
    broken: '⚠️ Failing',
    unknown: '❔ Not checked',
};

const SWEEP_LABELS: Record<Sweep, string> = {
    repair: '🚨 Repair',
    refactor: '🧹 Refactor',
    none: '— None',
};

export function renderSummary(s: RunSummary, now: number = Date.now()): string {
    const created = s.results.filter(r => r.outcome === 'pr-created');
    const lines: string[] = [];

    lines.push('## 🧹 Code Janitor');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Mode | \`${escapeCell(s.mode)}\` |`);
    lines.push(`| Sweep | ${SWEEP_LABELS[s.sweep]} |`);
    lines.push(`| Provider / model | \`${escapeCell(s.provider)}\` / \`${escapeCell(s.model)}\` |`);
    lines.push(`| Main branch health | ${HEALTH_LABELS[s.branchHealth]} |`);
    lines.push(`| Proposals | ${s.proposed} |`);
    if (s.duplicatesSkipped > 0) {
        lines.push(`| Skipped as duplicates | ${s.duplicatesSkipped} |`);
    }
    if (s.existingJanitorPRs !== null) {
        lines.push(`| Existing janitor PRs | ${s.existingJanitorPRs} |`);
    }
    lines.push(`| PRs opened | ${created.length} |`);
    lines.push(`| Duration | ${formatDuration(now - s.startedAt)} |`);
    lines.push('');

    if (s.results.length > 0) {
        lines.push('### Proposed fixes');
        lines.push('');
        lines.push('| Result | Fix | Detail |');
        lines.push('| --- | --- | --- |');
        for (const r of s.results) {
            const title = r.prUrl ? `[${escapeCell(r.title)}](${escapeCell(r.prUrl)})` : escapeCell(r.title);
            const detail = escapeCell(r.detail ?? '');
            lines.push(`| ${OUTCOME_LABELS[r.outcome]} | ${title} | ${detail || '—'} |`);
        }
        lines.push('');
    }

    if (s.notes.length > 0) {
        lines.push('### Notes');
        lines.push('');
        for (const note of s.notes) {
            lines.push(`- ${escapeCell(note)}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Append the rendered summary to $GITHUB_STEP_SUMMARY. Outside Actions the variable is
 * unset and this is a no-op; a write failure is never allowed to fail the run, since the
 * summary is reporting only.
 */
export function writeJobSummary(s: RunSummary = current, now: number = Date.now()): boolean {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target) return false;
    try {
        fs.appendFileSync(target, renderSummary(s, now) + '\n', 'utf-8');
        return true;
    } catch (err) {
        console.warn(`⚠️ Failed to write job summary: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
