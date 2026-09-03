import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileChange } from './config.js';
import { applyEdits, findFlexibleMatches } from './edits.js';
import { applyChangesToWorkspace } from './pr.js';

describe('edits module test suite', () => {

    describe('applyEdits()', () => {
        const original = [
            'package main',
            '',
            'func Add(a int, b int) int {',
            '\treturn a + b',
            '}',
            '',
            'func Sub(a int, b int) int {',
            '\treturn a - b',
            '}',
            '',
        ].join('\n');

        it('replaces a unique snippet and preserves every untouched line', () => {
            const res = applyEdits(original, [{ oldText: '\treturn a + b', newText: '\treturn b + a' }], 'math.go');
            assert.equal(res.ok, true);
            assert.equal(res.reason, '');
            assert.match(res.content, /return b \+ a/);
            // The whole point of edit-style changes: unedited declarations survive.
            assert.match(res.content, /func Sub\(a int, b int\) int \{/);
            assert.match(res.content, /return a - b/);
            assert.match(res.content, /^package main/);
        });

        it('applies multiple edits in order', () => {
            const res = applyEdits(original, [
                { oldText: 'func Add(a int, b int) int {', newText: 'func Add(a, b int) int {' },
                { oldText: 'func Sub(a int, b int) int {', newText: 'func Sub(a, b int) int {' },
            ], 'math.go');
            assert.equal(res.ok, true);
            assert.match(res.content, /func Add\(a, b int\) int \{/);
            assert.match(res.content, /func Sub\(a, b int\) int \{/);
        });

        it('deletes a snippet when newText is empty', () => {
            const res = applyEdits(original, [{ oldText: '\nfunc Sub(a int, b int) int {\n\treturn a - b\n}\n', newText: '\n' }], 'math.go');
            assert.equal(res.ok, true);
            assert.equal(res.content.includes('func Sub'), false);
            assert.match(res.content, /func Add/);
        });

        it('rejects a snippet that does not appear in the file', () => {
            const res = applyEdits(original, [{ oldText: 'return a * b', newText: 'return b * a' }], 'math.go');
            assert.equal(res.ok, false);
            assert.match(res.reason, /was not found/);
            assert.equal(res.content, original, 'a failed edit must leave the file untouched');
        });

        it('rejects an ambiguous snippet unless replaceAll is set', () => {
            const dupes = 'x := 1\ny := 2\nx := 1\n';
            const ambiguous = applyEdits(dupes, [{ oldText: 'x := 1', newText: 'x := 3' }], 'dupe.go');
            assert.equal(ambiguous.ok, false);
            assert.match(ambiguous.reason, /matches 2 places/);
            assert.equal(ambiguous.content, dupes);

            const all = applyEdits(dupes, [{ oldText: 'x := 1', newText: 'x := 3', replaceAll: true }], 'dupe.go');
            assert.equal(all.ok, true);
            assert.equal(all.content, 'x := 3\ny := 2\nx := 3\n');
        });

        it('tolerates trailing-whitespace and tab/space indent drift in oldText', () => {
            // Models retype snippets from memory; a space-for-tab swap should not
            // cost a whole retry round trip.
            const res = applyEdits(original, [{ oldText: '    return a + b   ', newText: '\treturn b + a' }], 'math.go');
            assert.equal(res.ok, true);
            assert.match(res.content, /return b \+ a/);
            assert.match(res.content, /func Sub/);
        });

        it('rejects an empty oldText against a non-empty file', () => {
            const res = applyEdits(original, [{ oldText: '', newText: 'wiped' }], 'math.go');
            assert.equal(res.ok, false);
            assert.match(res.reason, /empty 'oldText'/);
            assert.equal(res.content, original);
        });

        it('treats an empty oldText as whole-file content for an empty/new file', () => {
            const res = applyEdits('', [{ oldText: '', newText: 'package main\n' }], 'new.go');
            assert.equal(res.ok, true);
            assert.equal(res.content, 'package main\n');
        });

        it('rejects an empty edits array', () => {
            const res = applyEdits(original, [], 'math.go');
            assert.equal(res.ok, false);
            assert.match(res.reason, /no edits supplied/);
        });

        it('preserves CRLF line endings', () => {
            const crlf = 'line one\r\nline two\r\n';
            const res = applyEdits(crlf, [{ oldText: 'line two', newText: 'line 2' }], 'win.txt');
            assert.equal(res.ok, true);
            assert.equal(res.content, 'line one\r\nline 2\r\n');
        });
    });

    describe('findFlexibleMatches()', () => {
        it('returns every matching block', () => {
            const matches = findFlexibleMatches('a\nb\na\nb\n', 'a\nb');
            assert.equal(matches.length, 2);
        });

        it('returns nothing when the block is absent', () => {
            assert.deepEqual(findFlexibleMatches('a\nb\n', 'c\nd'), []);
        });
    });

    describe('applyChangesToWorkspace()', () => {
        const withTempDir = (fn: (dir: string) => void) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-edits-'));
            try {
                fn(dir);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        };

        it('resolves edit-based changes against the file on disk', () => {
            withTempDir(dir => {
                fs.writeFileSync(path.join(dir, 'app.ts'), 'export function a() {}\nexport function b() {}\n');
                const changes: FileChange[] = [{ filePath: 'app.ts', edits: [{ oldText: 'export function a() {}', newText: 'export function a() { return 1; }' }] }];
                const { originalContents, editFailures } = applyChangesToWorkspace(dir, changes);

                assert.deepEqual(editFailures, []);
                assert.equal(originalContents.get('app.ts'), 'export function a() {}\nexport function b() {}\n');
                const onDisk = fs.readFileSync(path.join(dir, 'app.ts'), 'utf-8');
                assert.equal(onDisk, 'export function a() { return 1; }\nexport function b() {}\n');
                assert.equal(changes[0].updatedContent, onDisk);
            });
        });

        it('leaves the file untouched and reports a reason when an edit does not apply', () => {
            withTempDir(dir => {
                const before = 'export function a() {}\n';
                fs.writeFileSync(path.join(dir, 'app.ts'), before);
                const changes: FileChange[] = [{ filePath: 'app.ts', edits: [{ oldText: 'export function zzz() {}', newText: 'x' }] }];
                const { editFailures } = applyChangesToWorkspace(dir, changes);

                assert.equal(editFailures.length, 1);
                assert.match(editFailures[0], /was not found/);
                assert.equal(fs.readFileSync(path.join(dir, 'app.ts'), 'utf-8'), before);
            });
        });

        it('still writes full-content changes and creates new files', () => {
            withTempDir(dir => {
                const changes = [{ filePath: 'nested/new.ts', updatedContent: 'export const x = 1;\n' }];
                const { originalContents, editFailures } = applyChangesToWorkspace(dir, changes);

                assert.deepEqual(editFailures, []);
                assert.equal(originalContents.get('nested/new.ts'), '');
                assert.equal(fs.readFileSync(path.join(dir, 'nested/new.ts'), 'utf-8'), 'export const x = 1;\n');
            });
        });

        it('refuses to write outside the workspace', () => {
            withTempDir(dir => {
                assert.throws(
                    () => applyChangesToWorkspace(dir, [{ filePath: '../escape.ts', updatedContent: 'x' }]),
                    /Refusing to write outside workspace/
                );
            });
        });
    });
});
