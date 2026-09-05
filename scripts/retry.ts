import { APICallError, RetryError, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';

/**
 * HTTP statuses that are worth another attempt even though the provider answered.
 * 5xx is handled separately (any server-side failure is retryable); these are the
 * 4xx statuses that describe a temporary condition rather than a bad request.
 */
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);

/** Node/undici socket-level failures. None of these mean the request was rejected on merit. */
const RETRYABLE_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'EAI_AGAIN',
    'ERR_STREAM_PREMATURE_CLOSE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
]);

/**
 * Last-resort matching for providers that surface transient failures as plain
 * `Error`s with no status code or error code attached (common for Gemini's
 * "model is overloaded" and for fetch-layer aborts).
 */
const RETRYABLE_MESSAGE_PATTERNS = [
    /fetch failed/i,
    /socket hang ?up/i,
    /network (error|failure)/i,
    /premature close/i,
    /connection (reset|closed|error|refused)/i,
    /timed ?out/i,
    /\btimeout\b/i,
    /overloaded/i,
    /rate.?limit/i,
    /too many requests/i,
    /temporarily unavailable/i,
    /service unavailable/i,
    /internal (server )?error/i,
    /bad gateway/i,
    /gateway timeout/i,
    /try again/i,
];

/**
 * Statuses that mean "you are out of budget", not "slow down". 402 is the only status
 * that says so on its own; an exhausted allowance otherwise arrives as a 429 and is
 * recognized by its wording below.
 */
const QUOTA_STATUS_CODES = new Set([402]);

/** Provider-specific error codes for an exhausted balance/quota. */
const QUOTA_ERROR_CODES = new Set([
    'insufficient_quota',
    'billing_hard_limit_reached',
    'credit_limit_exceeded',
]);

/**
 * Phrases that separate an exhausted allowance from an ordinary rate limit. Both
 * arrive as 429s, so the wording is the only signal: a rate limit clears on its own
 * within seconds, an exhausted balance does not clear for the rest of the run.
 */
const QUOTA_MESSAGE_PATTERNS = [
    /insufficient[_ ]quota/i,
    /quota[_ ]exceeded/i,
    /exceeded your (current )?quota/i,
    /(credit|token)s? (balance )?(is |are )?(too low|exhausted|depleted)/i,
    /credit balance is too low/i,
    /out of (credits|tokens)/i,
    /no (remaining )?credits/i,
    /billing[_ ]hard[_ ]limit/i,
    /(usage|spend|billing|daily|monthly|weekly) limits? (has |have )?(been )?(reached|exceeded)/i,
    /exceeded your (usage|monthly|daily|weekly) limit/i,
    /purchase (more )?credits/i,
    /payment required/i,
    /upgrade your plan/i,
    /plan limit reached/i,
];

/**
 * True when `err` says the account has run out of tokens/credits/quota rather than
 * merely being throttled. These do not clear by waiting, so they must not be retried;
 * they are the trigger for switching to the backup model (see fallback.ts).
 */
export function isQuotaExhaustedError(err: unknown, depth = 0): boolean {
    if (!err || depth > 5) return false;

    if (RetryError.isInstance(err)) {
        return isQuotaExhaustedError(err.lastError ?? err.errors?.[err.errors.length - 1], depth + 1);
    }

    if (isApiCallError(err)) {
        if (typeof err.statusCode === 'number' && QUOTA_STATUS_CODES.has(err.statusCode)) return true;
        // The provider's own JSON body carries the distinguishing wording far more often
        // than the SDK's flattened message does.
        if (typeof err.responseBody === 'string' && matchesQuotaText(err.responseBody)) return true;
    }

    const candidate = err as { code?: unknown; type?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && QUOTA_ERROR_CODES.has(candidate.code)) return true;
    if (typeof candidate.type === 'string' && QUOTA_ERROR_CODES.has(candidate.type)) return true;
    if (typeof candidate.message === 'string' && matchesQuotaText(candidate.message)) return true;

    return isQuotaExhaustedError(candidate.cause, depth + 1);
}

function matchesQuotaText(text: string): boolean {
    return QUOTA_MESSAGE_PATTERNS.some(pattern => pattern.test(text));
}

/** Cap on how long a provider-supplied `retry-after` may park us for. */
export const MAX_RETRY_AFTER_MS = 60_000;

function isApiCallError(err: unknown): err is APICallError {
    return APICallError.isInstance(err);
}

/**
 * True when `err` looks like a temporary provider/transport failure rather than a
 * permanent one (bad API key, malformed request, unknown model). Unwraps the
 * `RetryError`/`cause` chains the AI SDK wraps provider errors in.
 */
