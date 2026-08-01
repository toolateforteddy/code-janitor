import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    getModel,
    FixProposal,
    getProposalChanges,
    ensureTrailingNewline,
} from './config.js';

describe('config module test suite', () => {

    describe('getModel()', () => {
        it('returns a model object for google provider', () => {
            const model = getModel('google', 'gemini-3.6-flash');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });

        it('returns a model object for anthropic provider', () => {
            const model = getModel('anthropic', 'claude-3-5-sonnet-20241022');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });

        it('returns a model object for openai provider', () => {
            const model = getModel('openai', 'gpt-4o');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });

        it('defaults to google model for unknown provider', () => {
            const model = getModel('unknown', 'custom-model');
            assert.ok(model);
            assert.equal(typeof model, 'object');
        });
    });

    describe('ensureTrailingNewline()', () => {
        it('appends newline when string does not end with one', () => {
            assert.equal(ensureTrailingNewline('hello'), 'hello\n');
        });

        it('preserves existing trailing newline', () => {
            assert.equal(ensureTrailingNewline('hello\n'), 'hello\n');
        });

        it('returns newline for empty string', () => {
            assert.equal(ensureTrailingNewline(''), '\n');
        });
    });

    describe('getProposalChanges()', () => {
        it('returns changes array when present and ensures trailing newlines', () => {
            const fix: FixProposal = {
                slug: 'test-slug',
                title: 'Test PR',
                description: 'Description',
                changes: [
                    { filePath: 'src/main.rs', updatedContent: 'fn main() {}' },
                    { filePath: 'tests/main_test.rs', updatedContent: '#[test] fn test() {}\n' }
                ]
            };
            const changes = getProposalChanges(fix);
            assert.equal(changes.length, 2);
            assert.equal(changes[0].filePath, 'src/main.rs');
            assert.equal(changes[0].updatedContent, 'fn main() {}\n');
            assert.equal(changes[1].filePath, 'tests/main_test.rs');
            assert.equal(changes[1].updatedContent, '#[test] fn test() {}\n');
        });

        it('falls back to single filePath and updatedContent for legacy proposals and enforces trailing newline', () => {
            const fix: FixProposal = {
                slug: 'legacy-slug',
                title: 'Legacy PR',
                description: 'Legacy description',
                filePath: 'src/lib.rs',
                updatedContent: 'pub fn lib() {}'
            };
            const changes = getProposalChanges(fix);
            assert.equal(changes.length, 1);
            assert.equal(changes[0].filePath, 'src/lib.rs');
            assert.equal(changes[0].updatedContent, 'pub fn lib() {}\n');
        });
    });

});
