import { spawn } from 'child_process';
import { NoOutputGeneratedError } from 'ai';
import { z } from 'zod';

/**
 * The `claude-code` provider: runs each request through the Claude Code CLI
 * (`claude -p`) instead of calling a model API from this process.
 *
 * This is what lets the janitor run on a Claude Pro/Max subscription. A subscription
 * token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) is accepted only by Claude
 * Code itself -- Anthropic does not allow it to be used by other API clients, the AI
 * SDK's Anthropic provider included -- so the token never leaves the CLI here: the
 * janitor hands the CLI a prompt and a JSON schema and reads back the structured answer.
 *
 * Workspace inspection maps onto Claude Code's own read-only tools (Read, Grep, Glob)
 * rather than the janitor's tool set, and is bounded by the same step budget.
 */
export const CLAUDE_CODE_PROVIDER = 'claude-code';

/** Claude Code's read-only file tools: enough to inspect the workspace, nothing that writes or runs. */
export const CLAUDE_CODE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface ClaudeCodeRequest {
    jsonSchema: unknown;
    system: string;
    model: string;
    /** Allow the read-only tools. When false the model answers from the prompt alone. */
    allowTools: boolean;
    /** Agentic turns allowed, tool calls included. */
    maxTurns: number;
}

export function buildClaudeCodeArgs(req: ClaudeCodeRequest): string[] {
    const tools = req.allowTools ? CLAUDE_CODE_READ_ONLY_TOOLS.join(',') : '';
    const args = [
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(req.jsonSchema),
        '--system-prompt', req.system,
        '--tools', tools,
        '--no-session-persistence',
        '--strict-mcp-config',
        // One turn always goes on the structured answer itself, so a tool budget of N
        // needs N + 1 turns to leave room for it.
        '--max-turns', String(Math.max(1, req.maxTurns) + 1),
    ];
    if (tools) args.push('--allowedTools', tools);
    if (req.model) args.push('--model', req.model);
    return args;
}

/**
 * The CLI prefers ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN. The action exports
 * whatever `anthropic_api_key` was given (possibly empty) for the `anthropic` provider,
 * so when a subscription token is present the key is dropped to make sure the
 * subscription is what pays.
 */
export function buildClaudeCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const child = { ...env };
    if (child.CLAUDE_CODE_OAUTH_TOKEN || !child.ANTHROPIC_API_KEY) {
        delete child.ANTHROPIC_API_KEY;
    }
    return child;
}

interface ClaudeCodeResult {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
}

/**
 * Turns the CLI's `--output-format json` result into the schema-typed object.
 *
 * A run that answered but produced nothing usable (no structured output, ran out of
 * turns, failed validation) throws NoOutputGeneratedError, which the retry layer treats
 * as worth another sample. Anything else -- auth, an exhausted subscription limit, a
 * rate limit -- throws a plain Error carrying the CLI's own message, which the retry and
 * fallback layers classify by wording just as they do a provider's error text.
 */
export function parseClaudeCodeOutput<T extends z.ZodTypeAny>(schema: T, stdout: string): z.infer<T> {
    let parsed: ClaudeCodeResult;
    try {
        // Only the last line is the result object; anything before it is CLI noise.
        const lastLine = stdout.trim().split('\n').pop() ?? '';
        parsed = JSON.parse(lastLine);
    } catch {
        throw new NoOutputGeneratedError({ message: `Claude Code returned unparseable output: ${stdout.slice(0, 500)}` });
    }

    if (parsed.subtype === 'error_max_turns' || parsed.subtype === 'error_max_structured_output_retries') {
        throw new NoOutputGeneratedError({ message: `Claude Code stopped without a structured answer (${parsed.subtype})` });
    }
    if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
        throw new Error(`Claude Code request failed (${parsed.subtype ?? 'error'}): ${parsed.result ?? 'no message'}`);
    }
    if (parsed.structured_output === undefined) {
        throw new NoOutputGeneratedError({ message: 'Claude Code answered without structured output' });
    }

    const validated = schema.safeParse(parsed.structured_output);
    if (!validated.success) {
        throw new NoOutputGeneratedError({ message: `Claude Code output failed schema validation: ${validated.error.message}` });
    }
    return validated.data;
}

export interface ClaudeCodeOptions {
    model: string;
    workDir: string;
    allowTools: boolean;
    maxTurns: number;
    timeoutMs?: number;
    /** Executable to run. Overridable for tests. */
    command?: string;
}

/** Runs one structured request through `claude -p` in `workDir`. The prompt goes on stdin, so its size is not bounded by argv limits. */
export function generateWithClaudeCode<T extends z.ZodTypeAny>(
    schema: T,
    system: string,
    prompt: string,
    options: ClaudeCodeOptions
): Promise<z.infer<T>> {
    // The CLI's validator does not know zod's draft 2020-12 meta-schema URI and rejects
    // the whole schema over it; the schema itself needs nothing from that draft.
    const { $schema: _metaSchema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    const args = buildClaudeCodeArgs({
        jsonSchema,
        system,
        model: options.model,
        allowTools: options.allowTools,
        maxTurns: options.maxTurns,
    });

    return new Promise((resolve, reject) => {
        const child = spawn(options.command ?? 'claude', args, {
            cwd: options.workDir,
            env: buildClaudeCodeEnv(process.env),
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });

        const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        child.on('error', err => {
            clearTimeout(timer);
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            reject(missing
                ? new Error('The claude-code provider needs the Claude Code CLI on PATH (npm install -g @anthropic-ai/claude-code)')
                : err);
        });

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (signal) {
                reject(new Error(`Claude Code request timed out (killed by ${signal})`));
                return;
            }
            try {
                resolve(parseClaudeCodeOutput(schema, stdout));
            } catch (err) {
                // A non-zero exit with no result object is a CLI-level failure; its stderr says why.
                if (code !== 0 && !stdout.trim() && stderr.trim()) {
                    reject(new Error(`Claude Code exited with code ${code}: ${stderr.trim().slice(0, 1000)}`));
                } else {
                    reject(err);
                }
            }
        });

        child.stdin.end(prompt);
    });
}
