import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    RepoIndex,
    extractDocItems,
    addedDocItems,
    looksLikePath,
    verifyCodeSpan,
    verifyCommand,
    verifyLink,
} from './archverify.js';

/** A small tracked repository: a Cargo workspace, an npm package, a Makefile and a doc. */
function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archverify-'));
    const files: Record<string, string> = {
        'rust/Cargo.toml': '[workspace]\nmembers = ["engine", "check-cards"]\n',
        'rust/engine/Cargo.toml': '[package]\nname = "engine"\n',
        'rust/engine/src/fight/turn.rs': 'pub struct GameState;\nimpl GameState { pub fn apply(&self) {} }\n',
        'rust/check-cards/Cargo.toml': '[package]\nname = "check-cards"\n',
        'rust/check-cards/src/main.rs': 'fn main() { route("/v1/account"); }\n',
        'cards/set1/1-spark.toml': 'id = 1\n',
        'web/package.json': JSON.stringify({ scripts: { build: 'node build.mjs', serve: 'node serve.mjs' } }),
        'scripts/lint.sh': '#!/bin/sh\n',
        'Makefile': 'prepare:\n\techo hi\nSCHEMA := x\n',
        'docs/repo-architecture.md': 'Only the doc says `DocOnlyName`.\n',
        'client/main.uid': 'uid://x\n',
    };
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', { cwd: dir });
    return dir;
}

