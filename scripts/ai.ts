import { generateObject, generateText, tool, Output, stepCountIs, NoOutputGeneratedError } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import {
    provider,
    modelName,
    testCmd,
    testTimeoutMs,
    lintCmd,
    enableTestGen,
    maxPRs,
    maxLineDiff,
    maxTestLineDiff,
    fileChangeSchema,
    FileChange,
    FixProposal,
    fixesResponseSchema,
    getModel,
    ensureTrailingNewline,
    enableLlmTools,
    maxLlmToolSteps,
    preferEdits,
    isEditBasedChange,
    llmMaxRetries,
    llmRetryBaseDelayMs,
    llmRetryMaxDelayMs,
} from './config.js';
import { applyEdits } from './edits.js';
import { runVerification, logFailedDiff, runCmd } from './git.js';
import { withLlmRetry } from './retry.js';
import { isTestFilePath } from './paths.js';

const EDIT_FORMAT_RULE = `CHANGE FORMAT (PREFER TARGETED EDITS): For an EXISTING file, express the change as an 'edits' array of search/replace pairs: 'oldText' is a snippet copied VERBATIM from the current file content (exact indentation, enough surrounding lines to be unique in that file) and 'newText' is what replaces it. Use an empty 'newText' to delete the snippet, and set 'replaceAll' only when every occurrence should change. Do NOT echo the whole file back. For a NEW file, omit 'edits' and put the complete file body in 'updatedContent'. If you do fall back to 'updatedContent' for an existing file, it MUST be the COMPLETE file from line 1 to the end -- never abbreviate or summarize unedited code with '// ...' and never drop existing top-level functions, structs, classes, imports, macros, or types.`;

const FULL_REWRITE_RULE = `FULL FILE CONTENT MANDATE (DO NOT TRUNCATE): 'updatedContent' MUST contain the COMPLETE, exact file content from line 1 to the end. NEVER abbreviate, summarize, or omit unedited code with comments like '// ...' or skip existing top-level functions, structs, classes, imports, macros, or types. Omitting top-level declarations causes immediate integrity check failures and invalidates the proposal.`;

/**
 * The change-format instruction handed to the model. Edits are the default because a
 * whole-file rewrite makes the model retype every unedited line, and a single dropped
 * declaration in that retyping costs an integrity failure plus an auto-fix round trip.
 */
export function changeFormatRule(): string {
    return preferEdits ? EDIT_FORMAT_RULE : FULL_REWRITE_RULE;
}

const NON_TRIVIAL_SUFFIX = `Do NOT output a proposal whose changes leave the file byte-identical to its current content.`;

export function isPathInsideWorkspace(workDir: string, targetPath: string): boolean {
    const absWorkDir = path.resolve(workDir).toLowerCase();
    const absTarget = path.resolve(workDir, targetPath).toLowerCase();
    return absTarget === absWorkDir || absTarget.startsWith(absWorkDir + path.sep);
}

/**
 * Normalizes an LLM-proposed relative file path and rejects anything that would
 * escape the workspace root (e.g. "../../etc/passwd"). Returns null when unsafe.
 */
export function sanitizeRelativePath(workDir: string, rawPath: string): string | null {
    if (!rawPath) return null;
    const cleaned = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const normalized = path.normalize(cleaned);
    if (!cleaned || normalized.startsWith('..') || path.isAbsolute(normalized)) {
        return null;
    }
    if (!isPathInsideWorkspace(workDir, normalized)) {
        return null;
    }
    return normalized;
}

const ALLOWED_COMMAND_PREFIXES = [
    'ls', 'dir', 'find', 'git status', 'git log', 'git diff', 'git ls-files', 'cat', 'grep', 'pwd', 'tree', 'file', 'wc', 'head', 'tail'
];

