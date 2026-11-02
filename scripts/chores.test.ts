import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHORES_DIR, fixLineBudget, maxLineDiff, maxTestLineDiff } from './config.js';
import {
    parseChore,
    loadChores,
    listMatchingFiles,
    countLines,
    planChoreTasks,
    filterCoveredChoreTasks,
    choreRef,
    choreTitle,
    Chore,
} from './chores.js';
import { validateFixIntegrity, integrityOptionsFor } from './integrity.js';
import { describeChoreForPR } from './pr.js';
import { ExistingJanitorPR, extractSlugFromBranch } from './dedupe.js';

/** A git repo holding `files`, all committed. */
function makeRepo(files: Record<string, string>): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-chores-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return repo;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `var x${i} = ${i}`).join('\n') + '\n';

const SPLIT = `
title = "Split long GDScript files"
instructions = "Split along the file's natural seams."
files = ["client/**/*.gd"]
max_lines = 750
max_line_diff = 800
`;

function chore(overrides: Partial<Chore> = {}): Chore {
    return { name: 'split-long-gdscript', source: `${CHORES_DIR}/split-long-gdscript.toml`, instructions: 'Split it.', files: ['client/**/*.gd'], ...overrides };
}

describe('chores', () => {
    describe('parseChore()', () => {
        it('reads a chore with a line trigger and its own budget', () => {
            const parsed = parseChore('split', 'x.toml', SPLIT);
            assert.equal(parsed.max_lines, 750);
            assert.equal(parsed.max_line_diff, 800);
            assert.deepEqual(parsed.files, ['client/**/*.gd']);
        });

        it('rejects a misspelt key rather than silently ignoring it', () => {
            assert.throws(() => parseChore('c', 'c.toml', 'instructions = "x"\nfiles = ["a"]\nmax_line = 5\n'), /max_line/);
        });

        it('requires instructions and at least one file pattern', () => {
            assert.throws(() => parseChore('c', 'c.toml', 'files = ["a"]\n'), /instructions/);
            assert.throws(() => parseChore('c', 'c.toml', 'instructions = "x"\nfiles = []\n'), /files/);
        });

        it('refuses once together with max_lines', () => {
            assert.throws(() => parseChore('c', 'c.toml', 'instructions = "x"\nfiles = ["a"]\nonce = true\nmax_lines = 3\n'), /cannot be combined/);
        });

        it('reports TOML syntax errors with the file name', () => {
            assert.throws(() => parseChore('c', 'c.toml', 'instructions = '), /c\.toml is not valid TOML/);
        });
    });

    describe('loadChores()', () => {
        it('loads every .toml in the chores folder, in name order, and reports the broken ones', () => {
            const repo = makeRepo({
                [`${CHORES_DIR}/b.toml`]: 'instructions = "b"\nfiles = ["b"]\n',
                [`${CHORES_DIR}/a.toml`]: 'instructions = "a"\nfiles = ["a"]\n',
                [`${CHORES_DIR}/bad.toml`]: 'nope = 1\n',
                [`${CHORES_DIR}/README.md`]: 'not a chore',
            });
            const { chores, errors } = loadChores(repo);
            assert.deepEqual(chores.map(c => c.name), ['a', 'b']);
            assert.equal(chores[0].source, `${CHORES_DIR}/a.toml`);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /bad\.toml/);
        });

        it('returns nothing for a repo without chores', () => {
            assert.deepEqual(loadChores(makeRepo({ 'a.txt': 'a' })), { chores: [], errors: [] });
        });
    });

    describe('countLines()', () => {
        it('counts a last line with or without its newline', () => {
            assert.equal(countLines(''), 0);
            assert.equal(countLines('a'), 1);
            assert.equal(countLines('a\n'), 1);
            assert.equal(countLines('a\nb'), 2);
        });
    });

    describe('listMatchingFiles()', () => {
        it('treats ** as crossing directories and a plain path as itself', () => {
            const repo = makeRepo({ 'client/main.gd': 'x\n', 'client/ui/fight.gd': 'x\n', 'client/ui/fight.tscn': 'x\n', 'other.gd': 'x\n' });
            assert.deepEqual(listMatchingFiles(['client/**/*.gd'], repo), ['client/main.gd', 'client/ui/fight.gd']);
            assert.deepEqual(listMatchingFiles(['client/ui/fight.gd'], repo), ['client/ui/fight.gd']);
        });
    });

    describe('planChoreTasks()', () => {
        const repo = makeRepo({
            'client/ui/fight.gd': lines(751),
            'client/ui/deck.gd': lines(750),
            'client/main.gd': lines(10),
        });

        it('makes one task per file over max_lines, whatever the window holds', () => {
            const tasks = planChoreTasks([chore({ max_lines: 750 })], [], repo);
            assert.deepEqual(tasks.map(t => t.files), [['client/ui/fight.gd']]);
            assert.equal(tasks[0].slug, 'chore-split-long-gdscript-client-ui-fight-gd');
            assert.match(tasks[0].reason, /751 lines/);
        });

        it('a once chore applies to every matching file', () => {
            const tasks = planChoreTasks([chore({ once: true, files: ['client/ui/*.gd'] })], [], repo);
            assert.deepEqual(tasks[0].files, ['client/ui/deck.gd', 'client/ui/fight.gd']);
        });

        it('a chore with no trigger applies only to files the window changed', () => {
            assert.deepEqual(planChoreTasks([chore()], [], repo), []);
            const tasks = planChoreTasks([chore()], ['client/main.gd', 'README.md'], repo);
            assert.deepEqual(tasks[0].files, ['client/main.gd']);
        });

        it('a once chore caps its task at five files', () => {
            const many = makeRepo(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`client/f${i}.gd`, 'x\n'])));
            const tasks = planChoreTasks([chore({ once: true })], [], many);
            assert.equal(tasks.length, 1);
            assert.equal(tasks[0].files.length, 5);
        });

        it('a max_lines chore skips files at the limit and gives each over-limit file its own slug', () => {
            const r = makeRepo({ 'client/a.gd': lines(5), 'client/b.gd': lines(6), 'client/c.gd': lines(7) });
            const tasks = planChoreTasks([chore({ max_lines: 5 })], [], r);
            assert.deepEqual(tasks.map(t => t.files), [['client/b.gd'], ['client/c.gd']]);
            assert.equal(new Set(tasks.map(t => t.slug)).size, 2);
        });

        it('a chore with no trigger and no changed files yields no tasks', () => {
            assert.deepEqual(planChoreTasks([chore()], [], makeRepo({ 'client/a.gd': lines(3) })), []);
        });
    });

    describe('filterCoveredChoreTasks()', () => {
        it('skips a task whose branch an existing janitor PR already uses', () => {
            const repo = makeRepo({ 'client/a.gd': lines(5), 'client/b.gd': lines(5) });
            const tasks = planChoreTasks([chore({ max_lines: 1 })], [], repo);
            const branch = `janitor/${tasks[0].slug}-1793452292850`;
            const existing: ExistingJanitorPR = { number: 1, title: 't', headRefName: branch, slug: extractSlugFromBranch(branch), files: [], state: 'open' };
            const result = filterCoveredChoreTasks(tasks, [existing]);
            assert.deepEqual(result.tasks.map(t => t.files[0]), ['client/b.gd']);
            assert.equal(result.covered.length, 1);
        });

        it('matches slugs after normalizing case and punctuation', () => {
            const repo = makeRepo({ 'client/a.gd': lines(5) });
            const tasks = planChoreTasks([chore({ max_lines: 1 })], [], repo);
            const messy = tasks[0].slug.toUpperCase().replace(/-/g, '_');
            const existing: ExistingJanitorPR = { number: 2, title: 't', headRefName: `janitor/${messy}`, slug: messy, files: [], state: 'open' };
            const result = filterCoveredChoreTasks(tasks, [existing]);
            assert.equal(result.tasks.length, 0);
            assert.equal(result.covered.length, 1);
        });
    });

    describe('proposals from chores', () => {
        const task = { chore: chore({ max_lines: 750, max_line_diff: 800, once: false }), files: ['client/ui/fight.gd'], slug: 's', reason: 'r' };

        it('carry the chore budget, falling back to the configured one', () => {
            assert.deepEqual(fixLineBudget({ slug: 's', title: 't', description: 'd', chore: choreRef(task) }), { production: 800, test: maxTestLineDiff });
            assert.deepEqual(fixLineBudget({ slug: 's', title: 't', description: 'd' }), { production: maxLineDiff, test: maxTestLineDiff });
        });

        it('are titled by the chore and the file', () => {
            assert.equal(choreTitle(task), 'split long gdscript: client/ui/fight.gd');
            assert.equal(choreTitle({ ...task, chore: { ...task.chore, title: 'Split' } }), 'Split: client/ui/fight.gd');
        });

        it('may move code out of their target file, but not out of any other', () => {
            const fix = { slug: 's', title: 't', description: 'd', chore: choreRef(task) };
            const original = 'class A {}\nclass B {}\n' + 'x\n'.repeat(40);
            const orig = new Map([['client/ui/fight.gd', original], ['client/ui/other.ts', original]]);
            const split = validateFixIntegrity(orig, [{ filePath: 'client/ui/fight.gd', updatedContent: 'class A {}\n' }], undefined, integrityOptionsFor(fix));
            assert.ok(split.valid, split.reason);
            const elsewhere = validateFixIntegrity(orig, [{ filePath: 'client/ui/other.ts', updatedContent: 'class A {}\n' }], undefined, integrityOptionsFor(fix));
            assert.ok(!elsewhere.valid);
        });

        it('say in the PR which chore they do, and that a one-off is deleted', () => {
            const once = { slug: 's', title: 't', description: 'd', chore: { ...choreRef(task), once: true } };
            assert.match(describeChoreForPR(once), /split-long-gdscript.*deletes that file/s);
            assert.equal(describeChoreForPR({ slug: 's', title: 't', description: 'd' }), '');
        });
    });
});
