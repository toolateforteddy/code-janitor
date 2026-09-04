import { FileEdit } from './config.js';

export interface EditApplyResult {
    ok: boolean;
    content: string;
    reason: string;
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
}

function replaceAllOccurrences(haystack: string, needle: string, replacement: string): string {
    return haystack.split(needle).join(replacement);
}

/**
 * Locates `needle` in `haystack` comparing line-by-line with trailing whitespace
 * stripped. Models reproduce code they were shown almost verbatim, but routinely
 * differ in trailing spaces or a tab-vs-spaces indent, and an exact-match-only
 * search rejects an otherwise perfectly good edit for that. Returns the character
 * ranges of every matching block so the caller can still refuse an ambiguous edit.
 */
export function findFlexibleMatches(haystack: string, needle: string): Array<{ start: number; end: number }> {
    const needleLines = needle.split('\n');
    // A trailing newline in the needle yields an empty final element; drop it and
    // extend the matched range to the end of the last matched line instead.
    const needleEndsWithNewline = needleLines.length > 1 && needleLines[needleLines.length - 1] === '';
    const compareLines = needleEndsWithNewline ? needleLines.slice(0, -1) : needleLines;
    if (compareLines.length === 0) return [];

    const hayLines = haystack.split('\n');
    // Character offset of the start of each line, so a line-index match maps back
    // to a substring range in the original text.
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of hayLines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }

    const normalize = (line: string) => line.replace(/\s+$/, '').replace(/^[ \t]+/, indent => indent.replace(/\t/g, '    '));
    const normalizedNeedle = compareLines.map(normalize);
    const matches: Array<{ start: number; end: number }> = [];

    for (let i = 0; i + normalizedNeedle.length <= hayLines.length; i++) {
        let isMatch = true;
        for (let j = 0; j < normalizedNeedle.length; j++) {
            if (normalize(hayLines[i + j]) !== normalizedNeedle[j]) {
                isMatch = false;
                break;
            }
        }
        if (!isMatch) continue;

        const lastIdx = i + normalizedNeedle.length - 1;
        const start = lineStarts[i];
        let end = lineStarts[lastIdx] + hayLines[lastIdx].length;
        if (needleEndsWithNewline && lastIdx < hayLines.length - 1) {
            end += 1;
        }
        matches.push({ start, end });

        // Resume past this match rather than one line into it, so the returned ranges
        // never overlap. A self-similar snippet ("}\n}" against three "}" lines) would
        // otherwise yield overlapping ranges, and splicing the second over the first
        // silently mangles the file. This also matches the exact-match path, which
        // counts non-overlapping occurrences.
        i = lastIdx;
    }
    return matches;
}

/**
 * Applies search/replace edits to a file's existing content.
 *
 * This is the counterpart to full-file rewrites: because every byte outside an
 * edit's `oldText` is carried over untouched, a proposal cannot silently drop
 * unedited code the way a truncated rewrite can. Edits are applied in order, and
 * an edit that matches nothing — or matches ambiguously — fails loudly rather
 * than guessing, so the caller can hand the reason back to the model.
 */
export function applyEdits(originalContent: string, edits: FileEdit[], filePath: string = 'file'): EditApplyResult {
    if (!edits || edits.length === 0) {
        return { ok: false, content: originalContent, reason: `Edit Apply Failed: no edits supplied for ${filePath}.` };
    }

    const usedCrlf = /\r\n/.test(originalContent);
    let content = originalContent.replace(/\r\n/g, '\n');

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const oldText = (edit.oldText ?? '').replace(/\r\n/g, '\n');
        const newText = (edit.newText ?? '').replace(/\r\n/g, '\n');
        const label = `edit #${i + 1} in ${filePath}`;

        // An empty `oldText` means "this is the whole file" -- only legal when there
        // is nothing to preserve, otherwise it would silently discard the file.
        if (!oldText) {
            if (!content.trim()) {
                content = newText;
                continue;
            }
            return {
                ok: false,
                content: originalContent,
                reason: `Edit Apply Failed: ${label} has an empty 'oldText', but the file is not empty. Provide the exact existing snippet to replace, or use 'updatedContent' for a whole-file rewrite.`,
            };
        }

        const exactCount = countOccurrences(content, oldText);

        if (exactCount === 1) {
            const idx = content.indexOf(oldText);
            content = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
            continue;
        }

        if (exactCount > 1) {
            if (edit.replaceAll) {
                content = replaceAllOccurrences(content, oldText, newText);
                continue;
            }
            return {
                ok: false,
                content: originalContent,
                reason: `Edit Apply Failed: 'oldText' of ${label} matches ${exactCount} places in the file. Include more surrounding context so the snippet is unique, or set 'replaceAll' to true if every occurrence should change.`,
            };
        }

        const flexible = findFlexibleMatches(content, oldText);
        if (flexible.length === 0) {
            return {
                ok: false,
                content: originalContent,
                reason: `Edit Apply Failed: 'oldText' of ${label} was not found in the current file content. Copy the snippet verbatim from the file (including indentation) instead of retyping it from memory.`,
            };
        }
        if (flexible.length > 1 && !edit.replaceAll) {
            return {
                ok: false,
                content: originalContent,
                reason: `Edit Apply Failed: 'oldText' of ${label} matches ${flexible.length} places in the file. Include more surrounding context so the snippet is unique, or set 'replaceAll' to true if every occurrence should change.`,
            };
        }

        // Splice from the end so earlier ranges keep their offsets.
        for (const match of [...flexible].reverse()) {
            content = content.slice(0, match.start) + newText + content.slice(match.end);
            if (!edit.replaceAll) break;
        }
    }

    if (usedCrlf) {
        content = content.replace(/\r?\n/g, '\r\n');
    }

    return { ok: true, content, reason: '' };
}
