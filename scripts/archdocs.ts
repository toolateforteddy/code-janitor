import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
    architectureDocs,
    rejectedArchitectureDocs,
    ARCHITECTURE_DOCS_BRANCH_PREFIX,
    ARCHITECTURE_DOCS_HEAD_TRAILER,
    ARCHITECTURE_DOCS_CREATED_TRAILER,
    claudeCodeMaxTurns,
    enforceLineBudget,
    maxLineDiff,
    FileChange,
    FixProposal,
} from './config.js';
import { createJanitorTools, generateStructuredWithTools } from './ai.js';
import { EXEC_MAX_BUFFER, cleanupWorktree } from './git.js';
import { applyEdits } from './edits.js';
import { countDiffLines } from './linebudget.js';
import { createAndSubmitPR } from './pr.js';
import { listChangedPaths } from './agent.js';
import { RepoIndex, addedDocItems, extractDocItems, verifyDocItem, verifyCodeSpan, looksLikePath, VerifyResult } from './archverify.js';
import { getSummary, recordFixResult, recordNote } from './summary.js';

/**
 * Architecture-docs mode: keeps the short repo maps an agent reads before the code (a
 * `repo-architecture.md` saying what is where, say) in step with the code they describe.
 *
 * The listed docs are the only files it can change. Everything else is a guard on that:
 *  - The window is the doc's own history. What changed on the branch since the doc was
 *    last committed is the only drift it looks for, and an edit must cite a commit from
 *    that window or it is dropped.
 *  - The model answers with search/replace edits to the doc it was shown; it has
 *    read-only tools and no way to write anything. The janitor applies the edits to that
 *    one file, so no other path can be touched however the model answers.
 *  - Everything an edit adds is checked against the tree (archverify.ts), and an edit
 *    with anything that does not check out is dropped whole, not trimmed.
 *  - A listed doc that does not exist yet is written from scratch, to bootstrap a repo's
 *    maps. Every paragraph, list item and table row of it is checked the same way, and
 *    one that does not check out is left out rather than the whole doc.
 *  - Nothing drifted, or nothing survived: no PR. Otherwise one draft PR for all the
 *    docs, apart from code-fix PRs, listing each change and the commit behind it.
 */

export const docEditSchema = z.object({
    oldText: z.string().describe('Exact snippet copied verbatim from the doc, unique in it, that this edit replaces'),
    newText: z.string().describe('What replaces oldText. Empty deletes it'),
    summary: z.string().describe('One line for the pull request: what this edit changes in the doc'),
    commits: z.array(z.string()).describe('SHAs, exactly as listed in the window, of the commits that made this edit necessary'),
    claims: z.array(z.string()).describe('Every path, type or function name, and command this edit states, written as it should be looked up (a path, a name, or a command line)'),
});

export const docRefreshSchema = z.object({
    edits: z.array(docEditSchema).describe('Edits for the drift found. Empty when the doc is still accurate'),
});

export type DocEdit = z.infer<typeof docEditSchema>;

export const docCreateSchema = z.object({
    content: z.string().describe('The complete Markdown doc'),
    summary: z.string().describe('One line for the pull request: what the doc covers'),
    claims: z.array(z.string()).describe('Every path, type or function name, and command the doc states, written as it should be looked up'),
});

export interface DroppedUnit {
    text: string;
    reason: string;
}

export interface CreatedDoc {
    doc: string;
    summary: string;
    dropped: DroppedUnit[];
}

