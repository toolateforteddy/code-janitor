import * as path from 'path';
import { FileChange, isEditBasedChange, enforceLineBudget } from './config.js';
import { validateLineBudget } from './linebudget.js';

// Tried in order per line; the first pattern that matches wins. Go's grammar (method
// receivers, "type"-prefixed declarations) doesn't fit the shared C-like keyword
// alternation below, so it gets its own patterns ahead of it.
const DECLARATION_PATTERNS: RegExp[] = [
    // Go method with receiver: func (r *T) Name(...) or func (r *T) Name[T any](...)
    /^func\s+\([^)]*\)\s+([A-Za-z0-9_]+)\s*[\[(]/,
    // Go top-level function: func Name(...) or func Name[T any](...)
    /^func\s+([A-Za-z0-9_]+)\s*[\[(]/,
    // Go type declaration: type Name struct { / interface { / = Alias / OtherType
    /^type\s+([A-Za-z0-9_]+)\b/,
    // Shared C-like / OOP / scripting language keywords.
    /^(?:export\s+)?(?:pub\s+)?(?:async\s+)?(?:@\w+(?:\([^)]*\))?\s+)*(?:fun|function|class|interface|object|struct|enum|trait|def|fn)\s+([A-Za-z0-9_]+)/,
];

export function extractTopLevelDeclarations(content: string, _ext: string): string[] {
    const lines = content.split(/\r?\n/);
    const declarations: string[] = [];

    for (const line of lines) {
        if (/^\s+/.test(line)) continue;

        for (const pattern of DECLARATION_PATTERNS) {
            const match = line.match(pattern);
            if (match && match[1]) {
                declarations.push(match[1]);
                break;
            }
        }
    }
    return declarations;
}

export interface IntegrityOptions {
    /**
     * The change was expressed as targeted search/replace edits rather than a
     * whole-file rewrite. Code outside an edit is copied through untouched, so a
     * missing declaration can only be a deliberate deletion -- never the silent
     * truncation the declaration check exists to catch. Skipping that check here is
     * the point of edit-style changes: it removes the retry loop that a large file
     * plus a chatty model would otherwise trigger. The mass-deletion and
     * test-import checks still run, because those catch intent, not truncation.
     */
    editBased?: boolean;
}

export function validateSingleFileIntegrity(originalContent: string, updatedContent: string, filePath: string, options: IntegrityOptions = {}): { valid: boolean; reason: string } {
    if (!originalContent || !originalContent.trim()) {
        return { valid: true, reason: '' };
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    const isProductionPath = (normalizedPath.includes('/src/main/') || normalizedPath.startsWith('src/main/'));
    if (isProductionPath) {
        const testImportRegex = /import\s+(?:org\.junit|org\.testng|junit\.framework|kotlin\.test|org\.scalatest|@jest\/globals)/i;
        if (testImportRegex.test(updatedContent) && !testImportRegex.test(originalContent)) {
            return {
                valid: false,
                reason: `Integrity Check Failed: Attempted to add test framework imports into production source file '${filePath}'. Test code must be placed in appropriate test files or test source sets (e.g., src/test/).`
            };
        }
    }

    if (!options.editBased) {
        const ext = path.extname(filePath).toLowerCase();
        const origDeclarations = extractTopLevelDeclarations(originalContent, ext);
        const updatedDeclarations = new Set(extractTopLevelDeclarations(updatedContent, ext));

        const missingDeclarations = origDeclarations.filter(decl => !updatedDeclarations.has(decl));

        if (missingDeclarations.length > 0) {
            return {
                valid: false,
                reason: `Integrity Check Failed: Fix omitted top-level declaration(s) in ${filePath}: [${missingDeclarations.join(', ')}]. Do not remove existing top-level functions or classes.`
            };
        }
    }

    const origLines = originalContent.split(/\r?\n/).length;
    const updatedLines = updatedContent.split(/\r?\n/).length;

    if (origLines > 25 && updatedLines < origLines * 0.5) {
        return {
            valid: false,
            reason: `Integrity Check Failed: Fix removed ${origLines - updatedLines} lines (${Math.round((1 - updatedLines / origLines) * 100)}% of file in ${filePath}), which exceeds allowable deletion limits.`
        };
    }

    return { valid: true, reason: '' };
}

export function validateFixIntegrity(
    originalContentOrMap: string | Map<string, string>,
    updatedContentOrChanges: string | FileChange[],
    filePath?: string
): { valid: boolean; reason: string } {
    if (typeof originalContentOrMap === 'string' && typeof updatedContentOrChanges === 'string' && filePath) {
        return validateSingleFileIntegrity(originalContentOrMap, updatedContentOrChanges, filePath);
    }

    const changes = Array.isArray(updatedContentOrChanges) ? updatedContentOrChanges : [];
    const origMap = originalContentOrMap instanceof Map ? originalContentOrMap : new Map<string, string>();

    for (const change of changes) {
        const orig = origMap.get(change.filePath) || '';
        // updatedContent is resolved (edits applied) before validation runs; a change
        // that never resolved has nothing to validate.
        if (change.updatedContent === undefined) continue;
        const res = validateSingleFileIntegrity(orig, change.updatedContent, change.filePath, { editBased: isEditBasedChange(change) });
        if (!res.valid) {
            return res;
        }
    }

    // Budget check last: per-file integrity problems are more actionable feedback
    // for the auto-fix retry than "too big", and a proposal that fails both should
    // be told about the structural break first.
    if (enforceLineBudget) {
        const budget = validateLineBudget(origMap, changes);
        if (!budget.valid) {
            return { valid: false, reason: budget.reason };
        }
    }

    return { valid: true, reason: '' };
}
