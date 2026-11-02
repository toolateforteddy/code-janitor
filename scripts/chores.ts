import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import {
    CHORES_DIR,
    ChoreRef,
    FixProposal,
    fixesResponseSchema,
    maxLineDiff,
    maxTestLineDiff,
} from './config.js';
import {
    agentFlowActive,
    changeFormatRule,
    createJanitorTools,
    generateStructuredWithTools,
    getAgentFilesContext,
    formatFilesToRead,
    getFullFileContexts,
} from './ai.js';
import { normalizeSlug, ExistingJanitorPR } from './dedupe.js';

/**
 * Chores: standing work a repository asks of the janitor, one TOML file per chore in
 * `.code-janitor/chores/`. One file each, so two branches adding a chore never touch the
 * same file, and a one-off chore is cleared by deleting its file, which never conflicts.
 *
 * A chore names the files it is about and, optionally, when it applies:
 *
 * - `max_lines = N`: every matching file longer than N lines, checked on every sweep
 *   whatever the window holds. One PR per file.
 * - `once = true`: every matching file, once. The PR that does it deletes the chore.
 * - neither: the matching files that changed in this sweep's window, in one PR.
 *
 * Deciding which chores apply costs no model call: it is `git ls-files` and a line count.
 */

export const choreFileSchema = z.object({
    title: z.string().trim().min(1).optional(),
    instructions: z.string().trim().min(1),
    files: z.array(z.string().trim().min(1)).min(1),
    max_lines: z.number().int().positive().optional(),
    once: z.boolean().optional(),
    max_line_diff: z.number().int().positive().optional(),
    max_test_line_diff: z.number().int().positive().optional(),
}).strict();

export type ChoreFile = z.infer<typeof choreFileSchema>;

export interface Chore extends ChoreFile {
    name: string;
    source: string;
}

/** One piece of chore work: the chore and the files this PR is about. */
export interface ChoreTask {
    chore: Chore;
    files: string[];
    slug: string;
    /** Why the chore applies to these files now, for the PR description. */
    reason: string;
}

/** The most files one chore PR is about. A proposal may change at most five. */
export const MAX_CHORE_FILES = 5;

