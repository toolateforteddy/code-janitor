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

        it('extracts Go top-level functions, methods with receivers, and type declarations', () => {
            const goCode = `
package handlers

import "net/http"

type Server struct {
	addr string
}

type Handler interface {
	Serve(w http.ResponseWriter)
}

func NewServer(addr string) *Server {
	return &Server{addr: addr}
}

func (s *Server) Start() error {
	return nil
}

func Generic[T any](items []T) []T {
	return items
}
`;
            const decls = extractTopLevelDeclarations(goCode, '.go');
            assert.deepEqual(decls, ['Server', 'Handler', 'NewServer', 'Start', 'Generic']);
        });

        it('rejects a Go refactor that drops a method or type (default janitor_mode language)', () => {
            const original = `
package auth

type Token struct {
	Value string
}

func (t *Token) Valid() bool {
	return t.Value != ""
}

func NewToken(v string) *Token {
	return &Token{Value: v}
}
`;
            const brokenUpdated = `
package auth

type Token struct {
	Value string
}

func NewToken(v string) *Token {
	return &Token{Value: v}
}
`;
            const res = validateFixIntegrity(original, brokenUpdated, 'token.go');
            assert.equal(res.valid, false);
            assert.match(res.reason, /Valid/);
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

        it('rejects a multi-file proposal that blows the production line budget', () => {
            // Default MAX_LINE_DIFF is 100 diff lines across non-test files.
            const body = (n: number, prefix: string) =>
                Array.from({ length: n }, (_, i) => `\t${prefix}${i}()`).join('\n');
            const origMap = new Map<string, string>([['src/App.kt', 'fun mainApp() {\n}\n']]);
            const changes = [
                { filePath: 'src/App.kt', updatedContent: `fun mainApp() {\n${body(150, 'step')}\n}\n` },
            ];
            const res = validateFixIntegrity(origMap, changes);
            assert.equal(res.valid, false);
            assert.match(res.reason, /Line Budget Check Failed/);
        });

        it('does not count test-file lines against the production budget', () => {
            const body = (n: number, prefix: string) =>
                Array.from({ length: n }, (_, i) => `\t${prefix}${i}()`).join('\n');
            const origMap = new Map<string, string>([
                ['src/App.kt', 'fun mainApp() {\n}\n'],
                ['src/test/AppTest.kt', ''],
            ]);
            const changes = [
                { filePath: 'src/App.kt', updatedContent: `fun mainApp() {\n${body(20, 'step')}\n}\n` },
                { filePath: 'src/test/AppTest.kt', updatedContent: `class AppTest {\n${body(150, 'check')}\n}\n` },
            ];
            const res = validateFixIntegrity(origMap, changes);
            assert.equal(res.valid, true);
        });

        it('reports the structural integrity break before the line budget when a proposal fails both', () => {
            const body = (n: number, prefix: string) =>
                Array.from({ length: n }, (_, i) => `\t${prefix}${i}()`).join('\n');
            const origMap = new Map<string, string>([['src/App.kt', 'fun mainApp() {\n}\nfun helper() {\n}\n']]);
            const changes = [
                { filePath: 'src/App.kt', updatedContent: `fun mainApp() {\n${body(200, 'step')}\n}\n` },
            ];
            const res = validateFixIntegrity(origMap, changes);
            assert.equal(res.valid, false);
            assert.match(res.reason, /Integrity Check Failed/);
            assert.match(res.reason, /helper/);
        });
    });

});
