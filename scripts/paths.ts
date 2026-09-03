import * as path from 'path';

const TEST_BASENAME_PATTERNS: RegExp[] = [
    /_test\.(go|py|rs|ts|tsx|js|jsx|mjs|cjs|dart)$/i,
    /^test_.+\.(py|rs)$/i,
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i,
    /(Test|Tests|Spec|Specs)\.(java|kt|kts|cs|scala|swift)$/,
    /_spec\.rb$/i,
];

const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing']);

const SOURCE_EXTENSIONS = new Set([
    '.go', '.py', '.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.java', '.kt', '.kts', '.cs', '.scala', '.swift', '.rb', '.dart',
]);

/**
 * Recognizes test files across the ecosystems Code Janitor supports, either by
 * language naming convention (`foo_test.go`, `foo.test.ts`, `FooTest.kt`) or by
 * living inside a conventional test directory (`tests/`, `__tests__/`, `src/test/`).
 *
 * Lives in its own module (rather than next to its first caller in ai.ts) so the
 * line-budget check can classify files without pulling the AI SDK into the
 * integrity path.
 */
export function isTestFilePath(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/');
    const basename = path.posix.basename(normalized);
    if (TEST_BASENAME_PATTERNS.some(pattern => pattern.test(basename))) {
        return true;
    }
    const ext = path.posix.extname(basename).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) return false;
    return normalized
        .split('/')
        .slice(0, -1)
        .some(segment => TEST_DIR_NAMES.has(segment.toLowerCase()));
}