export function isCommandAllowed(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    // Reject any shell metacharacter that could chain commands, redirect output,
    // or invoke substitution (e.g. `git log && curl ...`, `$(cat secret)`).
    if (/[;&|>`$(){}<\n]/.test(trimmed)) {
        return false;
    }
    const lower = trimmed.toLowerCase();
    return ALLOWED_COMMAND_PREFIXES.some(prefix => lower === prefix || lower.startsWith(prefix + ' '));
}

export function createJanitorTools(workDir: string = process.cwd()) {
    if (!enableLlmTools) return undefined;

    return {
        read_file: tool({
            description: 'Read the contents of a file relative to the project workspace root',
            inputSchema: z.object({
                filePath: z.string().describe('Relative path to the file to read'),
            }),
            execute: async ({ filePath }) => {
                if (!isPathInsideWorkspace(workDir, filePath)) {
                    console.log(`  🛠️ Tool call: read_file("${filePath}") -> Denied (Outside workspace)`);
                    return `Error: Access denied. File path "${filePath}" is outside workspace directory.`;
                }
                const absPath = path.resolve(workDir, filePath);
                if (!fs.existsSync(absPath)) {
                    console.log(`  🛠️ Tool call: read_file("${filePath}") -> Error (File not found)`);
                    return `Error: File "${filePath}" does not exist.`;
                }
                const stat = fs.statSync(absPath);
                if (!stat.isFile()) {
                    console.log(`  🛠️ Tool call: read_file("${filePath}") -> Error (Not a file)`);
                    return `Error: "${filePath}" is not a file.`;
                }
                try {
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const maxBytes = 40000;
                    if (content.length > maxBytes) {
                        const truncated = content.slice(0, maxBytes) + `\n... [truncated ${content.length - maxBytes} characters. Max file output limit is 40,000 characters]`;
                        console.log(`  🛠️ Tool call: read_file("${filePath}") -> Read ${content.length} chars (Truncated to ${maxBytes})`);
                        return truncated;
                    }
                    console.log(`  🛠️ Tool call: read_file("${filePath}") -> Read ${content.length} chars`);
                    return content;
                } catch (err: any) {
                    console.log(`  🛠️ Tool call: read_file("${filePath}") -> Error (${err.message})`);
                    return `Error reading file "${filePath}": ${err.message}`;
                }
            },
        }),
        list_directory: tool({
            description: 'List files and directories within a workspace folder (defaults to workspace root). Maximum 100 entries.',
            inputSchema: z.object({
                dirPath: z.string().optional().describe('Relative directory path to list (defaults to root ".")'),
            }),
            execute: async ({ dirPath }) => {
                const relativeDir = dirPath || '.';
                if (!isPathInsideWorkspace(workDir, relativeDir)) {
                    console.log(`  🛠️ Tool call: list_directory("${relativeDir}") -> Denied (Outside workspace)`);
                    return `Error: Access denied. Path "${relativeDir}" is outside workspace directory.`;
                }
                const absPath = path.resolve(workDir, relativeDir);
                if (!fs.existsSync(absPath)) {
                    console.log(`  🛠️ Tool call: list_directory("${relativeDir}") -> Error (Dir not found)`);
                    return `Error: Directory "${relativeDir}" does not exist.`;
                }
                const stat = fs.statSync(absPath);
                if (!stat.isDirectory()) {
                    console.log(`  🛠️ Tool call: list_directory("${relativeDir}") -> Error (Not a directory)`);
                    return `Error: Path "${relativeDir}" is not a directory.`;
                }
                try {
                    const entries = fs.readdirSync(absPath, { withFileTypes: true });
                    const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor']);
                    const filtered = entries.filter(e => !ignoredDirs.has(e.name));
                    const maxEntries = 100;
                    const truncated = filtered.length > maxEntries;
                    const slice = truncated ? filtered.slice(0, maxEntries) : filtered;
                    const formatted = slice
                        .map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
                        .join('\n');
                    const finalResult = truncated
                        ? `${formatted}\n... [truncated ${filtered.length - maxEntries} entries. Max directory output limit is 100 entries]`
                        : (formatted || '(directory is empty)');
                    console.log(`  🛠️ Tool call: list_directory("${relativeDir}") -> Returned ${slice.length}${truncated ? ` (Truncated from ${filtered.length})` : ''} entries`);
                    return finalResult;
                } catch (err: any) {
                    console.log(`  🛠️ Tool call: list_directory("${relativeDir}") -> Error (${err.message})`);
                    return `Error listing directory "${relativeDir}": ${err.message}`;
                }
            },
        }),
        run_command: tool({
            description: 'Run small, safe read-only shell commands in the workspace (e.g. ls, dir, find, git status, git log, cat, grep). Output max 10,000 characters.',
            inputSchema: z.object({
                command: z.string().describe('Command string to execute'),
            }),
            execute: async ({ command }) => {
                if (!isCommandAllowed(command)) {
                    console.log(`  🛠️ Tool call: run_command("${command}") -> Denied (Command not permitted)`);
                    return `Error: Command "${command}" is not allowed. Only safe read-only diagnostic commands (ls, dir, find, git status, git log, git diff, cat, grep, pwd, tree) are permitted.`;
                }
                const result = runCmd(command, 'llm-tool', 10000, workDir);
                const maxOutput = 10000;
                let output = result.output;
                if (output.length > maxOutput) {
                    output = output.slice(0, maxOutput) + `\n... [output truncated at ${maxOutput} characters limit]`;
                    console.log(`  🛠️ Tool call: run_command("${command}") -> Executed (Truncated output to ${maxOutput} chars)`);
                } else {
                    console.log(`  🛠️ Tool call: run_command("${command}") -> Executed (${output.length} chars output)`);
                }
                return output || '(no output)';
            },
        }),
    };
}

/** Cap on how much replayed tool output the finalization prompt may carry. */
export const TOOL_TRANSCRIPT_LIMIT = 20000;

/**
 * Renders the tool calls and their results from a `generateText` run as a plain-text
 * transcript, so a follow-up toolless request can be told what the tools already found
 * instead of rediscovering it.
 */
export function summarizeToolSteps(steps: unknown): string {
    if (!Array.isArray(steps)) return '';

    const lines: string[] = [];
    for (const step of steps) {
        const toolCalls = (step as { toolCalls?: any[] })?.toolCalls ?? [];
        const toolResults = (step as { toolResults?: any[] })?.toolResults ?? [];
        for (const call of toolCalls) {
            let input: string;
            try {
                input = JSON.stringify(call?.input ?? call?.args ?? {});
            } catch {
                input = '{}';
            }
            lines.push(`$ ${call?.toolName ?? 'tool'}(${input})`);
        }
        for (const res of toolResults) {
            const raw = res?.output ?? res?.result;
            let output: string;
            if (typeof raw === 'string') {
                output = raw;
            } else {
                try {
                    output = JSON.stringify(raw ?? '');
                } catch {
                    output = String(raw);
                }
            }
            lines.push(`-> ${res?.toolName ?? 'tool'} returned:\n${output}`);
        }
    }

    const transcript = lines.join('\n\n');
    return transcript.length > TOOL_TRANSCRIPT_LIMIT
        ? `${transcript.slice(0, TOOL_TRANSCRIPT_LIMIT)}\n... [tool transcript truncated at ${TOOL_TRANSCRIPT_LIMIT} characters]`
        : transcript;
}

/**
 * Builds the prompt for the toolless finalization pass: the original prompt, whatever the
 * tools already reported, and an instruction to answer now rather than ask for more.
 */
export function buildFinalizationPrompt(prompt: string, transcript: string): string {
    const instruction =
        'You have no tools available for this request and no further inspection is possible. ' +
        'Answer NOW with the structured response, using only the information above. ' +
        'If it is not enough to justify any change, return an empty list rather than asking for more.';
    return transcript
        ? `${prompt}\n\nWorkspace inspection you already performed (tool calls and their output):\n\n${transcript}\n\n${instruction}`
        : `${prompt}\n\n${instruction}`;
}

/**
 * Generates a schema-typed object from the model. `generateObject` does not accept
 * `tools`, so when workspace tools are enabled we route through `generateText` with
 * a structured `output` spec instead, letting the model call tools across multiple
 * steps (bounded by `stopWhen: stepCountIs(...)`) before producing its final response.
 */
async function generateStructuredWithTools<T extends z.ZodTypeAny>(
    schema: T,
    system: string,
    prompt: string,
    tools: ReturnType<typeof createJanitorTools>
): Promise<z.infer<T>> {
    // `maxRetries: 0` disables the SDK's own retry loop so that retrying happens in
    // exactly one place: `withLlmRetry`, which also covers unparseable structured
    // output and logs each attempt.
    const retryOptions = {
        maxRetries: llmMaxRetries,
        baseDelayMs: llmRetryBaseDelayMs,
        maxDelayMs: llmRetryMaxDelayMs,
        label: `${provider}/${modelName} request`,
    };

    if (tools) {
        return withLlmRetry(async () => {
            const result = await generateText({
                model: getModel(provider, modelName),
                tools,
                stopWhen: stepCountIs(maxLlmToolSteps),
                system,
                prompt,
                maxRetries: 0,
                output: Output.object<z.infer<T>>({ schema }),
            });

            try {
                return result.output;
            } catch (err) {
                if (!NoOutputGeneratedError.isInstance(err)) throw err;
                // The model spent every allowed step on tool calls and never emitted the
                // structured answer, so `result.output` has nothing to hand back. That is a
                // budgeting problem, not a failed run: re-ask once without tools, replaying
                // what the tools already told it, so the step budget cannot abort the sweep.
                console.warn(
                    `⚠️ Model used all ${maxLlmToolSteps} tool step(s) without returning a structured answer; ` +
                    `re-asking once without tools using the gathered tool output.`
                );
                const finalized = await generateObject({
                    model: getModel(provider, modelName),
                    schema,
                    output: 'object',
                    system,
                    prompt: buildFinalizationPrompt(prompt, summarizeToolSteps(result.steps)),
                    maxRetries: 0,
                });
                return finalized.object as z.infer<T>;
            }
        }, retryOptions);
    }

    return withLlmRetry(async () => {
        const result = await generateObject({
            model: getModel(provider, modelName),
            schema,
            output: 'object',
            system,
            prompt,
            maxRetries: 0,
        });
        return result.object as z.infer<T>;
    }, retryOptions);
}


export function extractFilePathsFromDiff(diff: string): string[] {
    const filePaths = new Set<string>();
    const matches = diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);
    for (const match of matches) {
        const filePath = match[2].trim().replace(/^\.\//, '').replace(/^\/+/, '');
        if (filePath && filePath !== '/dev/null') {
            filePaths.add(filePath);
        }
    }
    return Array.from(filePaths);
}

export function findFileInWorkspaceByBasename(workDir: string, basename: string): string | null {
    if (!basename || basename === '.' || basename === '..') return null;

    const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', 'generated', '.gradle', '.idea']);
    const matches: string[] = [];

    const walk = (currentDir: string, relativePrefix: string) => {
        if (matches.length > 5) return;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
            const absPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (ignoredDirs.has(entry.name)) continue;
                walk(absPath, relPath);
            } else if (entry.isFile()) {
                if (entry.name.toLowerCase() === basename.toLowerCase()) {
                    matches.push(relPath);
                }
            }
        }
    };

    walk(workDir, '');
    return matches.length > 0 ? matches[0] : null;
}

export function extractFilePathsFromLogs(logs: string, workDir: string = process.cwd()): string[] {
    const filePaths = new Set<string>();
    const regex = /(?:^|[\s"'(:]+)([a-zA-Z0-9_\-\.\/\\]+\.(?:rs|kt|java|ts|tsx|js|jsx|go|py|c|cpp|h|hpp|toml|json|yaml|yml|gradle|properties))(?::\s*\d+|(?::\s*\d+)?:\s*\d+|:\s*\(\s*\d+(?:\s*,\s*\d+)?\)|\(\s*\d+(?:\s*,\s*\d+)?\)|[:\s"'`\)]|$)/gm;
    const absWorkDir = path.resolve(workDir).replace(/\\/g, '/');

    const matches = logs.matchAll(regex);
    for (const match of matches) {
        let candidate = match[1].trim().replace(/\\/g, '/');
        if (candidate.toLowerCase().startsWith(absWorkDir.toLowerCase())) {
            candidate = candidate.slice(absWorkDir.length).replace(/^\/+/, '');
        }
        candidate = candidate.replace(/^\.\//, '').replace(/^\/+/, '');

        if (candidate.includes('node_modules/') || candidate.includes('.git/') || candidate.startsWith('target/') || candidate.startsWith('build/')) {
            continue;
        }

        const resolved = path.resolve(workDir, candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            filePaths.add(candidate);
        } else {
            const baseName = path.basename(candidate);
            const foundRelPath = findFileInWorkspaceByBasename(workDir, baseName);
            if (foundRelPath) {
                filePaths.add(foundRelPath);
            }
        }
    }
    return Array.from(filePaths);
}


