import { describeModel } from './config.js';
import { isQuotaExhaustedError } from './retry.js';

/** A provider/model pair the janitor can run an LLM request against. */
export interface ModelChoice {
    provider: string;
    model: string;
}

export interface ModelFallbackOptions {
    /** Model used until it reports an exhausted allowance. */
    primary: ModelChoice;
    /** Backup model, or null/undefined when no fallback is configured. */
    fallback?: ModelChoice | null;
    /** Called once, when the run switches over. Defaults to a console warning. */
    onSwitch?: (info: { from: ModelChoice; to: ModelChoice; error: unknown }) => void;
}

function describeChoice(choice: ModelChoice): string {
    return describeModel(choice.provider, choice.model);
}

function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Runs LLM requests against a primary model and, the moment that model reports an
 * exhausted token/credit allowance, switches the rest of the run over to a backup.
 *
 * The switch is sticky: an exhausted allowance does not refill mid-run, so every
 * later request would pay the same failed round-trip before falling back again.
 */
export class ModelFallback {
    private readonly primary: ModelChoice;
    private readonly fallback: ModelChoice | null;
    private readonly onSwitch: (info: { from: ModelChoice; to: ModelChoice; error: unknown }) => void;
    private usingFallback = false;

    constructor(options: ModelFallbackOptions) {
        this.primary = options.primary;
        this.fallback = options.fallback ?? null;
        this.onSwitch = options.onSwitch ?? (({ from, to, error }) => {
            console.warn(
                `🔁 ${describeChoice(from)} is out of tokens/quota; falling back to ` +
                `${describeChoice(to)} for the rest of this run: ${describeError(error)}`
            );
        });
    }

    /** The model every request should currently use. */
    get active(): ModelChoice {
        return this.usingFallback && this.fallback ? this.fallback : this.primary;
    }

    get hasFallback(): boolean {
        return this.fallback !== null;
    }

    /** "provider/model" for the configured backup, or empty when there is none. */
    get fallbackLabel(): string {
        return this.fallback ? describeChoice(this.fallback) : '';
    }

    /** True once the primary has been retired for this run. */
    get switched(): boolean {
        return this.usingFallback;
    }

    /**
     * Runs `operation` with the active model. If it fails because the account is out
     * of tokens and a backup is configured, switches over and runs it once more.
     * Every other failure — and a backup that is itself exhausted — propagates.
     */
    async run<T>(operation: (choice: ModelChoice) => Promise<T>): Promise<T> {
        try {
            return await operation(this.active);
        } catch (err) {
            if (this.usingFallback || !this.fallback || !isQuotaExhaustedError(err)) {
                throw err;
            }
            const from = this.active;
            this.usingFallback = true;
            this.onSwitch({ from, to: this.fallback, error: err });
            return operation(this.active);
        }
    }
}

/**
 * Builds the fallback used by the run. A fallback that names no provider, or that
 * resolves to the same provider/model as the primary, is treated as absent: retrying
 * the identical model after it ran out of tokens only wastes another round-trip.
 */
export function resolveFallbackChoice(
    primary: ModelChoice,
    fallbackProvider: string,
    fallbackModel: string
): ModelChoice | null {
    if (!fallbackProvider) return null;
    const choice = { provider: fallbackProvider, model: fallbackModel };
    if (choice.provider === primary.provider && (choice.model || '') === (primary.model || '')) {
        return null;
    }
    return choice;
}
