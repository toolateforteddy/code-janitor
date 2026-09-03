import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    getModel,
    FixProposal,
    getProposalChanges,
    isEditBasedChange,
    fileChangeSchema,
    ensureTrailingNewline,
    fixesResponseSchema,
    maxPRs,
    parseNonNegativeInt,
    parseLineBudget,
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

    describe('parseLineBudget()', () => {
        it('parses a positive integer', () => {
            assert.equal(parseLineBudget('250', 100), 250);
        });

        it('falls back when unset', () => {
            assert.equal(parseLineBudget(undefined, 100), 100);
        });

        it('falls back on an empty string', () => {
            assert.equal(parseLineBudget('', 100), 100);
        });

        it('falls back on a non-numeric value', () => {
            assert.equal(parseLineBudget('lots', 100), 100);
        });

        it('falls back on zero and negative values', () => {
            assert.equal(parseLineBudget('0', 100), 100);
            assert.equal(parseLineBudget('-5', 100), 100);
        });

        it('keeps the production and test budgets independent', () => {
            assert.equal(parseLineBudget('100', 100), 100);
            assert.equal(parseLineBudget('200', 200), 200);
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

        it('keeps edit-based changes intact without inventing updatedContent', () => {
            const fix: FixProposal = {
                slug: 'edit-slug',
                title: 'Edit PR',
                description: 'Description',
                changes: [
                    { filePath: 'src/main.rs', edits: [{ oldText: 'fn main() {}', newText: 'fn main() { run(); }' }] },
                ]
            };
            const changes = getProposalChanges(fix);
            assert.equal(changes.length, 1);
            assert.equal(changes[0].edits?.length, 1);
            // Content is resolved when the edits are applied to the real file, not here;
            // fabricating a value would truncate the target file to a single newline.
            assert.equal(changes[0].updatedContent, undefined);
        });

        it('drops a change that carries neither edits nor updatedContent', () => {
            const fix: FixProposal = {
                slug: 'empty-slug',
                title: 'Empty PR',
                description: 'Description',
                changes: [
                    { filePath: 'src/ghost.rs' },
                    { filePath: 'src/real.rs', updatedContent: 'fn real() {}' },
                ]
            };
            const changes = getProposalChanges(fix);
            assert.equal(changes.length, 1);
            assert.equal(changes[0].filePath, 'src/real.rs');
        });
    });

    describe('fileChangeSchema', () => {
        it('accepts an edits-only change, a content-only change, and reports which is edit-based', () => {
            const editChange = fileChangeSchema.parse({
                filePath: 'a.ts',
                edits: [{ oldText: 'a', newText: 'b' }],
            });
            const contentChange = fileChangeSchema.parse({ filePath: 'b.ts', updatedContent: 'x\n' });
            assert.equal(isEditBasedChange(editChange), true);
            assert.equal(isEditBasedChange(contentChange), false);
        });
    });

    describe('parseNonNegativeInt()', () => {
        it('accepts zero so retrying can be turned off entirely', () => {
            assert.equal(parseNonNegativeInt('0', 4), 0);
        });

        it('parses positive values', () => {
            assert.equal(parseNonNegativeInt('7', 4), 7);
        });

        it('falls back on unset, non-numeric, and negative values', () => {
            assert.equal(parseNonNegativeInt(undefined, 4), 4);
            assert.equal(parseNonNegativeInt('', 4), 4);
            assert.equal(parseNonNegativeInt('lots', 4), 4);
            assert.equal(parseNonNegativeInt('-1', 4), 4);
        });
    });

    describe('fixesResponseSchema', () => {
        it('does not reject a response with more fixes than maxPRs (capping happens in code, not schema validation)', () => {
            const overCount = maxPRs + 5;
            const fixes = Array.from({ length: overCount }, (_, i) => ({
                slug: `fix-${i}`,
                title: `Fix ${i}`,
                description: 'desc',
                changes: [{ filePath: `file${i}.ts`, updatedContent: 'content' }],
            }));
            const parsed = fixesResponseSchema.parse({ fixes });
            assert.equal(parsed.fixes.length, overCount);
        });
    });

});
