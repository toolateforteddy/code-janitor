import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { JanitorState } from './config.js';
import {
    runCmd,
    runVerification,
    getDefaultBranch,
    buildPathSpecArgs,
    getGitDiff,
    getDiffOverview,
    filterDiffToFiles,
    getUncachedBaseCommit,
    updateCursor,
    cleanupWorktree,
    isJanitorCommit,
    partitionWindowCommits,
} from './git.js';

describe('git module test suite', () => {

    describe('buildPathSpecArgs()', () => {
        it('returns empty string when target is dot and no excludes', () => {
            const result = buildPathSpecArgs('.', '');
            assert.equal(result, '');
        });

        it('formats target path correctly when non-root', () => {
            const result = buildPathSpecArgs('src', '');
            assert.equal(result, ' -- "src"');
        });

        it('formats workflow exclude path correctly', () => {
            const result = buildPathSpecArgs('.', '.github/workflows/**');
            assert.equal(result, ' ":(exclude).github/workflows/**"');
        });

        it('formats multiple comma-separated exclude paths correctly', () => {
            const result = buildPathSpecArgs('.', '.github/workflows/**, vendor/**, dist/**, generated/**');
            assert.equal(result, ' ":(exclude).github/workflows/**" ":(exclude)vendor/**" ":(exclude)dist/**" ":(exclude)generated/**"');
        });

        it('combines target path and exclude paths with extra whitespace trimmed', () => {
            const result = buildPathSpecArgs('pkg/sub', ' vendor/** , build/* ');
            assert.equal(result, ' -- "pkg/sub" ":(exclude)vendor/**" ":(exclude)build/*"');
        });
    });

    describe('runCmd()', () => {
        it('executes a successful shell command and returns output', () => {
            const res = runCmd('node -v', 'test-node-version');
            assert.equal(res.success, true);
            assert.match(res.output, /^v\d+/);
        });

        it('captures failure when a command exits non-zero', () => {
            const res = runCmd('node -e "process.exit(1)"', 'test-failure');
            assert.equal(res.success, false);
            assert.ok(res.output.length > 0);
        });

        it('handles command execution timeouts', () => {
            const start = Date.now();
            const res = runCmd('node -e "setTimeout(() => {}, 10000)"', 'test-timeout', 200);
            const elapsed = Date.now() - start;
            assert.equal(res.success, false);
            assert.match(res.output, /timed out/i);
            assert.ok(elapsed < 5000, `Execution should have timed out early, took ${elapsed}ms`);
        });

        it('executes command in specified custom working directory', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-cwd-'));
            try {
                const res = runCmd('node -e "console.log(process.cwd())"', 'test-cwd', undefined, tempDir);
                assert.equal(res.success, true);
                assert.equal(path.resolve(res.output.trim()), path.resolve(tempDir));
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('runVerification()', () => {
        it('returns success when both lint and test commands pass', () => {
            const res = runVerification('node -v', 'node -v');
            assert.equal(res.success, true);
            assert.equal(res.failedStep, '');
            assert.equal(res.failureOutput, '');
        });

        it('stops early and returns lint failure when lint command fails', () => {
            const res = runVerification('node -e "process.exit(1)"', 'node -v');
            assert.equal(res.success, false);
            assert.equal(res.failedStep, 'lint');
            assert.ok(res.failureOutput.length > 0);
        });

        it('returns test failure when lint passes but test command fails', () => {
            const res = runVerification('node -v', 'node -e "process.exit(1)"');
            assert.equal(res.success, false);
            assert.equal(res.failedStep, 'test');
            assert.ok(res.failureOutput.length > 0);
        });

        it('skips lint step when lint command is empty', () => {
            const res = runVerification('', 'node -v');
            assert.equal(res.success, true);
            assert.equal(res.failedStep, '');
        });
    });

    describe('getDefaultBranch()', () => {
        it('returns a non-empty branch string', () => {
            const branch = getDefaultBranch();
            assert.equal(typeof branch, 'string');
            assert.ok(branch.length > 0);
        });
    });

    describe('getUncachedBaseCommit()', () => {
        it('returns empty string when currentHead is empty', () => {
            const res = getUncachedBaseCommit('');
            assert.equal(res, '');
        });

        it('returns a valid commit hash for uncached repository HEAD', () => {
            const headRes = getGitDiff('');
            if (headRes.currentHead) {
                const base = getUncachedBaseCommit(headRes.currentHead);
                assert.ok(base);
                assert.equal(typeof base, 'string');
                assert.ok(base.length >= 7);
            }
        });
    });

    describe('updateCursor() and getGitDiff() cursor state handling', () => {
        it('writes cursor state to specified state file path', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const testHash = 'a1b2c3d4e5f67890123456789012345678901234';
                updateCursor(testHash, tempFile);
                assert.equal(fs.existsSync(tempFile), true);

                const data: JanitorState = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
                assert.equal(data.lastAnalyzedCommit, testHash);
                assert.ok(data.lastRunTimestamp);
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });

        it('returns empty diff when cursor matches current HEAD', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const headRes = getGitDiff('', tempFile);
                if (headRes.currentHead) {
                    updateCursor(headRes.currentHead, tempFile);
                    const sameRes = getGitDiff('', tempFile);
                    assert.equal(sameRes.diff, '');
                    assert.equal(sameRes.baseCommit, headRes.currentHead);
                }
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });

        it('falls back gracefully if state file contains invalid/stale commit', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const fakeState = { lastAnalyzedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', lastRunTimestamp: new Date().toISOString() };
                fs.writeFileSync(tempFile, JSON.stringify(fakeState), 'utf-8');

                const diffRes = getGitDiff('', tempFile);
                assert.notEqual(diffRes.baseCommit, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
                assert.ok(diffRes.baseCommit);
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });

        it('uses uncached base commit determination when state file does not exist', () => {
            const nonExistentState = path.join(os.tmpdir(), `non-existent-janitor-state-${Date.now()}.json`);
            const diffRes = getGitDiff('', nonExistentState);
            assert.ok(diffRes.baseCommit);
            assert.equal(typeof diffRes.baseCommit, 'string');
        });

        it('returns a diff larger than execSync\'s default 1 MiB buffer', () => {
            const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-bigdiff-'));
            const stateFile = path.join(repo, 'state.json');
            const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
            try {
                git('init -q');
                git('-c user.email=t@t -c user.name=t commit -q --allow-empty -m base');
                const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
                fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(100) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(15000));
                git('add big.txt');
                git('-c user.email=t@t -c user.name=t commit -q -m big');
                updateCursor(base, stateFile);

                const res = getGitDiff(' -- big.txt', stateFile, repo);
                assert.equal(res.failed, undefined);
                assert.ok(res.diff.length > 1024 * 1024);
            } finally {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });

        it('reports failure instead of an empty diff when the range cannot be diffed', () => {
            const tempFile = path.join(os.tmpdir(), `janitor-state-test-${Date.now()}.json`);
            try {
                const headRes = getGitDiff('', tempFile);
                if (headRes.currentHead) {
                    updateCursor(`${headRes.currentHead}~1`, tempFile);
                    const res = getGitDiff(' -- ":(bogus-magic)x"', tempFile);
                    assert.equal(res.failed, true);
                    assert.equal(res.diff, '');
                }
            } finally {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        });
    });

    describe('isJanitorCommit()', () => {
        it('recognizes the janitor as author, whatever the case', () => {
            assert.equal(isJanitorCommit('bot@codejanitor.local', 'refactor: x'), true);
            assert.equal(isJanitorCommit('Bot@CodeJanitor.local', 'refactor: x'), true);
        });

        it('recognizes a squash-merge by its trailer or the janitor as co-author', () => {
            assert.equal(isJanitorCommit('41898282+github-actions[bot]@users.noreply.github.com', '🧹 Tidy x (#12)\n\nBody\n\nCode-Janitor: refactor\n'), true);
            assert.equal(isJanitorCommit('me@example.com', 'Fix (#3)\n\n* fix: y\n\nCo-authored-by: Code Janitor Bot <bot@codejanitor.local>'), true);
        });

        it('recognizes trailer with case variations', () => {
            assert.equal(isJanitorCommit('me@example.com', 'Fix (#3)\n\nCode-Janitor: Refactor'), true);
            assert.equal(isJanitorCommit('me@example.com', 'Fix (#3)\n\ncode-janitor: repair'), true);
        });

        it('handles non-string or falsy input gracefully', () => {
            assert.equal(isJanitorCommit(undefined as any, 'refactor: x'), false);
            assert.equal(isJanitorCommit('bot@codejanitor.local', undefined as any), true);
            assert.equal(isJanitorCommit(null as any, null as any), false);
        });

        it('does not mistake a person writing about the janitor for the janitor', () => {
            assert.equal(isJanitorCommit('me@example.com', 'Code janitor: move to a new model'), false);
            assert.equal(isJanitorCommit('me@example.com', 'Code-Janitor: please ignore my commits too'), false);
            assert.equal(isJanitorCommit('me@example.com', 'Mention bot@codejanitor.local in docs'), false);
        });
    });

    describe('getGitDiff() and the janitor\'s own commits', () => {
        const setUpRepo = () => {
            const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-own-'));
            const git = (args: string) => execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            const human = '-c user.email=me@example.com -c user.name=me';
            const bot = '-c user.email=bot@codejanitor.local -c user.name="Code Janitor Bot"';
            const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
            git('init -q -b main');
            write('a.txt', 'a\n');
            write('b.txt', 'b\n');
            git('add .');
            git(`${human} commit -q -m base`);
            const base = git('rev-parse HEAD');
            const stateFile = path.join(repo, '.janitor-state.json');
            updateCursor(base, stateFile);
            return { repo, git, human, bot, write, base, stateFile };
        };

        it('finds nothing to review when every commit since the cursor is the janitor\'s', () => {
            const { repo, git, human, bot, write, stateFile } = setUpRepo();
            try {
                // A janitor PR merged with a merge commit by a person.
                git('switch -q -c janitor/one');
                write('a.txt', 'a tidied\n');
                git(`${bot} commit -q -am "refactor: tidy a" -m "Code-Janitor: refactor"`);
                git('switch -q main');
                git(`${human} merge -q --no-ff janitor/one -m "Merge pull request #1 from o/janitor/one"`);
                // A janitor PR squash-merged: a person's authorship, the trailer kept.
                write('b.txt', 'b tidied\n');
                git(`${human} commit -q -am "🧹 Tidy b (#2)" -m "Code-Janitor: refactor"`);

                const res = getGitDiff('', stateFile, repo);
                assert.equal(res.diff, '');
                assert.equal(res.janitorCommits, 2);
                assert.equal(res.failed, undefined);
            } finally {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });

        it('keeps the files somebody else touched when the window is mixed', () => {
            const { repo, git, human, bot, write, stateFile } = setUpRepo();
            try {
                write('a.txt', 'a by the janitor\n');
                git(`${bot} commit -q -am "refactor: tidy a"`);
                write('b.txt', 'b by a person\n');
                git(`${human} commit -q -am "Change b"`);

                const res = getGitDiff('', stateFile, repo);
                assert.equal(res.janitorCommits, 1);
                assert.match(res.diff, /^diff --git a\/b\.txt b\/b\.txt$/m);
                assert.ok(!res.diff.includes('a.txt'));
            } finally {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });

        it('leaves a window with no janitor commits as it was', () => {
            const { repo, git, human, write, stateFile } = setUpRepo();
            try {
                write('a.txt', 'a by a person\n');
                git(`${human} commit -q -am "Change a"`);

                const res = getGitDiff('', stateFile, repo);
                assert.equal(res.janitorCommits, undefined);
                assert.match(res.diff, /a by a person/);
            } finally {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });

        it('partitions commits, skipping merges', () => {
            const { repo, git, human, bot, write, base } = setUpRepo();
            try {
                git('switch -q -c janitor/one');
                write('a.txt', 'a tidied\n');
                git(`${bot} commit -q -am "refactor: tidy a"`);
                git('switch -q main');
                write('b.txt', 'b by a person\n');
                git(`${human} commit -q -am "Change b"`);
                git(`${human} merge -q --no-ff janitor/one -m "Merge janitor/one"`);

                const parts = partitionWindowCommits(`${base}..HEAD`, repo);
                assert.ok(parts);
                assert.equal(parts.janitor.length, 1);
                assert.equal(parts.others.length, 1);
                assert.equal(partitionWindowCommits('no-such-ref..HEAD', repo), null);
            } finally {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });
    });

    describe('filterDiffToFiles()', () => {
        const diff = [
            'diff --git a/src/a.kt b/src/a.kt\nindex 1..2 100644\n--- a/src/a.kt\n+++ b/src/a.kt\n@@ -1 +1 @@\n-a\n+A\n',
            'diff --git a/src/b.kt b/src/b.kt\nindex 1..2 100644\n--- a/src/b.kt\n+++ b/src/b.kt\n@@ -1 +1 @@\n-b\n+B\n',
            'diff --git a/old.kt b/new.kt\nsimilarity index 90%\nrename from old.kt\nrename to new.kt\n',
        ];

        it('keeps only the sections for the requested files, in diff order', () => {
            assert.equal(filterDiffToFiles(diff.join(''), ['src/b.kt', 'src/a.kt']), diff[0] + diff[1]);
        });

        it('matches a renamed file by its new path', () => {
            assert.equal(filterDiffToFiles(diff.join(''), ['new.kt']), diff[2]);
        });

        it('returns an empty string when nothing matches', () => {
            assert.equal(filterDiffToFiles(diff.join(''), ['missing.kt']), '');
        });

        it('matches quoted diff header paths', () => {
            const quotedDiff = 'diff --git \"a/my file.kt\" \"b/my file.kt\"\nindex 1..2 100644\n--- \"a/my file.kt\"\n+++ \"b/my file.kt\"\n@@ -1 +1 @@\n-a\n+A\n';
            assert.equal(filterDiffToFiles(quotedDiff, ['my file.kt']), quotedDiff);
        });
    });

    describe('getDiffOverview()', () => {
        it('lists the commits and per-file counts without diff bodies', () => {
            const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-overview-'));
            const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
            try {
                git('init -q');
                git('-c user.email=t@t -c user.name=t commit -q --allow-empty -m base');
                const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
                fs.mkdirSync(path.join(repo, 'a/very/long/directory/path/that/stat/would/shorten'), { recursive: true });
                const longPath = 'a/very/long/directory/path/that/stat/would/shorten/File.kt';
                fs.writeFileSync(path.join(repo, longPath), 'secret body line\n');
                git('add .');
                git('-c user.email=t@t -c user.name=t commit -q -m "Add the file"');
                const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();

                const overview = getDiffOverview(base, head, '', repo);
                assert.match(overview, /Add the file/);
                assert.ok(overview.includes(`1\t0\t${longPath}`));
                assert.ok(!overview.includes('secret body line'));
            } finally {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });
    });

    describe('cleanupWorktree()', () => {
        it('removes directory safely if it exists', () => {
            const tempWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-worktree-test-'));
            assert.equal(fs.existsSync(tempWorktree), true);

            cleanupWorktree(tempWorktree);

            assert.equal(fs.existsSync(tempWorktree), false);
        });

        it('does not throw when attempting to clean up a non-existent path', () => {
            const fakePath = path.join(os.tmpdir(), `non-existent-worktree-${Date.now()}`);
            assert.doesNotThrow(() => {
                cleanupWorktree(fakePath);
            });
        });
    });

});
