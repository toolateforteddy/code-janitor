import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { ModelFallback, resolveFallbackChoice, ModelChoice } from './fallback.js';

const CLAUDE: ModelChoice = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const GEMINI: ModelChoice = { provider: 'google', model: 'gemini-3.6-flash' };

function quotaError(message = 'Your credit balance is too low to access the API') {
    return new APICallError({
        message,
        url: 'https://api.anthropic.com/v1/messages',
        requestBodyValues: {},
        statusCode: 429,
    });
}

function silent(): ModelFallback {
    return new ModelFallback({ primary: CLAUDE, fallback: GEMINI, onSwitch: () => { } });
}

describe('fallback module test suite', () => {

    describe('resolveFallbackChoice()', () => {
        it('returns null when no fallback provider is configured', () => {
            assert.equal(resolveFallbackChoice(CLAUDE, '', 'gemini-3.6-flash'), null);
        });

        it('returns the configured provider/model pair', () => {
            assert.deepEqual(resolveFallbackChoice(CLAUDE, 'google', 'gemini-3.6-flash'), GEMINI);
        });

        it('allows an empty model so the provider default applies', () => {
            assert.deepEqual(resolveFallbackChoice(CLAUDE, 'google', ''), { provider: 'google', model: '' });
        });

        it('treats a fallback identical to the primary as absent', () => {
            assert.equal(resolveFallbackChoice(CLAUDE, 'anthropic', 'claude-sonnet-4-5'), null);
        });

        it('keeps a same-provider fallback that names a different model', () => {
            assert.deepEqual(resolveFallbackChoice(CLAUDE, 'anthropic', 'claude-haiku-4-5'), {
                provider: 'anthropic',
                model: 'claude-haiku-4-5',
            });
        });
    });

    describe('ModelFallback.run()', () => {
        it('uses the primary model while it works', async () => {
            const fb = silent();
            const used: ModelChoice[] = [];
            const result = await fb.run(async choice => { used.push(choice); return 'ok'; });
            assert.equal(result, 'ok');
            assert.deepEqual(used, [CLAUDE]);
            assert.equal(fb.switched, false);
        });

        it('switches to the fallback when the primary is out of tokens', async () => {
            const fb = silent();
            const used: ModelChoice[] = [];
            const result = await fb.run(async choice => {
                used.push(choice);
                if (choice.provider === 'anthropic') throw quotaError();
                return 'from-gemini';
            });
            assert.equal(result, 'from-gemini');
            assert.deepEqual(used, [CLAUDE, GEMINI]);
            assert.equal(fb.switched, true);
        });

        it('keeps using the fallback for later calls without re-trying the primary', async () => {
            const fb = silent();
            const used: ModelChoice[] = [];
            const op = async (choice: ModelChoice) => {
                used.push(choice);
                if (choice.provider === 'anthropic') throw quotaError();
                return 'from-gemini';
            };
            await fb.run(op);
            await fb.run(op);
            assert.deepEqual(used, [CLAUDE, GEMINI, GEMINI]);
        });

        it('reports the switch exactly once', async () => {
            const switches: string[] = [];
            const fb = new ModelFallback({
                primary: CLAUDE,
                fallback: GEMINI,
                onSwitch: ({ from, to }) => switches.push(`${from.provider}->${to.provider}`),
            });
            const op = async (choice: ModelChoice) => {
                if (choice.provider === 'anthropic') throw quotaError();
                return 'ok';
            };
            await fb.run(op);
            await fb.run(op);
            assert.deepEqual(switches, ['anthropic->google']);
        });

        it('rethrows non-quota failures instead of burning the fallback', async () => {
            const fb = silent();
            let calls = 0;
            await assert.rejects(
                fb.run(async () => { calls++; throw new Error('model is overloaded'); }),
                /overloaded/
            );
            assert.equal(calls, 1);
            assert.equal(fb.switched, false);
        });

        it('rethrows when the fallback is exhausted too', async () => {
            const fb = silent();
            const used: ModelChoice[] = [];
            await assert.rejects(
                fb.run(async choice => { used.push(choice); throw quotaError(); }),
                /credit balance/
            );
            assert.deepEqual(used, [CLAUDE, GEMINI]);
        });

        it('rethrows the quota error when no fallback is configured', async () => {
            const fb = new ModelFallback({ primary: CLAUDE, fallback: null });
            let calls = 0;
            await assert.rejects(
                fb.run(async () => { calls++; throw quotaError(); }),
                /credit balance/
            );
            assert.equal(calls, 1);
            assert.equal(fb.hasFallback, false);
            assert.equal(fb.fallbackLabel, '');
        });
    });

    describe('labels', () => {
        it('describes the fallback as provider/model', () => {
            assert.equal(silent().fallbackLabel, 'google/gemini-3.6-flash');
        });

        it('names an empty fallback model as the provider default', () => {
            const fb = new ModelFallback({ primary: CLAUDE, fallback: { provider: 'google', model: '' } });
            assert.equal(fb.fallbackLabel, 'google/default');
        });
    });
});