export function collectAgentFiles(workDir: string = process.cwd()): string[] {
    const agentPaths: string[] = [];

    const isIgnoredDir = (dirName: string) => {
        return ['node_modules', '.git', 'dist', 'build', 'target', 'vendor', 'generated'].includes(dirName);
    };

    const walk = (currentDir: string, relativePrefix: string) => {
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
            const absPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (isIgnoredDir(entry.name)) {
                    continue;
                }
                walk(absPath, relPath);
            } else if (entry.isFile()) {
                const lowerName = entry.name.toLowerCase();
                const lowerRel = relPath.toLowerCase();

                const isAgentFile =
                    lowerName === 'agents.md' ||
                    relPath === '.agents' ||
                    lowerRel.startsWith('.agents/') ||
                    lowerRel.includes('/.agents/') ||
                    lowerName === 'claude.md' ||
                    lowerName === 'gemini.md' ||
                    lowerName === '.cursorrules' ||
                    lowerRel.startsWith('.cursor/rules/') ||
                    lowerRel.includes('/.cursor/rules/') ||
                    lowerRel === '.github/copilot-instructions.md';

                if (isAgentFile) {
                    agentPaths.push(relPath);
                }
            }
        }
    };

    walk(workDir, '');
    return agentPaths;
}

export function getAgentFilesContext(workDir: string = process.cwd(), maxBytesPerFile: number = 40000): string {
    const filePaths = collectAgentFiles(workDir);
    if (filePaths.length === 0) {
        return '';
    }

    const contexts: string[] = [];
    for (const filePath of filePaths) {
        const absPath = path.resolve(workDir, filePath);
        if (fs.existsSync(absPath)) {
            try {
                const stat = fs.statSync(absPath);
                if (stat.isFile()) {
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const truncated = content.length > maxBytesPerFile ? content.slice(0, maxBytesPerFile) + '\n... [truncated]' : content;
                    contexts.push(`--- File: ${filePath} (Agent Context) ---\n${truncated}`);
                }
            } catch {}
        }
    }
    return contexts.join('\n\n');
}