const SHELL_FENCE = /^\s*(`{3,}|~{3,})\s*(bash|sh|shell|console|zsh)\s*$/i;

/**
 * Splits Markdown into the units a new doc is checked by: a heading, a table row, a list
 * item with its continuation lines, a paragraph, or a fenced block. Blank lines are kept
 * as their own units so the kept units join back into the doc unchanged.
 */
export function splitDocUnits(markdown: string): string[] {
    const units: string[] = [];
    let current: string[] = [];
    let kind: 'para' | 'item' | 'fence' | null = null;
    let fenceMarker = '';
    const flush = () => {
        if (current.length > 0) units.push(current.join('\n'));
        current = [];
        kind = null;
    };
    for (const line of markdown.split('\n')) {
        if (kind === 'fence') {
            current.push(line);
            if (line.trim().startsWith(fenceMarker)) flush();
            continue;
        }
        const fence = line.match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
            flush();
            kind = 'fence';
            fenceMarker = fence[1];
            current.push(line);
        } else if (!line.trim() || /^\s*(#|\|)/.test(line)) {
            flush();
            units.push(line);
        } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
            flush();
            kind = 'item';
            current.push(line);
        } else if (kind === 'item' && /^\s+/.test(line)) {
            current.push(line);
        } else {
            if (kind !== 'para') flush();
            kind = 'para';
            current.push(line);
        }
    }
    flush();
    return units;
}

/**
 * Keeps the units of a new doc whose every path, name, link and command checks out, and
 * that state none of the claims the model listed that do not. A shell fence is checked
 * line by line and loses only its failing lines; any other fence (a diagram) is kept as
 * written, as it is for an edit.
 */
export function filterUnverifiedUnits(content: string, claims: string[], index: RepoIndex, docDir: string): { content: string; dropped: DroppedUnit[] } {
    const failedClaims = claims
        .map(c => c.trim().replace(/^`+|`+$/g, ''))
        .filter(c => c && !verifyClaim(c, index, docDir).ok);
    const kept: string[] = [];
    const dropped: DroppedUnit[] = [];
    for (const unit of splitDocUnits(content)) {
        if (/^\s*(`{3,}|~{3,})/.test(unit)) {
            const lines = unit.split('\n');
            if (!SHELL_FENCE.test(lines[0]) || lines.length < 2) {
                kept.push(unit);
                continue;
            }
            const body = lines.slice(1, -1).filter(line => {
                const command = line.trim().replace(/^\$\s+/, '').replace(/\s+#.*$/, '');
                if (!command || command.startsWith('#')) return true;
                const result = verifyDocItem({ kind: 'command', text: command }, index, docDir);
                if (!result.ok) dropped.push({ text: line.trim(), reason: result.reason });
                return result.ok;
            });
            if (body.some(l => l.trim())) kept.push([lines[0], ...body, lines[lines.length - 1]].join('\n'));
            continue;
        }
        const reasons = [...new Set([
            ...extractDocItems(unit).map(item => verifyDocItem(item, index, docDir)).filter(r => !r.ok).map(r => r.reason),
            ...failedClaims.filter(c => unit.includes(c)).map(c => `\`${c}\` could not be found`),
        ])];
        if (reasons.length > 0) {
            dropped.push({ text: unit.trim(), reason: reasons.join('; ') });
            continue;
        }
        kept.push(unit);
    }
    const reassembled = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { content: reassembled ? reassembled + '\n' : '', dropped };
}

export interface WindowCommit {
    sha: string;
    date: string;
    subject: string;
    /** `git log --name-status` lines: `A path`, `D path`, `R100 old -> new`, `M path`. */
    changes: string[];
}

export interface DocWindow {
    doc: string;
    /** The commit the window starts after: the doc's last commit, or a rejected docs PR's head. */
    start: string;
    commits: WindowCommit[];
}

export interface AcceptedEdit {
    doc: string;
    summary: string;
    commits: WindowCommit[];
}

export interface DroppedEdit {
    doc: string;
    summary: string;
    reason: string;
}

function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: EXEC_MAX_BUFFER }).trim();
}

function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** The last commit on HEAD's history that changed `doc`, or '' when it was never committed. */
export function docLastCommit(doc: string, cwd: string): string {
    try {
        return git(['log', '-1', '--format=%H', 'HEAD', '--', doc], cwd);
    } catch {
        return '';
    }
}

/**
 * The commits since `start` that changed anything but the listed docs, oldest first.
 * Merge commits are left out: what they bring in is listed as the commits themselves.
 */
export function listWindowCommits(start: string, head: string, docs: string[], cwd: string): WindowCommit[] {
    const out = execFileSync('git', [
        'log', '--no-merges', '--reverse', '-M', '--name-status', '--date=short',
        '--format=%x1e%H%x1f%ad%x1f%s', `${start}..${head}`, '--', '.', ...docs.map(d => `:(exclude,literal)${d}`),
    ], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: EXEC_MAX_BUFFER });
    const commits: WindowCommit[] = [];
    for (const record of out.split('\x1e')) {
        const [header, ...rest] = record.split('\n');
        const [sha, date, subject] = header.split('\x1f');
        if (!sha || !sha.trim()) continue;
        const changes = rest.map(l => l.trim()).filter(Boolean).map(l => l.replace(/\t/g, ' ').replace(/^(R\d*) (\S+) (\S+)$/, '$1 $2 -> $3'));
        commits.push({ sha: sha.trim(), date: date ?? '', subject: subject ?? '', changes });
    }
    return commits;
}

