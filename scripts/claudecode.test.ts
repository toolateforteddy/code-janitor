import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoOutputGeneratedError } from 'ai';
import { z } from 'zod';
import {
    buildClaudeCodeArgs,
    buildClaudeCodeEnv,
    parseClaudeCodeOutput,
    generateWithClaudeCode,
} from './claudecode.js';
import { isQuotaExhaustedError, isTransientLlmError } from './retry.js';

const schema = z.object({ files: z.array(z.string()), reason: z.string() });

function result(fields: Record<string, unknown>): string {
    return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields });
}

describe('claudecode', () => {
    describe('buildClaudeCodeArgs()', () => {
        it('allows only the read-only tools, with a turn left over for the answer', () => {
            const args = buildClaudeCodeArgs({ jsonSchema: {}, system: 'sys', model: 'sonnet', allowTools: true, maxTurns: 5 });
            assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
            assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
            assert.equal(args[args.indexOf('--max-turns') + 1], '6');
            assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
            assert.ok(args.includes('--no-session-persistence'));
        });

        it('gives no tools at all when inspection is off, and leaves the model to Claude Code when unset', () => {
            const args = buildClaudeCodeArgs({ jsonSchema: {}, system: 'sys', model: '', allowTools: false, maxTurns: 5 });
            assert.equal(args[args.indexOf('--tools') + 1], '');
            assert.ok(!args.includes('--allowedTools'));
            assert.ok(!args.includes('--model'));
        });
    });

    describe('buildClaudeCodeEnv()', () => {
        it('drops the API key when a subscription token is present, so the subscription pays', () => {
            const env = buildClaudeCodeEnv({ ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_OAUTH_TOKEN: 'oat' });
            assert.equal(env.ANTHROPIC_API_KEY, undefined);
            assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oat');
        });

        it('drops an empty API key, which would otherwise shadow a local login', () => {
            assert.ok(!('ANTHROPIC_API_KEY' in buildClaudeCodeEnv({ ANTHROPIC_API_KEY: '' })));
        });

        it('keeps the API key when it is the only credential', () => {
            assert.equal(buildClaudeCodeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }).ANTHROPIC_API_KEY, 'sk-ant');
        });
    });

    describe('parseClaudeCodeOutput()', () => {
        it('returns the validated structured output', () => {
            const out = parseClaudeCodeOutput(schema, result({ structured_output: { files: ['a.ts'], reason: 'hi' } }));
            assert.deepEqual(out, { files: ['a.ts'], reason: 'hi' });
        });

        it('treats a missing or invalid answer as retryable', () => {
            for (const stdout of [
                result({}),
                result({ structured_output: { files: 'a.ts' } }),
                result({ subtype: 'error_max_turns', is_error: true }),
                'not json',
            ]) {
                assert.throws(() => parseClaudeCodeOutput(schema, stdout), (err: unknown) => {
                    assert.ok(NoOutputGeneratedError.isInstance(err));
                    assert.ok(isTransientLlmError(err));
                    return true;
                });
            }
        });

        it('reports a spent subscription as out of quota, so the fallback takes over', () => {
            const stdout = result({ subtype: 'error_during_execution', is_error: true, result: "You've hit your limit · resets 3pm" });
            assert.throws(() => parseClaudeCodeOutput(schema, stdout), (err: unknown) => {
                assert.ok(isQuotaExhaustedError(err));
                assert.ok(!isTransientLlmError(err));
                return true;
            });
        });
    });

    describe('generateWithClaudeCode()', () => {
        it('sends the prompt on stdin and runs in the workspace', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-claude-'));
            const fake = path.join(dir, 'claude');
            // Echoes the prompt and working directory back as the structured answer.
            fs.writeFileSync(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { files: [process.cwd()], reason: input } }));
});
`);
            fs.chmodSync(fake, 0o755);
            try {
                const out = await generateWithClaudeCode(schema, 'sys', 'the prompt', {
                    model: '', workDir: dir, allowTools: false, maxTurns: 1, command: fake,
                });
                assert.equal(out.reason, 'the prompt');
                assert.equal(fs.realpathSync(out.files[0]), fs.realpathSync(dir));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('says how to install the CLI when it is missing', async () => {
            await assert.rejects(
                generateWithClaudeCode(schema, 'sys', 'p', {
                    model: '', workDir: os.tmpdir(), allowTools: false, maxTurns: 1, command: '/nonexistent/claude',
                }),
                /Claude Code CLI on PATH/
            );
        });
    });
});