/** Parses one chore file's text. Throws with a readable message when it is not a valid chore. */
export function parseChore(name: string, source: string, text: string): Chore {
    let raw: unknown;
    try {
        raw = parseToml(text);
    } catch (err) {
        throw new Error(`${source} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = choreFileSchema.safeParse(raw);
    if (!parsed.success) {
        const problems = parsed.error.issues.map(i => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; ');
        throw new Error(`${source} is not a valid chore: ${problems}`);
    }
    if (parsed.data.once && parsed.data.max_lines !== undefined) {
        throw new Error(`${source} is not a valid chore: 'once' and 'max_lines' cannot be combined.`);
    }
    return { ...parsed.data, name, source };
}

/**
 * Reads every chore in `workDir`. A chore that does not parse is reported in `errors`
 * and skipped, rather than failing the sweep.
 */
export function loadChores(workDir: string = process.cwd()): { chores: Chore[]; errors: string[] } {
    const dir = path.join(workDir, CHORES_DIR);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { chores: [], errors: [] };
    const chores: Chore[] = [];
    const errors: string[] = [];
    for (const entry of fs.readdirSync(dir).sort()) {
        if (!entry.endsWith('.toml')) continue;
        const source = `${CHORES_DIR}/${entry}`;
        try {
            chores.push(parseChore(entry.slice(0, -'.toml'.length), source, fs.readFileSync(path.join(dir, entry), 'utf-8')));
        } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
        }
    }
    return { chores, errors };
}

/** Tracked files matching any of `patterns`, read as git glob pathspecs (`**` crosses directories). */
export function listMatchingFiles(patterns: string[], workDir: string = process.cwd()): string[] {
    const pathspecs = patterns.map(p => `:(glob)${p.replace(/^\.\//, '')}`);
    try {
        const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        return out.split('\0').filter(Boolean).sort();
    } catch {
        return [];
    }
}

/** Lines in `content`, counting a last line with no newline after it. */
export function countLines(content: string): number {
    if (!content) return 0;
    const newlines = content.split('\n').length - 1;
    return content.endsWith('\n') ? newlines : newlines + 1;
}

export function choreSlug(chore: Chore, file?: string): string {
    return normalizeSlug(file ? `chore-${chore.name}-${file}` : `chore-${chore.name}`);
}

/**
 * The work each chore asks for this sweep. `changedFiles` are the files the window
 * touched, which only a chore with no trigger of its own looks at.
 */
export function planChoreTasks(chores: Chore[], changedFiles: string[], workDir: string = process.cwd()): ChoreTask[] {
    const changed = new Set(changedFiles);
    const tasks: ChoreTask[] = [];
    for (const chore of chores) {
        const matched = listMatchingFiles(chore.files, workDir);
        if (chore.max_lines !== undefined) {
            for (const file of matched) {
                let lines: number;
                try {
                    lines = countLines(fs.readFileSync(path.join(workDir, file), 'utf-8'));
                } catch {
                    continue;
                }
                if (lines > chore.max_lines) {
                    tasks.push({
                        chore,
                        files: [file],
                        slug: choreSlug(chore, file),
                        reason: `\`${file}\` is ${lines} lines long, over this chore's limit of ${chore.max_lines}.`,
                    });
                }
            }
            continue;
        }
        const files = chore.once ? matched : matched.filter(f => changed.has(f));
        if (files.length === 0) continue;
        tasks.push({
            chore,
            files: files.slice(0, MAX_CHORE_FILES),
            slug: choreSlug(chore),
            reason: chore.once
                ? 'This is a one-off chore.'
                : 'These files changed since the last sweep.',
        });
    }
    return tasks;
}

/**
 * Drops tasks an existing janitor PR already covers: one still open, or one a human
 * closed without merging. A chore's branch slug is fixed by the chore and the file, so
 * this is an exact match rather than the sweep's fuzzy one.
 */
export function filterCoveredChoreTasks(tasks: ChoreTask[], existing: ExistingJanitorPR[]): { tasks: ChoreTask[]; covered: ChoreTask[] } {
    const taken = new Set(existing.map(pr => normalizeSlug(pr.slug)));
    const kept: ChoreTask[] = [];
    const covered: ChoreTask[] = [];
    for (const task of tasks) (taken.has(normalizeSlug(task.slug)) ? covered : kept).push(task);
    return { tasks: kept, covered };
}

export function choreRef(task: ChoreTask): ChoreRef {
    return {
        name: task.chore.name,
        source: task.chore.source,
        once: Boolean(task.chore.once),
        productionBudget: task.chore.max_line_diff ?? maxLineDiff,
        testBudget: task.chore.max_test_line_diff ?? maxTestLineDiff,
        targets: task.files,
    };
}

export function choreTitle(task: ChoreTask): string {
    const base = task.chore.title ?? task.chore.name.replace(/[-_]+/g, ' ');
    return task.files.length === 1 ? `${base}: ${task.files[0]}` : base;
}

/** What the chore asks, in the form a proposal's description takes. */
export function describeChoreTask(task: ChoreTask): string {
    const ref = choreRef(task);
    return [
        task.chore.instructions,
        '',
        `${task.reason} Files: ${task.files.map(f => `\`${f}\``).join(', ')}.`,
        `New files may be created where the chore calls for it. Line budget for this chore: ${ref.productionBudget} production and ${ref.testBudget} test diff lines.`,
    ].join('\n');
}

/**
 * Turns a task into a proposal. In the claude-code agent flow the chore is already a
 * plan, so it goes to the agent as it is with no planning request. Otherwise the model
 * writes the change, as it does for a sweep proposal. Returns null when it proposes none.
 */
export async function proposeChore(task: ChoreTask, workDir: string = process.cwd()): Promise<FixProposal | null> {
    const chore = choreRef(task);
    const description = describeChoreTask(task);
    const title = choreTitle(task);
    if (agentFlowActive()) {
        return { slug: task.slug, title, description, plannedFiles: task.files, chore };
    }

    const system = `
    You are an expert software maintainer doing one chore the repository's owners asked for.

    RULES:
    1. Do exactly the chore described, for the files named, as ONE proposal. Keep everything else byte-identical.
    2. LINE BUDGETS (ENFORCED IN CODE): at most ${chore.productionBudget} diff lines (added + removed) across production files and ${chore.testBudget} across test files.
    3. You may create new files and move code between files when the chore calls for it; update every caller, import and reference that moves.
    4. ${changeFormatRule()}
    5. Do not add suppressions to make checks pass. Follow the repository's own agent instructions.
    6. If the chore needs no change after all, return an empty 'fixes' list.
    7. Use the slug "${task.slug}" for the proposal.
  `;
    const tools = createJanitorTools(workDir);
    const agents = getAgentFilesContext(workDir);
    const lead = `Chore: ${title}\n\n${description}`
        + (agents ? `\n\nProject Agent Instructions & Repository Guidelines:\n\n${agents}` : '');
    const prompt = {
        full: `${lead}\n\nFull contents of the files:\n\n${getFullFileContexts(task.files, workDir)}`,
        claudeCode: lead + formatFilesToRead('Files this chore is about', task.files),
    };
    const result = await generateStructuredWithTools(fixesResponseSchema, system, prompt, tools, workDir);
    const fix = result.fixes[0];
    if (!fix) return null;
    return { ...fix, slug: task.slug, title, chore };
}