export function getFullFileContexts(filePaths: string[], workDir: string = process.cwd(), maxBytesPerFile: number = 40000): string {
    const contexts: string[] = [];
    for (const filePath of filePaths) {
        const absPath = path.resolve(workDir, filePath);
        if (fs.existsSync(absPath)) {
            try {
                const stat = fs.statSync(absPath);
                if (stat.isFile()) {
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const truncated = content.length > maxBytesPerFile ? content.slice(0, maxBytesPerFile) + '\n... [truncated]' : content;
                    contexts.push(`--- File: ${filePath} (Full Content) ---\n${truncated}`);
                }
            } catch {}
        }
    }
    return contexts.join('\n\n');
}

// isTestFilePath lives in paths.ts so integrity/line-budget checks can reuse it
// without importing this module; re-exported here for existing callers.
export { isTestFilePath } from './paths.js';

function listTestFilesInDir(workDir: string, relativeDir: string): string[] {
    const absDir = path.resolve(workDir, relativeDir);
    if (!isPathInsideWorkspace(workDir, relativeDir)) return [];
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isFile())
        .map(e => (relativeDir === '.' ? e.name : `${relativeDir}/${e.name}`))
        .filter(rel => isTestFilePath(rel));
}

/**
 * Candidate directories that conventionally hold the tests for `sourceDir`:
 * the directory itself, nested test folders, and JVM-style mirrored source
 * roots (`src/main/java/... -> src/test/java/...`).
 */
