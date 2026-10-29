import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
    /**
     * Lets the model change files and run one command: the worktree's verify script.
     * File edits are accepted only inside the working directory (`acceptEdits`), and
     * Bash is allowed for that exact command alone; anything else is denied, since a
     * `-p` run has nobody to approve it.
     */
    agent?: { verifyCommand: string };
}

/** Tools the implementing agent gets: read, edit, and Bash for the verify script only. */
export const CLAUDE_CODE_AGENT_TOOLS = [...CLAUDE_CODE_READ_ONLY_TOOLS, 'Edit', 'Write', 'Bash'];

export function buildClaudeCodeArgs(req: ClaudeCodeRequest): string[] {
    if (req.agent) {
        return [
            '-p',
            '--output-format', 'json',
            '--json-schema', JSON.stringify(req.jsonSchema),
            '--system-prompt', req.system,
            '--tools', CLAUDE_CODE_AGENT_TOOLS.join(','),
            '--allowedTools', [...CLAUDE_CODE_READ_ONLY_TOOLS, `Bash(${req.agent.verifyCommand})`].join(','),
            '--permission-mode', 'acceptEdits',
            '--no-session-persistence',
            '--strict-mcp-config',
            '--max-turns', String(Math.max(1, req.maxTurns)),
            ...(req.model ? ['--model', req.model] : []),
        ];
    }
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
 *
 * The token is also stripped of whitespace. `claude setup-token` prints it wrapped
 * across lines in a narrow terminal, so a copy-pasted secret can carry a line break
 * that the CLI rejects as an invalid Authorization header. A real token never
 * contains whitespace, so removing it cannot corrupt one.
 */
export function buildClaudeCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const child = { ...env };
    if (child.CLAUDE_CODE_OAUTH_TOKEN) {
        child.CLAUDE_CODE_OAUTH_TOKEN = child.CLAUDE_CODE_OAUTH_TOKEN.replace(/\s+/g, '');
    }
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
    num_turns?: number;
    total_cost_usd?: number;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

/** What one `claude -p` request consumed, as the CLI reports it. */
export interface ClaudeCodeUsage {
    requests: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    /** What the request would have cost at API list prices. A subscription is not billed this. */
    costUsd: number;
}

export function emptyClaudeCodeUsage(): ClaudeCodeUsage {
    return { requests: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

export function addClaudeCodeUsage(total: ClaudeCodeUsage, more: ClaudeCodeUsage): ClaudeCodeUsage {
    return {
        requests: total.requests + more.requests,
        turns: total.turns + more.turns,
        inputTokens: total.inputTokens + more.inputTokens,
        outputTokens: total.outputTokens + more.outputTokens,
        cacheReadTokens: total.cacheReadTokens + more.cacheReadTokens,
        costUsd: total.costUsd + more.costUsd,
    };
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Reads the usage off a CLI result line, or null when there is no result object to read.
 * Input tokens count everything sent, cached or not, since all of it draws on the plan.
 */
export function readClaudeCodeUsage(stdout: string): ClaudeCodeUsage | null {
    let parsed: ClaudeCodeResult;
    try {
        parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const usage = parsed.usage ?? {};
    const cacheRead = num(usage.cache_read_input_tokens);
    return {
        requests: 1,
        turns: num(parsed.num_turns),
        inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + cacheRead,
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: cacheRead,
        costUsd: num(parsed.total_cost_usd),
    };
}

const turnLimitErrors = new WeakSet<object>();

/** True for a request that ran out of `--max-turns` before answering, as opposed to one that answered badly. */
export function isClaudeCodeTurnLimitError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && turnLimitErrors.has(err);
}

/**
 * The turn budget for the next attempt after one ran out of turns: double the last,
 * capped at four times the configured budget. Re-asking with the same budget repeats
 * the same exploration and runs out at the same place, so a retry has to be allowed
 * further than the attempt it replaces. Returns `current` once the cap is reached.
 */
export function nextClaudeCodeTurnBudget(current: number, configured: number): number {
    return Math.max(current, Math.min(current * 2, configured * 4));
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
        const err = new NoOutputGeneratedError({ message: `Claude Code stopped without a structured answer (${parsed.subtype})` });
        if (parsed.subtype === 'error_max_turns') turnLimitErrors.add(err);
        throw err;
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
    agent?: { verifyCommand: string };
    /** Executable to run. Overridable for tests. */
    command?: string;
    /** Called with what each request consumed, whether or not its answer was usable. */
    onUsage?: (usage: ClaudeCodeUsage) => void;
}

/**
 * How to start the CLI. On Windows, npm installs `claude` as a `claude.cmd` shim, which
 * `spawn` cannot run without a shell -- and a shell would have to re-quote the schema and
 * system prompt for cmd.exe. So there the package's own executable is run directly: the
 * native `bin/claude.exe` the package has shipped since it stopped being a Node script,
 * or `cli.js` with this Node for a version from before that.
 *
 * The package is looked for under `npm root -g` and beside every `claude.cmd` on PATH,
 * because the Node that runs the janitor is not necessarily the one that installed the
 * CLI: on a self-hosted runner `claude` is often the machine owner's own install, under a
 * different npm prefix from the Node that setup-node put first on PATH.
 */
export function resolveClaudeCodeCommand(
    platform: NodeJS.Platform = process.platform,
    npmRoot: () => string = () => execSync('npm root -g', { encoding: 'utf-8' }).trim(),
    pathEnv: string = process.env.PATH ?? '',
): { file: string; args: string[] } {
    if (platform !== 'win32') return { file: 'claude', args: [] };
    const roots: string[] = [];
    try {
        roots.push(npmRoot());
    } catch {
        // No npm on PATH: the shims on PATH below may still lead to an install.
    }
    for (const dir of pathEnv.split(';')) {
        if (dir && fs.existsSync(path.join(dir, 'claude.cmd'))) roots.push(path.join(dir, 'node_modules'));
    }
    for (const root of roots) {
        const pkg = path.join(root, '@anthropic-ai', 'claude-code');
        const exe = path.join(pkg, 'bin', 'claude.exe');
        if (fs.existsSync(exe)) return { file: exe, args: [] };
        const cli = path.join(pkg, 'cli.js');
        if (fs.existsSync(cli)) return { file: process.execPath, args: [cli] };
    }
    // Not installed through npm: a native install's claude.exe is found by spawn itself.
    return { file: 'claude', args: [] };
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
        agent: options.agent,
    });

    return new Promise((resolve, reject) => {
        const launch = options.command ? { file: options.command, args: [] } : resolveClaudeCodeCommand();
        const child = spawn(launch.file, [...launch.args, ...args], {
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
            const usage = readClaudeCodeUsage(stdout);
            if (usage) options.onUsage?.(usage);
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