/** The commit list as the model sees it, kept to `limit` characters. Returns the commits it shows. */
export function formatWindow(commits: WindowCommit[], limit: number = 40000, maxFilesPerCommit: number = 40): { text: string; shown: WindowCommit[] } {
    const lines: string[] = [];
    const shown: WindowCommit[] = [];
    let length = 0;
    for (const commit of commits) {
        const files = commit.changes.slice(0, maxFilesPerCommit).map(c => `    ${c}`);
        if (commit.changes.length > maxFilesPerCommit) files.push(`    ... and ${commit.changes.length - maxFilesPerCommit} more`);
        const block = [`${commit.sha.slice(0, 12)} ${commit.date} ${commit.subject}`, ...files].join('\n');
        if (length + block.length > limit && shown.length > 0) {
            lines.push(`(${commits.length - shown.length} later commit(s) not shown: the list hit its size limit. They are picked up on a later run.)`);
            break;
        }
        lines.push(block);
        shown.push(commit);
        length += block.length + 1;
    }
    return { text: lines.join('\n'), shown };
}

/** Maps each cited SHA (a prefix of at least 7) to its commit in the window; unknown citations are dropped. */
export function resolveCitations(cited: string[], window: WindowCommit[]): WindowCommit[] {
    const found: WindowCommit[] = [];
    for (const raw of cited) {
        const sha = raw.trim().toLowerCase();
        if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
        const commit = window.find(c => c.sha.startsWith(sha));
        if (commit && !found.includes(commit)) found.push(commit);
    }
    return found;
}

/** A model's "claim" is checked as a path, a command or a name, by its shape. */
export function verifyClaim(claim: string, index: RepoIndex, docDir: string): VerifyResult {
    const text = claim.trim().replace(/^`+|`+$/g, '');
    if (!text) return { ok: true, reason: '' };
    return verifyCodeSpan(text, index, looksLikePath(text) ? docDir : '');
}

/**
 * Applies a doc's edits one at a time, keeping each only if it cites a commit from the
 * window, everything it adds checks out, it applies cleanly, and the docs' total change
 * stays inside `lineBudget`. One bad edit costs that edit, not the rest.
 */
export function applyDocEdits(
    doc: string,
    original: string,
    edits: DocEdit[],
    window: WindowCommit[],
    index: RepoIndex,
    lineBudget: number = Infinity,
): { content: string; accepted: AcceptedEdit[]; dropped: DroppedEdit[] } {
    const docDir = path.posix.dirname(doc) === '.' ? '' : path.posix.dirname(doc);
    let content = original;
    const accepted: AcceptedEdit[] = [];
    const dropped: DroppedEdit[] = [];
    for (const edit of edits) {
        const summary = edit.summary.trim() || '(no summary)';
        const drop = (reason: string) => dropped.push({ doc, summary, reason });

        const commits = resolveCitations(edit.commits, window);
        if (commits.length === 0) {
            drop(`cites no commit from the window (${edit.commits.join(', ') || 'none given'})`);
            continue;
        }
        const failures = [
            ...addedDocItems(edit.oldText, edit.newText).map(item => verifyDocItem(item, index, docDir)),
            ...edit.claims.map(claim => verifyClaim(claim, index, docDir)),
        ].filter(r => !r.ok);
        if (failures.length > 0) {
            drop(`could not verify: ${[...new Set(failures.map(f => f.reason))].join('; ')}`);
            continue;
        }
        const applied = applyEdits(content, [{ oldText: edit.oldText, newText: edit.newText }], doc);
        if (!applied.ok) {
            drop(applied.reason);
            continue;
        }
        if (applied.content === content) continue;
        const { added, removed } = countDiffLines(original, applied.content);
        if (added + removed > lineBudget) {
            drop(`would take the doc past the line budget (${added + removed} > ${lineBudget} changed lines)`);
            continue;
        }
        content = applied.content;
        accepted.push({ doc, summary, commits });
    }
    return { content, accepted, dropped };
}