function candidateTestDirs(sourceDir: string): string[] {
    const dirs = new Set<string>();
    const normalized = sourceDir.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
    dirs.add(normalized);

    for (const testDirName of ['__tests__', 'tests', 'test', 'spec']) {
        dirs.add(normalized === '.' ? testDirName : `${normalized}/${testDirName}`);
    }

    const parent = normalized === '.' ? null : path.posix.dirname(normalized);
    if (parent && parent !== '.') {
        for (const testDirName of ['__tests__', 'tests', 'test']) {
            dirs.add(`${parent}/${testDirName}`);
        }
    }

    // JVM / Gradle layouts keep tests in a mirrored source root.
    if (normalized.includes('/src/main/')) {
        dirs.add(normalized.replace('/src/main/', '/src/test/'));
    } else if (normalized.startsWith('src/main/')) {
        dirs.add(normalized.replace(/^src\/main\//, 'src/test/'));
    }

    return Array.from(dirs);
}

/**
 * Finds existing test files related to the given source files so the model can
 * copy the project's real test conventions (framework imports, package/module
 * declarations, shared fixtures and helpers) instead of inventing ones that do
 * not compile. Counterpart tests for a changed file rank highest, then tests
 * sitting beside it, then any tests elsewhere in the repo as a last-resort
 * example of the project's style.
 */
export function findSiblingTestFiles(
    sourcePaths: string[],
    workDir: string = process.cwd(),
    maxFiles: number = 5
): string[] {
    if (maxFiles <= 0) return [];

    const excluded = new Set(sourcePaths.map(p => p.replace(/\\/g, '/')));
    const sources = sourcePaths
        .map(p => p.replace(/\\/g, '/'))
        .filter(p => !isTestFilePath(p));
    const stems = sources.map(p => path.posix.basename(p, path.posix.extname(p)).toLowerCase());

    // A test file is the counterpart of a changed source file when its name is
    // derived from that file's stem: `store.go` -> `store_test.go`,
    // `ai.ts` -> `ai.test.ts`, `UserService.kt` -> `UserServiceTest.kt`,
    // `parser.py` -> `test_parser.py`.
    const isCounterpart = (testPath: string) => {
        const testStem = path.posix.basename(testPath, path.posix.extname(testPath)).toLowerCase();
        return stems.some(stem => stem.length > 0 && (testStem.startsWith(stem) || testStem.startsWith(`test_${stem}`)));
    };

    const counterparts: string[] = [];
    const neighbours: string[] = [];
    const seen = new Set<string>();

    const record = (relPath: string) => {
        const normalized = relPath.replace(/\\/g, '/');
        if (seen.has(normalized) || excluded.has(normalized)) return;
        if (!fs.existsSync(path.resolve(workDir, normalized))) return;
        seen.add(normalized);
        (isCounterpart(normalized) ? counterparts : neighbours).push(normalized);
    };

    for (const sourcePath of sources) {
        const sourceDir = path.posix.dirname(sourcePath);
        for (const dir of candidateTestDirs(sourceDir)) {
            for (const testPath of listTestFilesInDir(workDir, dir)) {
                record(testPath);
            }
        }
    }

    const ordered = [...counterparts, ...neighbours];
    if (ordered.length >= maxFiles) {
        return ordered.slice(0, maxFiles);
    }

    // Nothing nearby: fall back to any test file in the workspace so the model
    // still sees how this project writes tests.
    const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', 'generated', '.gradle', '.idea']);
    const fallback: string[] = [];
    const walk = (currentDir: string, relativePrefix: string) => {
        if (ordered.length + fallback.length >= maxFiles) return;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (ordered.length + fallback.length >= maxFiles) return;
            const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (ignoredDirs.has(entry.name)) continue;
                walk(path.join(currentDir, entry.name), relPath);
            } else if (entry.isFile() && isTestFilePath(relPath) && !seen.has(relPath) && !excluded.has(relPath)) {
                seen.add(relPath);
                fallback.push(relPath);
            }
        }
    };
    walk(path.resolve(workDir), '');

    return [...ordered, ...fallback].slice(0, maxFiles);
}

/**
 * Formats sibling test files as prompt context. Returns '' when the repository
 * has no discoverable tests for the changed files.
 */
export function getSiblingTestContexts(
    sourcePaths: string[],
    workDir: string = process.cwd(),
    maxFiles: number = 5,
    maxBytesPerFile: number = 20000
): string {
    const testPaths = findSiblingTestFiles(sourcePaths, workDir, maxFiles);
    if (testPaths.length === 0) return '';

    const contexts: string[] = [];
    for (const testPath of testPaths) {
        const absPath = path.resolve(workDir, testPath);
        try {
            const stat = fs.statSync(absPath);
            if (!stat.isFile()) continue;
            const content = fs.readFileSync(absPath, 'utf-8');
            const truncated = content.length > maxBytesPerFile
                ? content.slice(0, maxBytesPerFile) + '\n... [truncated]'
                : content;
            contexts.push(`--- File: ${testPath} (Existing Test File) ---\n${truncated}`);
        } catch {}
    }
    return contexts.join('\n\n');
}

