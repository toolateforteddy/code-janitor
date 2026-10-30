import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { parseArchitectureDocs } from './config.js';
import { RepoIndex } from './archverify.js';
import {
    applyDocEdits,
    buildDocsPRDescription,
    docLastCommit,
    formatWindow,
    listWindowCommits,
    readDocsPRState,
    resolveCitations,
    DocEdit,
    WindowCommit,
} from './archdocs.js';

const DOC = [
    '# Repo architecture',
    '',
    '| Crate | Path |',
    '| --- | --- |',
    '| `engine` | `rust/engine/` |',
    '',
].join('\n');

function commit(dir: string, message: string, files: Record<string, string | null>): string {
    for (const [file, content] of Object.entries(files)) {
        const abs = path.join(dir, file);
        if (content === null) {
            fs.rmSync(abs);
        } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
        }
    }
    execSync(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${message}"`, { cwd: dir });
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

function edit(fields: Partial<DocEdit>): DocEdit {
    return { oldText: '', newText: '', summary: 'An edit.', commits: [], claims: [], ...fields };
}

describe('archdocs', () => {
    let repo: string;
    let docCommit: string;
    let simCommit: string;
    let renameCommit: string;
    let window: WindowCommit[];
    let index: RepoIndex;

    before(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'archdocs-'));
        execSync('git init -q', { cwd: repo });
        commit(repo, 'engine', { 'rust/engine/src/lib.rs': 'pub struct Engine;\n' });
        docCommit = commit(repo, 'map', { 'docs/repo-architecture.md': DOC });
        simCommit = commit(repo, 'Add the balance lab', { 'rust/sim/Cargo.toml': '[package]\nname = "sim"\n', 'rust/sim/src/main.rs': 'pub fn run_fights() {}\n' });
        renameCommit = commit(repo, 'Rename the runner', {
            'scripts/run.sh': '#!/bin/sh\n',
            'docs/design/notes.md': 'design\n',
        });
        commit(repo, 'Touch only the map', { 'docs/repo-architecture.md': DOC + '\n' });
        window = listWindowCommits(docCommit, 'HEAD', ['docs/repo-architecture.md'], repo);
        index = new RepoIndex(repo);
    });
    after(() => fs.rmSync(repo, { recursive: true, force: true }));

    describe('parseArchitectureDocs()', () => {
        it('takes comma- or newline-separated repo-relative Markdown paths', () => {
            assert.deepEqual(parseArchitectureDocs('docs/repo-architecture.md, ./docs/code-architecture.md\nARCH.mdx, docs/repo-architecture.md'), {
                docs: ['docs/repo-architecture.md', 'docs/code-architecture.md', 'ARCH.mdx'],
                rejected: [],
            });
        });

        it('refuses anything that could reach past the listed files', () => {
            const { docs, rejected } = parseArchitectureDocs('/etc/passwd.md, ../x.md, docs/*.md, src/main.rs, C:/a.md');
            assert.deepEqual(docs, []);
            assert.equal(rejected.length, 5);
        });

        it('is empty when unset', () => {
            assert.deepEqual(parseArchitectureDocs(undefined), { docs: [], rejected: [] });
        });
    });

    describe('docLastCommit() and listWindowCommits()', () => {
        it('measures the window from the doc and leaves out commits that only touched the listed docs', () => {
            assert.notEqual(docLastCommit('docs/repo-architecture.md', repo), docCommit, 'the last touch is the trailing newline commit');
            assert.deepEqual(window.map(c => c.subject), ['Add the balance lab', 'Rename the runner']);
            assert.deepEqual(window[0].changes, ['A rust/sim/Cargo.toml', 'A rust/sim/src/main.rs']);
        });

        it('is empty for a doc that was never committed', () => {
            assert.equal(docLastCommit('docs/missing.md', repo), '');
        });
    });

    describe('formatWindow()', () => {
        it('stops at the size limit and says how many commits it left out', () => {
            const { text, shown } = formatWindow(window, 10);
            assert.equal(shown.length, 1);
            assert.match(text, /1 later commit\(s\) not shown/);
        });
    });

    describe('resolveCitations()', () => {
        it('matches SHA prefixes of seven or more against the window only', () => {
            assert.deepEqual(resolveCitations([simCommit.slice(0, 7), 'zzz', simCommit, docCommit.slice(0, 12)], window).map(c => c.sha), [simCommit]);
        });
    });

    describe('applyDocEdits()', () => {
        const row = '| `engine` | `rust/engine/` |';
        const addSim = edit({
            oldText: row,
            newText: `${row}\n| \`sim\` | \`rust/sim/\` |`,
            summary: 'Add the sim crate.',
            claims: ['rust/sim/', 'run_fights'],
        });

        it('keeps an edit that cites a window commit and whose additions all exist', () => {
            const result = applyDocEdits('docs/repo-architecture.md', DOC, [{ ...addSim, commits: [simCommit.slice(0, 8)] }], window, index);
            assert.equal(result.dropped.length, 0);
            assert.match(result.content, /`rust\/sim\/`/);
            assert.deepEqual(result.accepted[0].commits.map(c => c.sha), [simCommit]);
        });

        it('drops an edit that cites no commit from the window', () => {
            const result = applyDocEdits('docs/repo-architecture.md', DOC, [{ ...addSim, commits: [docCommit] }], window, index);
            assert.equal(result.content, DOC);
            assert.match(result.dropped[0].reason, /cites no commit/);
        });

        it('drops an edit that adds a path, a name or a claim the repository does not have', () => {
            const edits = [
                edit({ oldText: row, newText: `${row}\n| \`lab\` | \`rust/lab/\` |`, commits: [simCommit], summary: 'Bad path.' }),
                edit({ oldText: row, newText: `${row} \`run_battles\``, commits: [simCommit], summary: 'Bad name.' }),
                edit({ oldText: row, newText: `${row} ok`, commits: [simCommit], claims: ['cargo run -p lab'], summary: 'Bad claim.' }),
            ];
            const result = applyDocEdits('docs/repo-architecture.md', DOC, edits, window, index);
            assert.equal(result.content, DOC);
            assert.deepEqual(result.dropped.map(d => d.summary), ['Bad path.', 'Bad name.', 'Bad claim.']);
            assert.match(result.dropped[2].reason, /no Cargo package `lab`/);
        });

        it('drops an edit whose oldText is not in the doc, and keeps the others', () => {
            const result = applyDocEdits('docs/repo-architecture.md', DOC, [
                edit({ oldText: 'not there', newText: 'x', commits: [renameCommit] }),
                { ...addSim, commits: [simCommit] },
            ], window, index);
            assert.equal(result.accepted.length, 1);
            assert.match(result.dropped[0].reason, /not found/);
        });

        it('drops an edit that would take the doc past the line budget', () => {
            const result = applyDocEdits('docs/repo-architecture.md', DOC, [{ ...addSim, commits: [simCommit] }], window, index, 0);
            assert.equal(result.content, DOC);
            assert.match(result.dropped[0].reason, /line budget/);
        });
    });

    describe('readDocsPRState()', () => {
        it('reports an open docs PR and the head of the latest rejected one, ignoring code-fix PRs', () => {
            const state = readDocsPRState([
                { number: 3, headRefName: 'janitor/architecture-docs-1', state: 'CLOSED', mergedAt: null, body: 'x\n\nArchitecture-Docs-Head: aaaaaaa1' },
                { number: 7, headRefName: 'janitor/architecture-docs-2', state: 'CLOSED', mergedAt: null, body: 'x\n\nArchitecture-Docs-Head: bbbbbbb2' },
                { number: 8, headRefName: 'janitor/architecture-docs-3', state: 'MERGED', mergedAt: '2026-10-01', body: 'Architecture-Docs-Head: ccccccc3' },
                { number: 9, headRefName: 'janitor/fix-thing-4', state: 'OPEN' },
            ]);
            assert.equal(state.open, null);
            assert.equal(state.rejectedHead, 'bbbbbbb2');
            assert.deepEqual(readDocsPRState([{ number: 10, url: 'u', headRefName: 'janitor/architecture-docs-5', state: 'OPEN' }]).open, { number: 10, url: 'u' });
        });
    });

    describe('buildDocsPRDescription()', () => {
        it('lists each change with the commit behind it, what was left out, and the head it covers', () => {
            const sim = window[0];
            const body = buildDocsPRDescription('f'.repeat(40), [{ doc: 'docs/repo-architecture.md', start: docCommit, commits: window }],
                [{ doc: 'docs/repo-architecture.md', summary: 'Add the sim crate.', commits: [sim] }],
                [{ doc: 'docs/repo-architecture.md', summary: 'Bad path.', reason: 'could not verify: x' }]);
            assert.match(body, new RegExp(`- Add the sim crate\\. Caused by ${sim.sha.slice(0, 12)} \\(Add the balance lab\\)\\.`));
            assert.match(body, /### Left out[\s\S]*Bad path\./);
            assert.match(body, /Commands were not run\./);
            assert.match(body, /\nArchitecture-Docs-Head: f{40}$/);
        });
    });
});
