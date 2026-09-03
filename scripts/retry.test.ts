import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError, RetryError, NoObjectGeneratedError } from 'ai';
import {
    isTransientLlmError,
    getRetryAfterMs,
    computeBackoffMs,
    withLlmRetry,
    MAX_RETRY_AFTER_MS,
} from './retry.js';

function apiError(statusCode?: number, extra: Record<string, any> = {}) {
    return new APICallError({
        message: extra.message || 'api failure',
        url: 'https://example.invalid/v1/messages',
        requestBodyValues: {},
        statusCode,
        ...extra,
    });
}

function noObjectError(extra: { text?: string; cause?: Error } = {}) {
    return new NoObjectGeneratedError({
        message: 'no object generated',
        response: { id: 'r1', timestamp: new Date(0), modelId: 'test-model' },
        usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
        },
        finishReason: 'stop',
        ...extra,
    });
}

describe('retry module test suite', () => {

    describe('isTransientLlmError()', () => {
        it('retries 5xx responses', () => {
            for (const status of [500, 502, 503, 504, 529]) {
                assert.equal(isTransientLlmError(apiError(status)), true, `status ${status}`);
            }
        });

        it('retries rate limiting and other temporary 4xx statuses', () => {
            for (const status of [408, 409, 425, 429]) {
                assert.equal(isTransientLlmError(apiError(status)), true, `status ${status}`);
            }
        });

        it('does not retry permanent client errors', () => {
            for (const status of [400, 401, 403, 404, 422]) {
                assert.equal(isTransientLlmError(apiError(status)), false, `status ${status}`);
            }
        });

        it('retries socket-level failures identified by error code', () => {
            for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
                const err = Object.assign(new Error('boom'), { code });
                assert.equal(isTransientLlmError(err), true, code);
            }
        });

        it('retries provider errors that only describe themselves in the message', () => {
            const messages = [
                'fetch failed',
                'socket hang up',
                'The model is overloaded. Please try again later.',
                'Rate limit exceeded',
                'Connection reset by peer',
                'Request timed out',
            ];
            for (const message of messages) {
                assert.equal(isTransientLlmError(new Error(message)), true, message);
            }
        });

        it('does not retry configuration mistakes', () => {
            assert.equal(isTransientLlmError(new Error('Invalid API key provided')), false);
            assert.equal(isTransientLlmError(new Error('No such model: gemini-9')), false);
            assert.equal(isTransientLlmError(undefined), false);
            assert.equal(isTransientLlmError(null), false);
        });

        it('unwraps a nested cause chain', () => {
            const err = new Error('request failed', { cause: apiError(503) });
            assert.equal(isTransientLlmError(err), true);
            const permanent = new Error('request failed', { cause: apiError(401) });
            assert.equal(isTransientLlmError(permanent), false);
        });

        it('judges a RetryError by the underlying failure', () => {
            const transient = new RetryError({
                message: 'exhausted',
                reason: 'maxRetriesExceeded',
                errors: [apiError(429)],
            });
            assert.equal(isTransientLlmError(transient), true);

            const permanent = new RetryError({
                message: 'aborted',
                reason: 'errorNotRetryable',
                errors: [apiError(401)],
            });
            assert.equal(isTransientLlmError(permanent), false);
        });

        it('retries unparseable structured output but not one caused by a rejected request', () => {
            const unparseable = noObjectError({ text: '{ "fixes": ' });
            assert.equal(isTransientLlmError(unparseable), true);

            const rejected = noObjectError({ cause: apiError(400) });
            assert.equal(isTransientLlmError(rejected), false);
        });

        it('stops unwrapping instead of looping on a self-referential cause', () => {
            const err: any = new Error('opaque failure');
            err.cause = err;
            assert.equal(isTransientLlmError(err), false);
        });
    });

    describe('getRetryAfterMs()', () => {
        it('reads delay-seconds form', () => {
            assert.equal(getRetryAfterMs(apiError(429, { responseHeaders: { 'retry-after': '3' } })), 3000);
        });

        it('prefers the millisecond header when present', () => {
            const err = apiError(429, { responseHeaders: { 'retry-after': '3', 'retry-after-ms': '1500' } });
            assert.equal(getRetryAfterMs(err), 1500);
        });

        it('reads the HTTP-date form relative to now', () => {
            const now = Date.parse('2026-01-01T00:00:00Z');
            const err = apiError(429, { responseHeaders: { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' } });
            assert.equal(getRetryAfterMs(err, now), 5000);
        });

        it('clamps absurd values and floors past dates at zero', () => {
            const huge = apiError(429, { responseHeaders: { 'retry-after': '86400' } });
            assert.equal(getRetryAfterMs(huge), MAX_RETRY_AFTER_MS);

            const now = Date.parse('2026-01-01T00:00:00Z');
            const past = apiError(429, { responseHeaders: { 'retry-after': 'Thu, 01 Jan 2020 00:00:00 GMT' } });
            assert.equal(getRetryAfterMs(past, now), 0);
        });

        it('returns null when absent or unparseable', () => {
            assert.equal(getRetryAfterMs(apiError(429)), null);
            assert.equal(getRetryAfterMs(apiError(429, { responseHeaders: { 'retry-after': 'soon' } })), null);
            assert.equal(getRetryAfterMs(new Error('plain')), null);
        });
    });

    describe('computeBackoffMs()', () => {
        it('grows exponentially and stays within the jitter window', () => {
            for (const attempt of [0, 1, 2, 3]) {
                const ceiling = Math.min(1000 * 2 ** attempt, 30000);
                const low = computeBackoffMs(attempt, 1000, 30000, null, () => 0);
                const high = computeBackoffMs(attempt, 1000, 30000, null, () => 1);
                assert.equal(low, Math.round(ceiling * 0.5));
                assert.equal(high, ceiling);
            }
        });

        it('caps the exponential growth at maxDelayMs', () => {
            assert.equal(computeBackoffMs(20, 1000, 30000, null, () => 1), 30000);
        });

        it('never returns less than the provider-requested retry-after', () => {
            assert.equal(computeBackoffMs(0, 1000, 30000, 12000, () => 0), 12000);
        });
    });

    describe('withLlmRetry()', () => {
        const noWait = { sleep: async () => {}, random: () => 1, baseDelayMs: 10, maxDelayMs: 100 };

        it('returns the result without sleeping when the first attempt succeeds', async () => {
            let calls = 0;
            let slept = 0;
            const result = await withLlmRetry(async () => { calls++; return 'ok'; }, {
                ...noWait,
                maxRetries: 3,
                sleep: async () => { slept++; },
            });
            assert.equal(result, 'ok');
            assert.equal(calls, 1);
            assert.equal(slept, 0);
        });

        it('retries a transient failure and returns the eventual success', async () => {
            let calls = 0;
            const delays: number[] = [];
            const result = await withLlmRetry(async () => {
                calls++;
                if (calls < 3) throw apiError(503);
                return 'recovered';
            }, {
                ...noWait,
                maxRetries: 3,
                sleep: async (ms: number) => { delays.push(ms); },
            });
            assert.equal(result, 'recovered');
            assert.equal(calls, 3);
            assert.deepEqual(delays, [10, 20]);
        });

        it('rethrows a permanent failure immediately', async () => {
            let calls = 0;
            await assert.rejects(
                withLlmRetry(async () => { calls++; throw apiError(401, { message: 'bad key' }); }, {
                    ...noWait,
                    maxRetries: 3,
                }),
                /bad key/
            );
            assert.equal(calls, 1);
        });

        it('gives up after maxRetries and rethrows the last error', async () => {
            let calls = 0;
            await assert.rejects(
                withLlmRetry(async () => { calls++; throw apiError(429, { message: 'slow down' }); }, {
                    ...noWait,
                    maxRetries: 2,
                }),
                /slow down/
            );
            assert.equal(calls, 3);
        });

        it('does not retry at all when maxRetries is zero', async () => {
            let calls = 0;
            await assert.rejects(
                withLlmRetry(async () => { calls++; throw apiError(503); }, { ...noWait, maxRetries: 0 }),
                /api failure/
            );
            assert.equal(calls, 1);
        });

        it('honours a retry-after header over the computed backoff', async () => {
            const delays: number[] = [];
            let calls = 0;
            await withLlmRetry(async () => {
                calls++;
                if (calls === 1) throw apiError(429, { responseHeaders: { 'retry-after': '2' } });
                return 'ok';
            }, {
                ...noWait,
                maxRetries: 2,
                sleep: async (ms: number) => { delays.push(ms); },
            });
            assert.deepEqual(delays, [2000]);
        });

        it('reports each retry through onRetry', async () => {
            const seen: number[] = [];
            let calls = 0;
            await withLlmRetry(async () => {
                calls++;
                if (calls < 3) throw new Error('fetch failed');
                return 'ok';
            }, {
                ...noWait,
                maxRetries: 3,
                onRetry: ({ attempt }) => { seen.push(attempt); },
            });
            assert.deepEqual(seen, [1, 2]);
        });
    });
});