export async function generateRepairProposals(buildErrorLogs: string, workDir: string = process.cwd(), existingPRContext: string = ''): Promise<FixProposal[]> {
    const agentContexts = getAgentFilesContext(workDir);
    const agentFilePaths = new Set(collectAgentFiles(workDir));

    const rawFilePaths = extractFilePathsFromLogs(buildErrorLogs, workDir);
    const filePaths = rawFilePaths.filter(p => !agentFilePaths.has(p));
    const fileContexts = getFullFileContexts(filePaths, workDir);
    const testContexts = getSiblingTestContexts(filePaths, workDir);
    const tools = createJanitorTools(workDir);

    const repairPrompt = `
    You are an expert software engineer and debugger.
    The project build or test suite is currently FAILING on the main branch.

    Analyze the build errors provided below and generate minimal, atomic fixes to resolve the issue and make the test suite pass.
    
    RULES:
    1. Fix ONLY what is necessary to resolve the build or test failures.
    2. Do NOT introduce new features or unnecessary refactoring.
    3. SEPARATE LINE BUDGETS (ENFORCED IN CODE): Keep changes to non-test (production) files at or under ${maxLineDiff} total diff lines (added + removed, summed across all production files in the proposal). Test file changes have their own separate budget of ${maxTestLineDiff} total diff lines and do NOT count against the production budget, so never thin out or drop a needed test to stay within the production budget. These caps are measured against your actual proposed diff and a proposal that exceeds either one is rejected, so split larger work into smaller atomic proposals instead of overshooting.
    4. MULTI-FILE PROPOSALS SUPPORTED: Include all modified files in the 'changes' array. You can modify up to 5 related files in a single proposal (e.g., fixing a function signature and updating callers/test files).
    5. ${changeFormatRule()}
    6. PRESERVE API CONTRACTS: If you modify a function signature, update all relevant caller sites across modified files in 'changes'.
    7. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT resolve warnings or errors by adding language suppression annotations (e.g. @Suppress) or deleting callers. Ensure imported standard library functions exist and are valid.
    8. RESPECT IDIOMATIC TEST PLACEMENT: Follow language-idiomatic conventions for test placement (e.g. in-file conditional modules where supported, or dedicated test files/directories).
    9. NON-TRIVIAL CHANGES REQUIRED: Each file in 'changes' MUST contain actual code additions, deletions, or modifications to resolve the failure. ${NON_TRIVIAL_SUFFIX}
    10. TRAILING NEWLINE MANDATE: when you supply 'updatedContent', it MUST ALWAYS end with a trailing newline character (\\n).
    11. RESPECT AGENT INSTRUCTIONS: Respect any project agent instructions or repository rules provided in AGENTS.md, .agents files, or related agent configurations.
    12. FILE PATH ACCURACY MANDATE: You MUST preserve the exact file paths, directory structures, and package/module folders of existing files provided in the context or error logs. When modifying an existing file or creating a related test file, match the exact relative folder path and source root conventions of the target codebase. Do NOT invent new package paths or hallucinate directory layouts.
    13. MATCH EXISTING TEST CONVENTIONS: When you add or edit tests, mirror the existing test files provided in the context exactly: same test framework and runner, same import/package/module declarations, same helper and fixture utilities, and the same file naming and directory placement. Do NOT invent test frameworks, helpers, or imports that the existing tests do not already use.
    14. WORKSPACE TOOLS: You have access to interactive workspace tools ('read_file', 'list_directory', 'run_command'). Call available tools if you need to read additional source/test files, inspect workspace structure, or run safe commands.
    15. NO DUPLICATE PROPOSALS: If a list of pull requests the janitor has already submitted is provided, do NOT re-propose any fix those PRs already cover. This sweep runs on a schedule and re-observes the same failures until the pending fix is merged; an open PR means the repair is already awaiting review, and a closed unmerged PR means a human rejected that approach. Propose only genuinely new fixes, and return an empty 'fixes' list if every remaining failure is already covered.
  `;

    let promptText = `Build/Test Error Logs:\n\n${buildErrorLogs.slice(0, 15000)}`;
    if (agentContexts) {
        promptText += `\n\nProject Agent Instructions & Repository Guidelines:\n\n${agentContexts}`;
    }
    if (fileContexts) {
        promptText += `\n\nFull contents of relevant source files:\n\n${fileContexts}`;
    }
    if (testContexts) {
        promptText += `\n\nExisting test files from this repository (follow these conventions exactly when writing tests):\n\n${testContexts}`;
    }
    if (existingPRContext) {
        promptText += `\n\nPull requests the Code Janitor has ALREADY submitted (do NOT re-propose these fixes):\n\n${existingPRContext}`;
    }

    console.log("🔧 Querying model for repair proposals...");
    const result = await generateStructuredWithTools(fixesResponseSchema, repairPrompt, promptText, tools);

    if (result.fixes.length > maxPRs) {
        console.log(`⚠️ Model returned ${result.fixes.length} repair proposals; capping to maxPRs (${maxPRs}).`);
    }
    return result.fixes.slice(0, maxPRs);
}


