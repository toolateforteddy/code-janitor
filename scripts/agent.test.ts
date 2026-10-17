import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The agent flow runs only when claude-code is the active provider, which config.ts
// reads from the environment at import time; hence the dynamic imports below.
process.env.AI_PROVIDER = 'claude-code';
// Cleared so the fixtures' own `node --test` does not think it is nested in this runner, which makes it skip its files and pass.
process.env.TEST_CMD = 'env -u NODE_TEST_CONTEXT node --test';
process.env.LINT_CMD = '';
process.env.ENABLE_TEST_GEN = 'true';

const agent = await import('./agent.js');
const config = await import('./config.js');
const claudecode = await import('./claudecode.js');

function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-agent-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'math.js'), 'function average(xs) {\n    return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\nmodule.exports = { average };\n');
    fs.writeFileSync(path.join(dir, 'math.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { average } = require('./math');\ntest('average', () => assert.strictEqual(average([1, 2, 3]), 2));\n");
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: dir });
    return dir;
}

/**
 * A stand-in for the claude CLI: copies `math.js` from a fixture directory into the
 * working directory on each call, in order, then prints a report.
 */
function fakeClaude(dir: string, versions: string[]): string {
    const fixtures = path.join(dir, 'fixtures');
    fs.mkdirSync(fixtures);
    versions.forEach((content, i) => fs.writeFileSync(path.join(fixtures, `v${i}.js`), content));
    const counter = path.join(fixtures, 'calls');
    fs.writeFileSync(counter, '0');
    const script = path.join(dir, 'claude');
    fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf-8'));
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
const src = path.join(${JSON.stringify(fixtures)}, 'v' + n + '.js');
if (fs.existsSync(src)) fs.copyFileSync(src, path.join(process.cwd(), 'math.js'));
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, structured_output: { summary: 'pass ' + (n + 1), checksPassed: true } })));
`);
    fs.chmodSync(script, 0o755);
    return script;
}

const GOOD = 'function average(xs) {\n    if (xs.length === 0) return 0;\n    return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\nmodule.exports = { average };\n';
const BROKEN = 'function average(xs) {\n    return xs.reduce((a, b) => a + b, 0) / (xs.length + 1);\n}\nmodule.exports = { average };\n';
function mk(root: string, name: string): string {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    return d;
}

const FIX = { slug: 'avg-empty', title: 'Handle empty input', description: 'Return 0 for [].', plannedFiles: ['math.js'] };

describe('agent', () => {
    let dir: string;
    let fake: string;
    before(() => { fake = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-fake-')); });
    after(() => fs.rmSync(fake, { recursive: true, force: true }));

    it('gives the agent edits inside the worktree and the verify script as its only command', () => {
        const args = claudecode.buildClaudeCodeArgs({ jsonSchema: {}, system: 's', model: '', allowTools: true, maxTurns: 40, agent: { verifyCommand: '/tmp/v/verify.sh' } });
        assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write,Bash');
        assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Bash(/tmp/v/verify.sh)');
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    });

    it('marks a planned fix apart from one that carries its code, and dedupes on its planned files', () => {
        assert.ok(config.isPlannedFix(FIX));
        assert.ok(!config.isPlannedFix({ slug: 's', title: 't', description: 'd', changes: [{ filePath: 'a.js', updatedContent: 'x' }] }));
        assert.deepEqual(config.proposalFilePaths(FIX), ['math.js']);
    });

    it('collects only what changed after the baseline, with each file at HEAD', () => {
        dir = repo();
        try {
            fs.writeFileSync(path.join(dir, 'node_modules'), 'linked before the agent ran');
            const baseline = new Set(agent.listChangedPaths(dir));
            fs.writeFileSync(path.join(dir, 'math.js'), GOOD);
            fs.mkdirSync(path.join(dir, 'lib'));
            fs.writeFileSync(path.join(dir, 'lib', 'new.js'), 'module.exports = 1;\n');
            const { changes, originalContents } = agent.collectAgentChanges(dir, baseline);
            assert.deepEqual(changes.map(c => c.filePath).sort(), ['lib/new.js', 'math.js']);
            assert.equal(originalContents.get('lib/new.js'), '');
            assert.ok(originalContents.get('math.js')!.includes('xs.length;'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('accepts a change only once the janitor has run the tests itself', async () => {
        dir = repo();
        try {
            const outcome = await agent.implementFixWithAgent(FIX, dir, { command: fakeClaude(mk(fake, 'a'), [GOOD]) });
            assert.equal(outcome.success, true);
            assert.deepEqual(outcome.changes.map(c => c.filePath), ['math.js']);
            assert.equal(outcome.summary, 'pass 1');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('hands a failing check back for one more pass, and gives up after it', async () => {
        dir = repo();
        try {
            const recovered = await agent.implementFixWithAgent(FIX, dir, { command: fakeClaude(mk(fake, 'b'), [BROKEN, GOOD]) });
            assert.equal(recovered.success, true);
            assert.equal(recovered.summary, 'pass 2');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        dir = repo();
        try {
            const failed = await agent.implementFixWithAgent(FIX, dir, { command: fakeClaude(mk(fake, 'c'), [BROKEN, BROKEN, GOOD]) });
            assert.equal(failed.success, false);
            assert.equal(failed.failedStep, 'test');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports an untouched worktree as no changes, without a second pass', async () => {
        dir = repo();
        try {
            const outcome = await agent.implementFixWithAgent(FIX, dir, { command: fakeClaude(mk(fake, 'd'), []) });
            assert.equal(outcome.failedStep, 'no-changes');
            assert.equal(fs.readFileSync(path.join(fake, 'd', 'fixtures', 'calls'), 'utf-8'), '1');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes a verify script outside the worktree that runs the configured checks', () => {
        dir = repo();
        const verify = agent.writeVerifyScript(dir, '', process.env.TEST_CMD!);
        try {
            assert.ok(!verify.command.startsWith(dir));
            const out = execFileSync(verify.command, { encoding: 'utf-8' });
            assert.match(out, /all checks passed/);
        } finally {
            verify.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
        assert.ok(!fs.existsSync(verify.command));
    });

    it('stamps the exact state a verify run passed on, and clears the stamp when a run fails', () => {
        dir = repo();
        const verify = agent.writeVerifyScript(dir, '', process.env.TEST_CMD!);
        try {
            fs.writeFileSync(path.join(dir, 'math.js'), GOOD);
            assert.equal(verify.passedFingerprint(), null);
            execFileSync(verify.command, { stdio: 'pipe' });
            const passed = verify.passedFingerprint();
            assert.ok(passed);
            assert.equal(passed, verify.currentFingerprint());

            // Any edit after the passing run, untracked files included, moves the state off the stamp.
            fs.writeFileSync(path.join(dir, 'extra.js'), '// new\n');
            assert.notEqual(verify.currentFingerprint(), passed);

            fs.writeFileSync(path.join(dir, 'math.js'), BROKEN);
            assert.throws(() => execFileSync(verify.command, { stdio: 'pipe' }));
            assert.equal(verify.passedFingerprint(), null);
        } finally {
            verify.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skips its own test run only with trust_claude_checks on and a stamp matching the files', () => {
        dir = repo();
        // The agent's verify run checks nothing, so a skipped janitor run is the only way BROKEN can pass.
        const verify = agent.writeVerifyScript(dir, '', 'true');
        try {
            const baseline = new Set<string>();
            fs.writeFileSync(path.join(dir, 'math.js'), BROKEN);
            execFileSync(verify.command, { stdio: 'pipe' });

            assert.equal(agent.checkAgentChanges(dir, baseline, verify, true).success, true);
            assert.equal(agent.checkAgentChanges(dir, baseline, verify, false).failedStep, 'test');
            assert.ok(!config.trustClaudeChecks, 'trust_claude_checks is off by default');

            // Edited after the passing run: the janitor checks it itself.
            fs.appendFileSync(path.join(dir, 'math.js'), '// later\n');
            assert.equal(agent.checkAgentChanges(dir, baseline, verify, true).failedStep, 'test');
        } finally {
            verify.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
