import { FileChange, maxLineDiff, maxTestLineDiff } from './config.js';
import { isTestFilePath } from './paths.js';

export interface DiffLineCount {
    added: number;
    removed: number;
}

export interface FileDiffStat extends DiffLineCount {
    filePath: string;
    isTest: boolean;
    total: number;
}

export interface LineBudgetReport {
    productionLines: number;
    testLines: number;
    files: FileDiffStat[];
}

// Guard for the O(n*m) LCS below. Beyond this many cells we fall back to the
// cheaper multiset estimate: a proposal that rewrites files this large is going
// to blow the budget under either method, so exactness stops mattering.
const MAX_LCS_CELLS = 25_000_000;

function splitLines(content: string): string[] {
    if (!content) return [];
    const lines = content.split(/\r?\n/);
    // A trailing newline terminates the last line rather than starting an empty
    // one; git counts it the same way.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/**
 * Order-insensitive fallback: how many line occurrences differ between the two
 * files. Never exceeds the true diff size, so it can only under-report.
 */
function countDiffLinesByMultiset(origLines: string[], updatedLines: string[]): DiffLineCount {
    const counts = new Map<string, number>();
    for (const line of origLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of updatedLines) counts.set(line, (counts.get(line) ?? 0) - 1);

    let added = 0;
    let removed = 0;
    for (const delta of counts.values()) {
        if (delta > 0) removed += delta;
        else if (delta < 0) added += -delta;
    }
    return { added, removed };
}

/**
 * Counts added/removed lines between two file contents the way `git diff
 * --numstat` does: the minimal line edit script, derived from the longest common
 * subsequence of the two line arrays.
 */
export function countDiffLines(original: string, updated: string): DiffLineCount {
    const origLines = splitLines(original);
    const updatedLines = splitLines(updated);

    // Trim the common prefix/suffix first. Most proposals touch a small region of
    // a large file, so this usually reduces the LCS problem to a few dozen lines.
    let start = 0;
    while (start < origLines.length && start < updatedLines.length && origLines[start] === updatedLines[start]) {
        start++;
    }
    let endOrig = origLines.length;
    let endUpdated = updatedLines.length;
    while (endOrig > start && endUpdated > start && origLines[endOrig - 1] === updatedLines[endUpdated - 1]) {
        endOrig--;
        endUpdated--;
    }

    const a = origLines.slice(start, endOrig);
    const b = updatedLines.slice(start, endUpdated);
    if (a.length === 0) return { added: b.length, removed: 0 };
    if (b.length === 0) return { added: 0, removed: a.length };
    if (a.length * b.length > MAX_LCS_CELLS) return countDiffLinesByMultiset(a, b);

    // LCS length only, so two rolling rows suffice.
    let previous = new Uint32Array(b.length + 1);
    let current = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            current[j] = a[i - 1] === b[j - 1]
                ? previous[j - 1] + 1
                : Math.max(previous[j], current[j - 1]);
        }
        const swap = previous;
        previous = current;
        current = swap;
        current.fill(0);
    }
    const lcs = previous[b.length];
    return { added: b.length - lcs, removed: a.length - lcs };
}

/**
 * Totals the diff lines a proposal produces, split into the production and test
 * budgets. `originalContents` maps a change's path to its pre-change content;
 * a missing entry means the proposal creates the file.
 */
export function summarizeLineBudget(originalContents: Map<string, string>, changes: FileChange[]): LineBudgetReport {
    const files: FileDiffStat[] = [];
    let productionLines = 0;
    let testLines = 0;

    for (const change of changes) {
        // An edit-based change resolves to concrete content before validation runs;
        // one still undefined here never made it to disk, so it adds no diff lines.
        if (change.updatedContent === undefined) continue;
        const original = originalContents.get(change.filePath) ?? '';
        const { added, removed } = countDiffLines(original, change.updatedContent);
        const total = added + removed;
        const isTest = isTestFilePath(change.filePath);
        files.push({ filePath: change.filePath, isTest, added, removed, total });
        if (isTest) testLines += total;
        else productionLines += total;
    }

    return { productionLines, testLines, files };
}

function describeFiles(files: FileDiffStat[]): string {
    return files
        .map(f => `${f.filePath} (+${f.added}/-${f.removed})`)
        .join(', ');
}

/**
 * Enforces the configured per-PR diff budgets. The prompt asks the model to stay
 * within them, but a model can simply ignore that, so this is the check that
 * actually holds: an over-budget proposal is failed here and the reason is fed
 * back to the auto-fix retry, which gets one chance to shrink it.
 */
export function validateLineBudget(
    originalContents: Map<string, string>,
    changes: FileChange[],
    productionBudget: number = maxLineDiff,
    testBudget: number = maxTestLineDiff
): { valid: boolean; reason: string; report: LineBudgetReport } {
    const report = summarizeLineBudget(originalContents, changes);
    const violations: string[] = [];

    if (report.productionLines > productionBudget) {
        const offenders = report.files.filter(f => !f.isTest && f.total > 0);
        violations.push(
            `production files changed ${report.productionLines} diff lines, over the ${productionBudget}-line budget (MAX_LINE_DIFF) [${describeFiles(offenders)}]`
        );
    }
    if (report.testLines > testBudget) {
        const offenders = report.files.filter(f => f.isTest && f.total > 0);
        violations.push(
            `test files changed ${report.testLines} diff lines, over the ${testBudget}-line budget (MAX_TEST_LINE_DIFF) [${describeFiles(offenders)}]`
        );
    }

    if (violations.length === 0) {
        return { valid: true, reason: '', report };
    }

    return {
        valid: false,
        reason: `Line Budget Check Failed: ${violations.join('; ')}. Split this into smaller atomic changes or reduce the scope of the edit; do NOT drop tests to fit the production budget (tests have their own separate budget).`,
        report,
    };
}

/** One-line "prod 42/100 lines, tests 0/200 lines" summary for run logs. */
export function formatLineBudgetSummary(
    originalContents: Map<string, string>,
    changes: FileChange[],
    productionBudget: number = maxLineDiff,
    testBudget: number = maxTestLineDiff
): string {
    const report = summarizeLineBudget(originalContents, changes);
    return `production ${report.productionLines}/${productionBudget} diff lines, tests ${report.testLines}/${testBudget} diff lines`;
}