export function buildDocSystemPrompt(doc: string, docs: string[]): string {
    const others = docs.filter(d => d !== doc);
    return `
    You keep one architecture map accurate: ${doc}. It tells a reader (often an AI agent) what is where in this repository without reading all of the code: directories, modules, crates and packages, entry points, what each part is responsible for, which files are generated and the command that regenerates them.
    ${others.length ? `The other maps kept this way are ${others.join(', ')}; they are refreshed separately, so leave what they cover to them.` : ''}

    You are given the doc and every commit that changed the repository since the doc was last updated. Find where the doc no longer matches the code, and return search/replace edits for exactly that.

    RULES:
    1. Only fix drift the listed commits caused: a directory, module or package added, removed or renamed; a responsibility that moved; an entry point renamed; a generated file, its source or its command changed. If none of the commits made the doc wrong, return no edits. That is the expected answer most weeks.
    2. Keep the doc's structure, voice, headings, tables and level of detail. Add a row where a table lists things, change a sentence where a sentence is wrong. No rewording for style, no reordering, no new sections unless a new top-level part of the repo needs one, and nothing about design decisions or plans: those belong to people.
    3. Check every claim in the code before you make it, with the read-only tools: open the file, find the type or function, read the script or manifest that defines a command. Write every path, type, function and command in backticks, as the doc already does. Each one is checked afterwards against the repository, and an edit with any that cannot be found is thrown away whole.
    4. For each edit, list the SHAs (as shown in the commit list) of the commits that made it necessary, and in 'claims' every path, name and command the edit states.
    5. 'oldText' must be copied verbatim from the doc as given and be unique in it. Keep each edit small: the rows or sentences that change, not whole sections.
    6. You can change only ${doc}. Do not describe changes to any other file.
  `;
}

export function buildDocPrompt(doc: string, content: string, window: DocWindow, windowText: string): string {
    return `The doc, ${doc}, as it stands at HEAD:\n\n<doc>\n${content}\n</doc>\n\n` +
        `Commits since it was last updated (after ${window.start.slice(0, 12)}), oldest first, each with the files it added (A), deleted (D), renamed (R) or modified (M):\n\n${windowText}`;
}