export async function generateFixProposals(diff: string, workDir: string = process.cwd(), existingPRContext: string = ''): Promise<FixProposal[]> {
    const agentContexts = getAgentFilesContext(workDir);
    const agentFilePaths = new Set(collectAgentFiles(workDir));

    const rawFilePaths = extractFilePathsFromDiff(diff);
    const filePaths = rawFilePaths.filter(p => !agentFilePaths.has(p));
    const fileContexts = getFullFileContexts(filePaths, workDir);
    const testContexts = enableTestGen ? getSiblingTestContexts(filePaths, workDir) : '';
    const tools = createJanitorTools(workDir);

    const systemPrompt = `
    You are an expert static analyzer and software maintainer.
    Analyze the recent git diffs and identify up to ${maxPRs} distinct, high-value improvements or edge-case unit tests.
    
    RULES:
    1. Each fix MUST be completely self-contained and atomic.
    2. SEPARATE LINE BUDGETS (ENFORCED IN CODE): Do NOT propose changes to non-test (production) files larger than ${maxLineDiff} total diff lines (added + removed, summed across all production files in the proposal). Test files (e.g. '*_test.go', '*.test.ts', 'src/test/**', 'tests/**', or whatever this project uses) have their own separate budget of ${maxTestLineDiff} total diff lines and do NOT count against the production budget, so never thin out or drop a needed test to stay within the production budget. These caps are measured against your actual proposed diff and a proposal that exceeds either one is rejected, so split larger work into smaller atomic proposals instead of overshooting.
    3. MULTI-FILE PROPOSALS SUPPORTED: Each proposal specifies a 'changes' array containing 1 to 5 file modifications. You can pair a production file refactor with a separate unit test file or update caller sites when modifying a signature.
    4. ${enableTestGen ? 'Feel free to generate unit tests for uncovered paths using language-idiomatic test patterns.' : 'Do NOT generate test files or test classes; focus only on code refactoring.'}
    5. Focus on idiomatic improvements, resource cleanup, performance, or edge-case bug fixes. DO NOT propose redundant refactorings for logic or validation that already exists in the file.
    6. ${changeFormatRule()}
    7. PRESERVE API CONTRACTS: If you modify a function signature, update all relevant call sites across modified files in 'changes'.
    8. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT swallow warnings or delete callers. Verify that all standard library functions and imports exist before using them.
    9. RESPECT IDIOMATIC TEST PLACEMENT: Follow language and project conventions for test structure and placement.
    10. NON-TRIVIAL CHANGES REQUIRED: Every proposed file change MUST include concrete code modifications, additions, or deletions compared to existing code. ${NON_TRIVIAL_SUFFIX}
    11. TRAILING NEWLINE MANDATE: when you supply 'updatedContent', it MUST ALWAYS end with a trailing newline character (\\n).
    12. RESPECT AGENT INSTRUCTIONS: Respect any project agent instructions or repository rules provided in AGENTS.md, .agents files, or related agent configurations.
    13. FILE PATH ACCURACY MANDATE: You MUST preserve the exact file paths, directory structures, and package/module folders of existing files provided in the context or error logs. When modifying an existing file or creating a related test file, match the exact relative folder path and source root conventions of the target codebase. Do NOT invent new package paths or hallucinate directory layouts.
    14. MATCH EXISTING TEST CONVENTIONS: When you add or edit tests, mirror the existing test files provided in the context exactly: same test framework and runner, same import/package/module declarations, same helper and fixture utilities, and the same file naming and directory placement. Do NOT invent test frameworks, helpers, or imports that the existing tests do not already use.
    15. WORKSPACE TOOLS: You have access to interactive workspace tools ('read_file', 'list_directory', 'run_command'). Call available tools if you need to inspect existing test files, helper utilities, or directory layouts.
    16. NO DUPLICATE PROPOSALS: If a list of pull requests the janitor has already submitted is provided, do NOT re-propose any improvement those PRs already cover. An open PR means that change is already awaiting review; a closed unmerged PR means a human rejected that approach.
  `;

    let promptText = `Recent codebase diffs:\n\n${diff.slice(0, 15000)}`;
    if (agentContexts) {
        promptText += `\n\nProject Agent Instructions & Repository Guidelines:\n\n${agentContexts}`;
    }
    if (fileContexts) {
        promptText += `\n\nFull contents of modified files in recent diffs:\n\n${fileContexts}`;
    }
    if (testContexts) {
        promptText += `\n\nExisting test files from this repository (follow these conventions exactly when writing tests):\n\n${testContexts}`;
    }
    if (existingPRContext) {
        promptText += `\n\nPull requests the Code Janitor has ALREADY submitted (do NOT re-propose these changes):\n\n${existingPRContext}`;
    }

    console.log("🤖 Querying model for refactor proposals...");
    const result = await generateStructuredWithTools(fixesResponseSchema, systemPrompt, promptText, tools);

    if (result.fixes.length > maxPRs) {
        console.log(`⚠️ Model returned ${result.fixes.length} refactor proposals; capping to maxPRs (${maxPRs}).`);
    }
    return result.fixes.slice(0, maxPRs);
}

