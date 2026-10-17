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
    readClaudeCodeUsage,
    resolveClaudeCodeCommand,
} from './claudecode.js';
import { buildProposalPrompts, selectPrompt, isLoadedByClaudeCode, formatFilesToRead } from './ai.js';
import { resolveMaxConcurrency, resolveTriageModel } from './config.js';
import { createRunSummary, setSummary, recordClaudeCodeUsage, renderSummary, getSummary } from './summary.js';
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

        it('removes the line breaks a terminal-wrapped token picks up when pasted', () => {
            const env = buildClaudeCodeEnv({ CLAUDE_CODE_OAUTH_TOKEN: '  sk-ant-oat01-abc\r\ndef\n  ghi \n' });
            assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-abcdefghi');
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

        it('runs the CLI entry point with Node on Windows, where npm installs a .cmd shim', () => {
            assert.deepEqual(resolveClaudeCodeCommand('linux', () => { throw new Error('unused'); }), { file: 'claude', args: [] });
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-npmroot-'));
            try {
                const cli = path.join(root, '@anthropic-ai', 'claude-code', 'cli.js');
                fs.mkdirSync(path.dirname(cli), { recursive: true });
                fs.writeFileSync(cli, '');
                assert.deepEqual(resolveClaudeCodeCommand('win32', () => root), { file: process.execPath, args: [cli] });
                // Not installed through npm: leave it to whatever `claude` is on PATH.
                assert.deepEqual(resolveClaudeCodeCommand('win32', () => path.join(root, 'none')), { file: 'claude', args: [] });
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
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

    describe('saving subscription allowance', () => {
        function workspace(files: Record<string, string>): string {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-lean-'));
            for (const [rel, content] of Object.entries(files)) {
                fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
                fs.writeFileSync(path.join(dir, rel), content);
            }
            return dir;
        }

        it('knows which agent files Claude Code loads itself', () => {
            assert.ok(isLoadedByClaudeCode('CLAUDE.md'));
            assert.ok(isLoadedByClaudeCode('.claude/CLAUDE.md'));
            assert.ok(!isLoadedByClaudeCode('AGENTS.md'));
            // Nested ones load only when Claude happens to read in that folder, so they stay in the prompt.
            assert.ok(!isLoadedByClaudeCode('apps/web/CLAUDE.md'));
        });

        it('lists files by path for claude-code but pastes them for everyone else', () => {
            const dir = workspace({ 'CLAUDE.md': 'ROOT-RULES', 'AGENTS.md': 'AGENT-RULES' });
            try {
                const parts = {
                    lead: 'DIFF',
                    workDir: dir,
                    agentContexts: '--- CLAUDE.md ---\nROOT-RULES\n--- AGENTS.md ---\nAGENT-RULES',
                    sourceHeading: 'Full contents',
                    sourcePaths: ['src/a.ts'],
                    sourceContexts: 'SOURCE-BODY',
                    testPaths: ['src/a.test.ts'],
                    testContexts: 'TEST-BODY',
                    existingPRContext: '\n\nPRS',
                    canRead: true,
                };
                const { full, claudeCode } = buildProposalPrompts(parts);
                for (const text of ['DIFF', 'ROOT-RULES', 'AGENT-RULES', 'SOURCE-BODY', 'TEST-BODY', 'PRS']) {
                    assert.ok(full.includes(text), `full prompt is missing ${text}`);
                }
                assert.ok(claudeCode.includes('AGENT-RULES'));
                assert.ok(claudeCode.includes('- src/a.ts') && claudeCode.includes('- src/a.test.ts'));
                assert.ok(claudeCode.includes('PRS'));
                for (const text of ['ROOT-RULES', 'SOURCE-BODY', 'TEST-BODY']) {
                    assert.ok(!claudeCode.includes(text), `claude-code prompt should not paste ${text}`);
                }

                // Without tools Claude cannot open the files, so they are pasted after all.
                const noTools = buildProposalPrompts({ ...parts, canRead: false }).claudeCode;
                assert.ok(noTools.includes('SOURCE-BODY') && noTools.includes('TEST-BODY'));
                assert.ok(!noTools.includes('ROOT-RULES'));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('picks the prompt for whichever provider is serving', () => {
            const variants = { full: 'FULL', claudeCode: 'LEAN' };
            assert.equal(selectPrompt(variants, 'claude-code'), 'LEAN');
            assert.equal(selectPrompt(variants, 'google'), 'FULL');
            assert.equal(selectPrompt('ONLY', 'claude-code'), 'ONLY');
            assert.equal(formatFilesToRead('Files', []), '');
        });

        it('defaults triage to haiku and fixes to one at a time on claude-code only', () => {
            assert.equal(resolveTriageModel('claude-code', ''), 'haiku');
            assert.equal(resolveTriageModel('claude-code', 'sonnet'), 'sonnet');
            assert.equal(resolveTriageModel('google', ''), '');
            assert.equal(resolveTriageModel('google', 'gemini-lite'), 'gemini-lite');

            assert.equal(resolveMaxConcurrency('claude-code', ''), 1);
            assert.equal(resolveMaxConcurrency('claude-code', '4'), 4);
            assert.equal(resolveMaxConcurrency('google', undefined), 3);
            assert.equal(resolveMaxConcurrency('google', '0'), 3);
        });

        it('reads usage off a result, cached input included', () => {
            const usage = readClaudeCodeUsage(result({
                num_turns: 3,
                total_cost_usd: 0.05,
                usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 4000, output_tokens: 80 },
            }));
            assert.deepEqual(usage, { requests: 1, turns: 3, inputTokens: 4210, outputTokens: 80, cacheReadTokens: 4000, costUsd: 0.05 });
            assert.equal(readClaudeCodeUsage('not json'), null);
        });

        it('totals usage into the job summary, and shows nothing when Claude Code was not used', () => {
            setSummary(createRunSummary('claude-code', 'sonnet', 'auto'));
            assert.ok(!renderSummary(getSummary()).includes('Claude Code usage'));
            recordClaudeCodeUsage({ requests: 1, turns: 2, inputTokens: 1500, outputTokens: 100, cacheReadTokens: 1000, costUsd: 0.25 });
            recordClaudeCodeUsage({ requests: 1, turns: 1, inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, costUsd: 0.5 });
            const row = renderSummary(getSummary()).split('\n').find(line => line.includes('Claude Code usage'));
            assert.equal(row, '| Claude Code usage | 2 request(s), 3 turn(s), 2.0k in (1.0k cached) / 150 out, ~$0.75 at API prices |');
        });

        it('reports usage even when the answer was unusable', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-claude-'));
            const fake = path.join(dir, 'claude');
            fs.writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, usage: { output_tokens: 7 } })));
`);
            fs.chmodSync(fake, 0o755);
            const seen: number[] = [];
            try {
                await assert.rejects(generateWithClaudeCode(schema, 'sys', 'p', {
                    model: '', workDir: dir, allowTools: false, maxTurns: 1, command: fake,
                    onUsage: usage => seen.push(usage.outputTokens),
                }));
                assert.deepEqual(seen, [7]);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