export function buildCreateSystemPrompt(doc: string, docs: string[]): string {
    const others = docs.filter(d => d !== doc);
    const dir = path.posix.dirname(doc);
    return `
    You are writing ${doc}, an architecture map of this repository that does not exist yet. Its reader (often an AI agent) uses it to find what is where without reading all of the code.
    ${others.length ? `It is one of a set of maps: ${docs.join(', ')}. Cover what its name says and leave the others' ground to them. Any that already exist are shown to you: match their voice and link to them rather than repeating them.` : ''}

    RULES:
    1. Describe what is there now: the top-level directories and what each holds, the modules or packages and what each is responsible for, the entry points, which files are generated and the exact command that regenerates each, and where to start for common tasks. Short sentences and tables, not essays.
    2. Check every claim in the code before you make it, with the read-only tools. Write every path, type, function and command in backticks. Each paragraph, list item and table row is checked afterwards against the repository, and one that names anything that cannot be found is left out of the doc.
    3. Nothing about design decisions, plans, history or opinions: those belong to people. Do not copy other docs; link to them.
    4. Follow the repository's own documentation conventions (its agent instructions say what they are). Links are relative to ${dir === '.' ? 'the repository root' : `${dir}/`}.
    5. List in 'claims' every path, name and command the doc states.
  `;
}

export function buildCreatePrompt(doc: string, references: Array<{ doc: string; content: string }>, layout: string): string {
    const refs = references.map(r => `The existing map ${r.doc}:\n\n<doc>\n${r.content.slice(0, 20000)}\n</doc>`).join('\n\n');
    return `Write ${doc}.\n\nTracked directories, two levels deep:\n\n${layout}${refs ? `\n\n${refs}` : ''}`;
}

/** The repository's directories, two levels deep and dot-directories left out, as a starting point for a new map. */
export function describeLayout(index: RepoIndex, maxEntries: number = 200): string {
    const dirs = [...index.dirs].filter(d => d.split('/').length <= 2 && !d.split('/').some(seg => seg.startsWith('.'))).sort();
    const shown = dirs.slice(0, maxEntries).map(d => `${d}/`);
    if (dirs.length > maxEntries) shown.push(`... and ${dirs.length - maxEntries} more`);
    return shown.join('\n') || '(no subdirectories)';
}

/** The architecture-docs PRs on this repository: whether one is still open, and the head the latest rejected one covered. */
export function readDocsPRState(prs: Array<{ number?: number; url?: string; headRefName?: string; state?: string; mergedAt?: string | null; body?: string }>): {
    open: { number: number; url: string } | null;
    rejectedHead: string;
    /** Docs the latest rejected PR would have created; not written again until a human asks. */
    rejectedCreated: string[];
} {
    const docsPRs = prs.filter(pr => (pr.headRefName ?? '').startsWith(ARCHITECTURE_DOCS_BRANCH_PREFIX));
    const openPR = docsPRs.find(pr => (pr.state ?? '').toUpperCase() === 'OPEN');
    const rejected = docsPRs
        .filter(pr => (pr.state ?? '').toUpperCase() === 'CLOSED' && !pr.mergedAt)
        .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
    const createdPattern = new RegExp(`^\\s*${ARCHITECTURE_DOCS_CREATED_TRAILER}:\\s*(\\S+)\\s*$`, 'gim');
    const headPattern = new RegExp(`^\\s*${ARCHITECTURE_DOCS_HEAD_TRAILER}:\\s*([0-9a-f]{7,40})\\s*$`, 'im');
    return {
        open: openPR ? { number: openPR.number ?? 0, url: openPR.url ?? '' } : null,
        rejectedHead: rejected?.body?.match(headPattern)?.[1] ?? '',
        rejectedCreated: [...(rejected?.body ?? '').matchAll(createdPattern)].map(m => m[1]),
    };
}

function fetchDocsPRState(cwd: string): ReturnType<typeof readDocsPRState> {
    try {
        const raw = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'number,url,headRefName,state,mergedAt,body'], {
            cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        return readDocsPRState(JSON.parse(raw || '[]'));
    } catch (err) {
        console.warn(`⚠️ Could not list earlier architecture-docs PRs (continuing as if there were none): ${err instanceof Error ? err.message : String(err)}`);
        return { open: null, rejectedHead: '', rejectedCreated: [] };
    }
}

export function buildDocsPRDescription(head: string, windows: DocWindow[], accepted: AcceptedEdit[], dropped: DroppedEdit[], created: CreatedDoc[] = []): string {
    const lines: string[] = [
        `Brings the architecture docs up to date with \`${head.slice(0, 12)}\`.${accepted.length > 0 ? ' Each change below names the commit that made the doc wrong.' : ''}`,
        '',
    ];
    for (const doc of created) {
        lines.push(`### \`${doc.doc}\` (new)`, '', `${doc.summary} Written from scratch because it is listed in \`architecture_docs\` and did not exist.`, '');
        if (doc.dropped.length > 0) {
            lines.push('Left out of it, because they could not be checked:', '');
            for (const d of doc.dropped) lines.push(`- "${d.text.replace(/\s+/g, ' ').slice(0, 120)}" (${d.reason})`);
            lines.push('');
        }
    }
    for (const window of windows) {
        const edits = accepted.filter(a => a.doc === window.doc);
        if (edits.length === 0) continue;
        lines.push(`### \`${window.doc}\``, '', `Commits since the doc was last updated: ${window.commits.length} (after \`${window.start.slice(0, 12)}\`).`, '');
        for (const edit of edits) {
            const causes = edit.commits.map(c => `${c.sha.slice(0, 12)} (${c.subject})`).join(', ');
            lines.push(`- ${edit.summary} Caused by ${causes}.`);
        }
        lines.push('');
    }
    if (dropped.length > 0) {
        lines.push('### Left out', '', 'Proposed but not made, because they could not be checked:', '');
        for (const d of dropped) lines.push(`- \`${d.doc}\`: ${d.summary} (${d.reason})`);
        lines.push('');
    }
    lines.push(
        `Every path, name and command ${created.length > 0 ? 'in these docs' : 'these edits add'} was checked against the tree at that commit: paths exist, names appear in the code, and commands name scripts, packages, npm scripts and make targets that exist. Commands were not run. No file other than the listed architecture docs is changed.`,
        '',
        ...created.map(c => `${ARCHITECTURE_DOCS_CREATED_TRAILER}: ${c.doc}`),
        `${ARCHITECTURE_DOCS_HEAD_TRAILER}: ${head}`,
    );
    return lines.join('\n');
}

