import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectExecution } from './code-janitor.js';

describe('code-janitor main module test suite', () => {

    describe('isDirectExecution()', () => {
        it('returns false when code-janitor is imported from test runner', () => {
            const direct = isDirectExecution();
            assert.equal(direct, false);
        });
    });

});
