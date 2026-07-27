import * as path from 'path';
import { FileChange } from './config.js';

export function extractTopLevelDeclarations(content: string, _ext: string): string[] {
    const lines = content.split(/\r?\n/);
    const declarations: string[] = [];

    for (const line of lines) {
        if (/^\s+/.test(line)) continue;

        const match = line.match(/^(?:export\s+)?(?:pub\s+)?(?:async\s+)?(?:@\w+(?:\([^)]*\))?\s+)*(?:fun|function|class|interface|object|struct|enum|trait|def|fn)\s+([A-Za-z0-9_]+)/);
        if (match && match[1]) {
            declarations.push(match[1]);
        }
    }
    return declarations;
}

export function validateSingleFileIntegrity(originalContent: string, updatedContent: string, filePath: string): { valid: boolean; reason: string } {
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
        const res = validateSingleFileIntegrity(orig, change.updatedContent, change.filePath);
        if (!res.valid) {
            return res;
        }
    }
    return { valid: true, reason: '' };
}