/** Writes the refreshed docs on a fresh branch from `head` and opens the PR. Only the listed docs can be staged. */
function openDocsPR(fix: FixProposal, changes: FileChange[], head: string, docs: string[]): boolean {
    const timestamp = Date.now();
    const branchName = `${ARCHITECTURE_DOCS_BRANCH_PREFIX}${timestamp}`;
    const worktreePath = path.resolve(process.cwd(), `.janitor-worktree-architecture-docs-${timestamp}`);
    try {
        execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, head], { stdio: ['pipe', 'pipe', 'pipe'] });
        for (const change of changes) {
            if (!docs.includes(change.filePath)) throw new Error(`Refusing to write ${change.filePath}: not a listed architecture doc`);
            fs.mkdirSync(path.dirname(path.join(worktreePath, change.filePath)), { recursive: true });
            fs.writeFileSync(path.join(worktreePath, change.filePath), change.updatedContent!, 'utf-8');
        }
        const stray = listChangedPaths(worktreePath).filter(p => !docs.includes(p));
        if (stray.length > 0) throw new Error(`Refusing to open the PR: files other than the architecture docs changed (${stray.join(', ')})`);
        return createAndSubmitPR(fix, branchName, worktreePath, 'architecture-docs', changes);
    } catch (err) {
        recordFixResult({ slug: fix.slug, title: fix.title, modeType: 'architecture-docs', outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
        throw err;
    } finally {
        cleanupWorktree(worktreePath);
    }
}

/** The whole mode: find each doc's window, ask for its drift, keep what checks out, open one PR. */
export async function runArchitectureDocs(docs: string[] = architectureDocs, workDir: string = process.cwd(), startHead: string = ''): Promise<void> {
    const summary = getSummary();
    if (summary.sweep === 'none') summary.sweep = 'architecture-docs';
    if (rejectedArchitectureDocs.length > 0) {
        recordNote(`Ignored architecture_docs entries that are not repo-relative Markdown paths: ${rejectedArchitectureDocs.join(', ')}.`);
    }
    if (docs.length === 0) {
        throw new Error("janitor_mode 'docs-only' needs the architecture_docs input: a comma-separated list of the Markdown files to keep up to date.");
    }

    const prState = fetchDocsPRState(workDir);
    if (prState.open) {
        console.log(`📚 Architecture-docs PR #${prState.open.number} is still open; not opening another until it is merged or closed.`);
        recordNote(`Architecture-docs PR #${prState.open.number} is still open (${prState.open.url}); nothing new proposed until it is merged or closed.`);
        return;
    }

    const head = startHead || git(['rev-parse', 'HEAD'], workDir);
    const windows: DocWindow[] = [];
    const toCreate: string[] = [];
    for (const doc of docs) {
        if (!fs.existsSync(path.join(workDir, doc))) {
            if (prState.rejectedCreated.includes(doc)) {
                recordNote(`\`${doc}\` does not exist, but the last docs PR that wrote it was closed without merging; not writing it again until it is written by hand or that PR is reopened.`);
            } else {
                console.log(`📚 ${doc} does not exist yet; it will be written from scratch.`);
                toCreate.push(doc);
            }
            continue;
        }
        const last = docLastCommit(doc, workDir);
        if (!last) {
            recordNote(`\`${doc}\` has never been committed, so there is no history to measure drift from.`);
            continue;
        }
        // A rejected docs PR already showed a human this window. Start after what it
        // covered, so the same drift is not proposed again every week.
        const start = prState.rejectedHead && isAncestor(last, prState.rejectedHead, workDir) ? prState.rejectedHead : last;
        const commits = listWindowCommits(start, head, docs, workDir);
        console.log(`📚 ${doc}: ${commits.length} commit(s) since ${start.slice(0, 12)}${start === last ? ' (its last update)' : ' (covered by a rejected docs PR)'}.`);
        if (commits.length > 0) windows.push({ doc, start, commits });
    }
    if (windows.length === 0 && toCreate.length === 0) {
        recordNote('No commits since the architecture docs were last updated; nothing to check.');
        return;
    }

    const index = new RepoIndex(workDir);
    const tools = createJanitorTools(workDir);
    const changes: FileChange[] = [];
    const accepted: AcceptedEdit[] = [];
    const dropped: DroppedEdit[] = [];
    let budgetLeft = enforceLineBudget ? maxLineDiff : Infinity;

    for (const window of windows) {
        const original = fs.readFileSync(path.join(workDir, window.doc), 'utf-8');
        const { text, shown } = formatWindow(window.commits);
        console.log(`🤖 Asking the model what drifted in ${window.doc}...`);
        const answer = await generateStructuredWithTools(
            docRefreshSchema,
            buildDocSystemPrompt(window.doc, docs),
            buildDocPrompt(window.doc, original, window, text),
            tools,
            workDir,
        );
        summary.proposed += answer.edits.length;
        const result = applyDocEdits(window.doc, original, answer.edits, shown, index, budgetLeft);
        accepted.push(...result.accepted);
        dropped.push(...result.dropped);
        for (const d of result.dropped) console.warn(`   ✂️ Dropped edit to ${d.doc}: ${d.summary} -- ${d.reason}`);
        if (result.content !== original) {
            const { added, removed } = countDiffLines(original, result.content);
            budgetLeft -= added + removed;
            changes.push({ filePath: window.doc, updatedContent: result.content });
        }
        console.log(`   ${result.accepted.length} edit(s) kept, ${result.dropped.length} dropped.`);
    }

    // Bootstrapping: a listed doc that does not exist is written whole, and checked a
    // paragraph, list item and table row at a time. The line budget is for edits; a new
    // map is as long as the repository needs.
    const created: CreatedDoc[] = [];
    for (const doc of toCreate) {
        const docDir = path.posix.dirname(doc) === '.' ? '' : path.posix.dirname(doc);
        const references = docs
            .filter(d => d !== doc && fs.existsSync(path.join(workDir, d)))
            .map(d => ({ doc: d, content: changes.find(c => c.filePath === d)?.updatedContent ?? fs.readFileSync(path.join(workDir, d), 'utf-8') }));
        console.log(`🤖 Asking the model to write ${doc}...`);
        const answer = await generateStructuredWithTools(
            docCreateSchema,
            buildCreateSystemPrompt(doc, docs),
            buildCreatePrompt(doc, references, describeLayout(index)),
            tools,
            workDir,
            // Writing a map takes reading far more of the code than checking one.
            { claudeCodeMaxTurns: claudeCodeMaxTurns * 2 },
        );
        summary.proposed += 1;
        const result = filterUnverifiedUnits(answer.content, answer.claims, index, docDir);
        for (const d of result.dropped) console.warn(`   ✂️ Left out of ${doc}: "${d.text.slice(0, 80)}" -- ${d.reason}`);
        for (const d of result.dropped) recordNote(`Left out of the new \`${doc}\`: "${d.text.replace(/\s+/g, ' ').slice(0, 80)}" (${d.reason})`);
        if (!result.content.replace(/^\s*#.*$/gm, '').trim()) {
            recordNote(`Nothing written for \`${doc}\` survived verification; it was not created.`);
            continue;
        }
        changes.push({ filePath: doc, updatedContent: result.content });
        created.push({ doc, summary: answer.summary.trim(), dropped: result.dropped });
        console.log(`   Wrote ${doc}: ${result.content.split('\n').length} lines, ${result.dropped.length} part(s) left out.`);
    }

    for (const d of dropped) recordNote(`Dropped an edit to \`${d.doc}\`: ${d.summary} (${d.reason})`);
    if (changes.length === 0) {
        console.log('📚 Nothing drifted that could be verified; no PR.');
        recordNote(accepted.length === 0 && dropped.length === 0
            ? 'The architecture docs still match the code; no PR.'
            : 'No edit survived verification; no PR.');
        return;
    }

    const fix: FixProposal = {
        slug: 'architecture-docs',
        title: `Refresh architecture docs (${changes.map(c => `${created.some(d => d.doc === c.filePath) ? 'new ' : ''}${path.posix.basename(c.filePath)}`).join(', ')})`,
        description: buildDocsPRDescription(head, windows, accepted, dropped, created),
    };
    openDocsPR(fix, changes, head, docs);
}