describe('archverify', () => {
    let repo: string;
    let index: RepoIndex;
    before(() => {
        repo = makeRepo();
        index = new RepoIndex(repo);
    });
    after(() => fs.rmSync(repo, { recursive: true, force: true }));

    describe('extractDocItems()', () => {
        it('finds code spans, relative links and shell-fence lines, and skips other fences', () => {
            const md = [
                'See `rust/engine/` and ``a `tick` b``, and [the map](code-architecture.md#layers) or [web](https://x.dev).',
                '```bash',
                '$ cargo test  # all of it',
                '```',
                '```mermaid',
                'A --> B',
                '```',
            ].join('\n');
            assert.deepEqual(extractDocItems(md), [
                { kind: 'command', text: 'cargo test' },
                { kind: 'code', text: 'rust/engine/' },
                { kind: 'code', text: 'a `tick` b' },
                { kind: 'link', text: 'code-architecture.md#layers' },
            ]);
        });
    });

    describe('addedDocItems()', () => {
        it('returns only what the new text adds', () => {
            const added = addedDocItems('| `engine` | `rust/engine/` |', '| `engine` | `rust/engine/` |\n| `sim` | `rust/sim/` |');
            assert.deepEqual(added.map(i => i.text), ['sim', 'rust/sim/']);
        });

        it('counts repeats, so a second copy of an existing span is still checked', () => {
            assert.deepEqual(addedDocItems('`a/b`', '`a/b` and `a/b`').map(i => i.text), ['a/b']);
        });
    });

    describe('looksLikePath()', () => {
        it('tells paths from names and expressions', () => {
            assert.equal(looksLikePath('rust/engine/'), true);
            assert.equal(looksLikePath('build.rs'), true);
            assert.equal(looksLikePath('GameState'), false);
            assert.equal(looksLikePath('Rules::STANDARD'), false);
            assert.equal(looksLikePath('https://example.com/x'), false);
            assert.equal(looksLikePath('res://art/x.gd'), true);
        });
    });

    describe('RepoIndex.hasPath()', () => {
        it('finds files and directories from the root, with or without a trailing slash', () => {
            assert.equal(index.hasPath('rust/engine/'), true);
            assert.equal(index.hasPath('./scripts/lint.sh'), true);
            assert.equal(index.hasPath('rust/sim/'), false);
        });

        it('accepts the tail of a longer path, as a map names files under a heading', () => {
            assert.equal(index.hasPath('fight/turn.rs'), true);
            assert.equal(index.hasPath('fight/combat.rs'), false);
        });

        it('treats placeholders and globs as any name', () => {
            assert.equal(index.hasPath('cards/set<N>/<id>-<slug>.toml'), true);
            assert.equal(index.hasPath('cards/*/1-spark.toml'), true);
            assert.equal(index.hasPath('cards/set<N>/<id>.json'), false);
        });

        it('resolves relative to the doc directory', () => {
            assert.equal(index.hasPath('../web/package.json', 'docs'), true);
            assert.equal(index.hasPath('../nope.md', 'docs'), false);
        });
    });

    describe('verifyCodeSpan()', () => {
        it('accepts names found in the code and rejects names found only in Markdown', () => {
            assert.equal(verifyCodeSpan('GameState', index).ok, true);
            assert.equal(verifyCodeSpan('GameState::apply', index).ok, true);
            const docOnly = verifyCodeSpan('DocOnlyName', index);
            assert.equal(docOnly.ok, false);
            assert.match(docOnly.reason, /DocOnlyName/);
        });

        it('accepts a span found verbatim in the code, such as a route', () => {
            assert.equal(verifyCodeSpan('/v1/account', index).ok, true);
            assert.equal(verifyCodeSpan('/v1/nothing', index).ok, false);
        });

        it('rejects a path that does not exist', () => {
            assert.match(verifyCodeSpan('rust/sim/', index).reason, /not a path/);
        });

        it('checks a span that is a command as a command', () => {
            assert.equal(verifyCodeSpan('cargo run -p check-cards', index).ok, true);
            assert.equal(verifyCodeSpan('cargo run -p sim', index).ok, false);
        });

        it('accepts bare flags, and extensions some tracked file has', () => {
            assert.equal(verifyCodeSpan('--json', index).ok, true);
            assert.equal(verifyCodeSpan('.uid', index).ok, true);
            assert.equal(verifyCodeSpan('.import', index).ok, false);
        });
    });

    describe('verifyCommand()', () => {
        it('follows cd and checks Cargo packages', () => {
            assert.equal(verifyCommand('cd rust && cargo test -p engine', index).ok, true);
            assert.match(verifyCommand('cd rust && cargo test -p nope', index).reason, /no Cargo package `nope`/);
            assert.match(verifyCommand('cd nowhere && cargo test', index).reason, /no directory/);
        });

        it('checks repository scripts and path arguments', () => {
            assert.equal(verifyCommand('scripts/lint.sh --fix', index).ok, true);
            assert.match(verifyCommand('scripts/deploy.sh', index).reason, /no script/);
            assert.match(verifyCommand('node web/build.mjs', index).reason, /no path/);
        });

        it('checks npm scripts and make targets', () => {
            assert.equal(verifyCommand('cd web && npm run build', index).ok, true);
            assert.equal(verifyCommand('pnpm serve', index).ok, true);
            assert.equal(verifyCommand('pnpm install', index).ok, true);
            assert.match(verifyCommand('npm run deploy', index).reason, /no package.json script `deploy`/);
            assert.equal(verifyCommand('make prepare', index).ok, true);
            assert.match(verifyCommand('make schema', index).reason, /no make target/);
        });

        it('rejects a program that is neither a known tool nor named in the code', () => {
            assert.match(verifyCommand('frobnicate --all', index).reason, /neither a known tool/);
        });

        it('leaves git arguments alone and skips arguments after --', () => {
            assert.equal(verifyCommand('git rebase origin/main', index).ok, true);
            assert.equal(verifyCommand('cargo run -p engine -- some/thing', index).ok, true);
        });
    });

    describe('verifyLink()', () => {
        it('resolves links from the doc directory and ignores anchors', () => {
            assert.equal(verifyLink('repo-architecture.md#top', index, 'docs').ok, true);
            assert.equal(verifyLink('../web/package.json', index, 'docs').ok, true);
            assert.equal(verifyLink('design/missing.md', index, 'docs').ok, false);
            assert.match(verifyLink('../../outside.md', index, 'docs').reason, /outside the repository/);
        });
    });
});