export async function attemptAutoFix(
    fix: FixProposal,
    failedStep: string,
    failureOutput: string,
    currentChanges: FileChange[],
    workDir: string,
    originalContents?: Map<string, string>
): Promise<{ success: boolean; updatedChanges: FileChange[]; verifResult: ReturnType<typeof runVerification> }> {
    console.log(`\n⚠️ Verification/Integrity failed during ${failedStep}. Attempting auto-fix retry...`);
    logFailedDiff(fix, workDir);

    const agentContexts = getAgentFilesContext(workDir);
    const agentHeader = agentContexts ? `\n\nProject Agent Instructions & Repository Guidelines:\n\n${agentContexts}` : '';
    const testContexts = getSiblingTestContexts(currentChanges.map(c => c.filePath), workDir);
    const testHeader = testContexts
        ? `\n\nExisting test files from this repository (follow these conventions exactly when writing tests):\n\n${testContexts}`
        : '';
    const tools = createJanitorTools(workDir);

    const retrySchema = z.object({
        explanation: z.string().describe('Explanation of how the failure or integrity issue is fixed'),
        changes: z.array(fileChangeSchema).min(1).describe('Revised content for all modified files, as targeted edits against the current content (preferred) or full updated file contents'),
    });

    const retrySystemPrompt = `
    You are an expert software engineer fixing a failing test, lint check, or file integrity violation caused by a refactoring attempt.
    Analyze the failure log output, original file contents, and current file contents across all modified files in 'changes', then generate revised versions of the file contents that resolve all failures and integrity errors while preserving the core refactoring intent.
    When the failure output says an edit could not be applied, the file on disk is UNCHANGED: re-derive your edit from the current content shown below (copying 'oldText' verbatim), or fall back to a complete 'updatedContent'.

    STRICT RULES:
    1. ${changeFormatRule()} Edits are matched against the CURRENT content shown below, not the original content.
    2. PRESERVE API CONTRACTS: Keep existing parameter signatures intact or update callers consistently across modified files.
    3. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT swallow warnings, delete caller functions, or use non-existent library imports.
    4. RESPECT IDIOMATIC TEST PLACEMENT: Follow language conventions for test placement. Do not add test framework imports or test runner annotations to production source files.
    5. NON-TRIVIAL AUTO-FIX: When fixing an integrity violation (such as missing top-level declarations), carefully weave the missing original declarations back into your modified file alongside your refactoring logic. Do NOT resolve the issue by reverting the file entirely to its original content (which produces zero diffs and causes PR creation to be skipped).
    6. TRAILING NEWLINE MANDATE: when you supply 'updatedContent', it MUST ALWAYS end with a trailing newline character (\\n).
    7. RESPECT AGENT INSTRUCTIONS: Respect any project agent instructions or repository rules provided in AGENTS.md, .agents files, or related agent configurations.
    8. MATCH EXISTING TEST CONVENTIONS: When the failure is in a test file, mirror the existing test files provided in the context exactly: same test framework and runner, same import/package/module declarations, and the same helper and fixture utilities. Compilation failures in tests are usually caused by imports, helpers, or assertion APIs that do not exist in this project.
    9. RESPECT LINE BUDGETS (ENFORCED IN CODE): The revised files must stay within ${maxLineDiff} total diff lines across non-test (production) files and ${maxTestLineDiff} total diff lines across test files, counted against the original contents. When the failure above is a line budget violation, shrink the change itself (narrow the refactor, keep untouched regions byte-identical) rather than reverting the file or deleting tests.
    10. WORKSPACE TOOLS: You have access to interactive workspace tools ('read_file', 'list_directory', 'run_command'). Use them if you need additional workspace context.
`;
    try {
        const fileContentsText = currentChanges.map(c => {
            const orig = originalContents?.get(c.filePath);
            return `--- File: ${c.filePath} ---\n${orig ? `Original Content:\n${orig}\n\n` : ''}Current Content:\n${c.updatedContent ?? '(file not written -- its edits could not be applied)'}`;
        }).join('\n\n');

        const retryPromptText = `Proposed Fix Title: ${fix.title}\n\nFailure Output (${failedStep}):\n${failureOutput}${agentHeader}${testHeader}\n\nModified Files:\n${fileContentsText}`;

        const retryResult = await generateStructuredWithTools(retrySchema, retrySystemPrompt, retryPromptText, tools);

        console.log(`🤖 Auto-fix proposal: ${retryResult.explanation}`);
        const updatedChanges = retryResult.changes;
        for (const change of updatedChanges) {
            const safePath = sanitizeRelativePath(workDir, change.filePath);
            if (!safePath) {
                throw new Error(`Refusing to write outside workspace: "${change.filePath}"`);
            }
            change.filePath = safePath;
            const absolutePath = path.resolve(workDir, safePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

            if (isEditBasedChange(change)) {
                // Retry edits are anchored to what is on disk now (the proposal already
                // applied, or the untouched file when its edits failed), which is the
                // content the model was shown as "Current Content".
                const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
                const applied = applyEdits(current, change.edits!, safePath);
                if (!applied.ok) {
                    console.warn(`⚠️ Auto-fix edit could not be applied: ${applied.reason}`);
                    return {
                        success: false,
                        updatedChanges: currentChanges,
                        verifResult: { success: false, failureOutput: applied.reason, failedStep: 'edit-apply' }
                    };
                }
                change.updatedContent = ensureTrailingNewline(applied.content);
            } else if (change.updatedContent === undefined) {
                const reason = `Edit Apply Failed: auto-fix change for ${safePath} contained neither 'edits' nor 'updatedContent'.`;
                console.warn(`⚠️ ${reason}`);
                return {
                    success: false,
                    updatedChanges: currentChanges,
                    verifResult: { success: false, failureOutput: reason, failedStep: 'edit-apply' }
                };
            } else {
                change.updatedContent = ensureTrailingNewline(change.updatedContent);
            }

            fs.writeFileSync(absolutePath, change.updatedContent!, 'utf-8');
        }

        console.log(`Rerunning verification after auto-fix attempt...`);
        const verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
        return { success: verifResult.success, updatedChanges, verifResult };
    } catch (retryErr) {
        console.error(`Failed during auto-fix generation/execution:`, retryErr);
        return {
            success: false,
            updatedChanges: currentChanges,
            verifResult: { success: false, failureOutput: String(retryErr), failedStep: 'retry' }
        };
    }
}