export function isTransientLlmError(err: unknown, depth = 0): boolean {
    if (!err || depth > 5) return false;

    // An exhausted balance answers with the same 429 as a rate limit but never clears,
    // so retrying it just burns the backoff budget before the run fails anyway.
    // Checked once at the top level: the recursion below walks the same cause chain.
    if (depth === 0 && isQuotaExhaustedError(err)) return false;

    // The SDK's own retry loop reports exhaustion as a RetryError; judge the underlying failure.
    if (RetryError.isInstance(err)) {
        return isTransientLlmError(err.lastError ?? err.errors?.[err.errors.length - 1], depth + 1);
    }

    if (isApiCallError(err)) {
        const status = err.statusCode;
        if (typeof status === 'number') {
            return status >= 500 || RETRYABLE_STATUS_CODES.has(status);
        }
        // No status means the request never completed (DNS, TLS, socket), which the
        // SDK already flags via isRetryable.
        return err.isRetryable === true || isTransientLlmError(err.cause, depth + 1);
    }

    // The model answered but the answer did not parse/validate against the schema.
    // Re-sampling usually fixes it — unless the underlying cause was a hard API
    // rejection, in which case the cause decides.
    if (NoObjectGeneratedError.isInstance(err)) {
        return err.cause === undefined ? true : isTransientLlmError(err.cause, depth + 1);
    }

    // The model returned tool calls or prose but never the structured answer. Another
    // sample usually lands it, so treat it the same way as unparseable output.
    if (NoOutputGeneratedError.isInstance(err)) {
        return err.cause === undefined ? true : isTransientLlmError(err.cause, depth + 1);
    }

    const candidate = err as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };

    if (typeof candidate.code === 'string' && RETRYABLE_ERROR_CODES.has(candidate.code)) return true;
    if (typeof candidate.errno === 'string' && RETRYABLE_ERROR_CODES.has(candidate.errno)) return true;

    if (typeof candidate.message === 'string') {
        const message = candidate.message;
        if (RETRYABLE_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return true;
    }

    return isTransientLlmError(candidate.cause, depth + 1);
}

/**
 * Reads a `retry-after` header off an API error. Supports both the delay-seconds
 * and the HTTP-date form. Returns null when absent or unparseable.
 */
export function getRetryAfterMs(err: unknown, now: number = Date.now()): number | null {
    if (RetryError.isInstance(err)) {
        return getRetryAfterMs(err.lastError, now);
    }
    if (!isApiCallError(err)) {
        const cause = (err as { cause?: unknown } | null | undefined)?.cause;
        return cause ? getRetryAfterMs(cause, now) : null;
    }

    const headers = err.responseHeaders;
    if (!headers) return null;

    // Anthropic/OpenAI send `retry-after-ms` alongside the standard seconds header.
    const rawMs = headers['retry-after-ms'];
    if (rawMs && Number.isFinite(Number(rawMs)) && Number(rawMs) >= 0) {
        return Math.min(Number(rawMs), MAX_RETRY_AFTER_MS);
    }

    const raw = headers['retry-after'] ?? headers['Retry-After'];
    if (!raw) return null;

    const asSeconds = Number(raw);
    if (Number.isFinite(asSeconds)) {
        return asSeconds >= 0 ? Math.min(asSeconds * 1000, MAX_RETRY_AFTER_MS) : null;
    }

    const asDate = Date.parse(raw);
    if (!Number.isNaN(asDate)) {
        return Math.min(Math.max(asDate - now, 0), MAX_RETRY_AFTER_MS);
    }
    return null;
}

/**
 * Exponential backoff with full jitter, floored by any `retry-after` the provider sent.
 * `attempt` is zero-based (0 = delay before the first retry).
 */
export function computeBackoffMs(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
    retryAfterMs: number | null,
    random: () => number = Math.random
): number {
    const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    // Full jitter over the lower half of the window: spreads concurrent workers out
    // without ever collapsing the delay to zero.
    const jittered = Math.round(exponential * (0.5 + random() * 0.5));
    return Math.max(jittered, retryAfterMs ?? 0);
}

export interface RetryOptions {
    /** Retries attempted after the initial call. 0 disables retrying. */
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    /** Shown in the retry log line so operators know which call is flaking. */
    label?: string;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
    if (isApiCallError(err) && typeof err.statusCode === 'number') {
        return `HTTP ${err.statusCode}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `operation`, retrying it while it fails with a transient LLM API error.
 * Permanent failures (auth, malformed request, unknown model) rethrow immediately
 * so a misconfigured run fails fast instead of sleeping through its whole budget.
 */
export async function withLlmRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
    const {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        label = 'LLM request',
        sleep = defaultSleep,
        random = Math.random,
        onRetry,
    } = options;

    let attempt = 0;
    for (;;) {
        try {
            return await operation();
        } catch (err) {
            if (attempt >= maxRetries || !isTransientLlmError(err)) {
                throw err;
            }
            const delayMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs, getRetryAfterMs(err), random);
            const info = { attempt: attempt + 1, delayMs, error: err };
            if (onRetry) {
                onRetry(info);
            } else {
                console.warn(
                    `⏳ ${label} failed with a transient error (attempt ${attempt + 1}/${maxRetries + 1}), ` +
                    `retrying in ${delayMs}ms: ${describeError(err)}`
                );
            }
            await sleep(delayMs);
            attempt++;
        }
    }
}
