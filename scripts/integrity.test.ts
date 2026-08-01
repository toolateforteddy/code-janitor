import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractTopLevelDeclarations,
    validateFixIntegrity,
} from './integrity.js';

describe('integrity module test suite', () => {

    describe('extractTopLevelDeclarations() & validateFixIntegrity()', () => {
        it('extracts top-level declarations across languages', () => {
            const ktCode = `
package fyi.teddy.grocery
@Composable
fun NeedPhaseContent() { }
@OptIn
fun NeedItemTile() { }
`;
            const decls = extractTopLevelDeclarations(ktCode, '.kt');
            assert.deepEqual(decls, ['NeedPhaseContent', 'NeedItemTile']);
        });

        it('detects when top-level functions are omitted in refactored code', () => {
            const original = `
@Composable
fun NeedPhaseContent() {
    // 50 lines of layout
}
@Composable
fun NeedItemTile() { }
`;
            const brokenUpdated = `
@Composable
fun NeedItemTile() {
    // refactored swipe
}
`;
            const res = validateFixIntegrity(original, brokenUpdated, 'NeedPhaseContent.kt');
            assert.equal(res.valid, false);
            assert.match(res.reason, /NeedPhaseContent/);
        });

        it('passes integrity check when all declarations are preserved', () => {
            const original = `
fun TopA() {}
fun TopB() {}
`;
            const validUpdated = `
fun TopA() { /* modified */ }
fun TopB() { /* modified */ }
`;
            const res = validateFixIntegrity(original, validUpdated, 'File.kt');
            assert.equal(res.valid, true);
        });

        it('allows brand new files', () => {
            const res = validateFixIntegrity('', 'fun NewFun() {}', 'NewFile.kt');
            assert.equal(res.valid, true);
        });

        it('rejects test framework imports added to production source files', () => {
            const original = `package com.example\nfun mainApp() {}\n`;
            const updatedWithJUnit = `package com.example\nimport org.junit.Test\nfun mainApp() {}\nclass AppTest { @Test fun t() {} }`;
            const res = validateFixIntegrity(original, updatedWithJUnit, 'src/main/java/com/example/App.kt');
            assert.equal(res.valid, false);
            assert.match(res.reason, /test framework imports/i);
        });

        it('validates multi-file changes correctly via Map and Array', () => {
            const origMap = new Map<string, string>([
                ['src/main/java/App.kt', 'fun mainApp() {}\n'],
                ['src/test/java/AppTest.kt', '']
            ]);
            const changes = [
                { filePath: 'src/main/java/App.kt', updatedContent: 'fun mainApp() { println("hello") }\n' },
                { filePath: 'src/test/java/AppTest.kt', updatedContent: 'import org.junit.Test\nclass AppTest { @Test fun t() {} }\n' }
            ];
            const res = validateFixIntegrity(origMap, changes);
            assert.equal(res.valid, true);
        });
    });

});
