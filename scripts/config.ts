import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

// Set API key fallback for Google provider
if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

// Environment Configurations
export const provider = (process.env.AI_PROVIDER || 'google').toLowerCase();
export const modelName = process.env.AI_MODEL || 'gemini-3.6-flash';
export const testCmd = process.env.TEST_CMD || 'go test ./...';
const testTimeoutMinutes = parseInt(process.env.TEST_TIMEOUT || '5', 10);
export const testTimeoutMs = (isNaN(testTimeoutMinutes) || testTimeoutMinutes <= 0 ? 5 : testTimeoutMinutes) * 60 * 1000;
export const lintCmd = process.env.LINT_CMD || '';
export const installCmd = process.env.INSTALL_CMD || '';
export const autoInstall = process.env.AUTO_INSTALL !== 'false';
const installTimeoutMinutes = parseInt(process.env.INSTALL_TIMEOUT || '10', 10);
export const installTimeoutMs = (isNaN(installTimeoutMinutes) || installTimeoutMinutes <= 0 ? 10 : installTimeoutMinutes) * 60 * 1000;
export const mode = (process.env.JANITOR_MODE || 'auto').toLowerCase();
export const targetPath = process.env.TARGET_PATH || '.';
export const excludePathsStr = process.env.EXCLUDE_PATHS || '.github/workflows/**, vendor/**, generated/**, dist/**';
export const enableTestGen = process.env.ENABLE_TEST_GEN === 'true';
export const maxPRs = parseInt(process.env.MAX_PRS || '3', 10);
export function parseLineBudget(raw: string | undefined, fallback: number): number {
    const parsed = parseInt(raw ?? '', 10);
    return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export const maxLineDiff = parseLineBudget(process.env.MAX_LINE_DIFF, 100);
// Test code is inherently verbose (table cases, fixtures, setup/teardown). Counting it
// against the production budget pushes the model toward thin tests or dropping them
// altogether, so tests get their own budget.
export const maxTestLineDiff = parseLineBudget(process.env.MAX_TEST_LINE_DIFF, 200);
// The budgets above are stated in the prompt, but a model is free to ignore a
// prompt, so they are also enforced in code against the actual proposed diff
// (see linebudget.ts). Set ENFORCE_LINE_BUDGET=false to go back to prompt-only.
export const enforceLineBudget = process.env.ENFORCE_LINE_BUDGET !== 'false';
export const reviewers = process.env.REVIEWERS || '';
export const isDraft = process.env.DRAFT_PR === 'true';
export const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY || '3', 10);
export const enableLlmTools = process.env.ENABLE_LLM_TOOLS !== 'false';
export const maxLlmToolSteps = parseInt(process.env.MAX_LLM_TOOL_STEPS || '5', 10);
// Deduplication is on unless explicitly disabled: without it a nightly repair sweep
// re-observes the same red main branch and opens a fresh PR for the same fix every run.
export const dedupePRs = process.env.DEDUPE_PRS !== 'false';
// Ask the model for targeted search/replace edits instead of whole-file rewrites.
// Rewrites force the model to re-emit every unedited line, which is where truncated
// declarations (and the integrity failures that reject them) come from. Set
// EDIT_FORMAT=rewrite to go back to full-file content for every change.
export const editFormat = (process.env.EDIT_FORMAT || 'edits').toLowerCase();
export const preferEdits = editFormat !== 'rewrite';

export const STATE_FILE = '.janitor-state.json';

/** Prefix for every branch the janitor creates; also how its own PRs are recognized later. */
export const JANITOR_BRANCH_PREFIX = 'janitor/';

export interface JanitorState {
    lastAnalyzedCommit: string;
    lastRunTimestamp: string;
}

// Schema for proposed atomic fixes
export const fileEditSchema = z.object({
    oldText: z.string().describe('Exact snippet copied verbatim from the current file content (including indentation) that should be replaced. Must appear exactly once in the file unless replaceAll is true.'),
    newText: z.string().describe('Replacement text for oldText. Use an empty string to delete the snippet.'),
    replaceAll: z.boolean().optional().describe('Set to true only when every occurrence of oldText in the file should be replaced'),
});

export type FileEdit = z.infer<typeof fileEditSchema>;

// A file change is expressed EITHER as targeted search/replace edits (preferred for
// existing files: untouched code is preserved by construction, so a truncated
// response cannot silently drop declarations) OR as a full-file rewrite (required
// for new files). Neither field is required by the schema: a `refine`/required
// combination would fail JSON-schema validation for the whole batch when a model
// gets one change wrong, discarding every good proposal alongside it. Changes that
// carry neither are dropped in getProposalChanges instead.
export const fileChangeSchema = z.object({
    filePath: z.string().describe('Relative path to the file being created or modified (MUST preserve existing repository directory structure and package folders)'),
    edits: z.array(fileEditSchema).min(1).max(20).optional().describe('Targeted search/replace edits to apply to the existing file. PREFERRED for modifying existing files.'),
    updatedContent: z.string().optional().describe('Full new content for the file. Required for NEW files; for existing files prefer "edits".'),
});

export type FileChange = z.infer<typeof fileChangeSchema>;

/** True when the change is expressed as targeted edits rather than a whole-file rewrite. */
export function isEditBasedChange(change: FileChange): boolean {
    return Array.isArray(change.edits) && change.edits.length > 0;
}

export const fixProposalSchema = z.object({
    slug: z.string().describe('Short url-safe string for git branch, e.g., fix-nil-pointer'),
    title: z.string().describe('Concise PR title'),
    description: z.string().describe('Explanation of the refactor, added test, or callsite updates'),
    changes: z.array(fileChangeSchema).min(1).max(5).describe('List of file changes included in this atomic fix (e.g. prod file refactor + separate test file, or function signature change + updated callsites)').optional(),
    filePath: z.string().optional().describe('Deprecated single file path; prefer "changes" array'),
    updatedContent: z.string().optional().describe('Deprecated single file updated content; prefer "changes" array'),
});

// No .max(maxPRs) here: with generateObject/generateText JSON-schema validation, a
// response that returns more fixes than requested would fail schema validation
// entirely and the whole batch would be discarded. Cap in code instead (see
// generateRepairProposals/generateFixProposals in ai.ts) so a model that overshoots
// still yields the first `maxPRs` proposals rather than zero.
export const fixesResponseSchema = z.object({
    fixes: z.array(fixProposalSchema),
});

export type FixProposal = z.infer<typeof fixProposalSchema>;

export function ensureTrailingNewline(content: string): string {
    if (!content) return '\n';
    return content.endsWith('\n') ? content : content + '\n';
}

export function getProposalChanges(fix: FixProposal): FileChange[] {
    let changes: FileChange[] = [];
    if (fix.changes && Array.isArray(fix.changes) && fix.changes.length > 0) {
        changes = fix.changes;
    } else if (fix.filePath && fix.updatedContent !== undefined) {
        changes = [{ filePath: fix.filePath, updatedContent: fix.updatedContent }];
    }
    return changes
        // A change with neither edits nor content says nothing about what to write;
        // normalizing it would truncate the target file to a single newline.
        .filter(c => isEditBasedChange(c) || c.updatedContent !== undefined)
        .map(c => ({
            ...c,
            updatedContent: c.updatedContent !== undefined ? ensureTrailingNewline(c.updatedContent) : undefined,
        }));
}

export function getModel(prov: string, mod: string) {
    switch (prov) {
        case 'anthropic':
            return anthropic(mod || 'claude-3-5-sonnet-20241022');
        case 'openai':
            return openai(mod || 'gpt-4o');
        case 'google':
        default:
            return google(mod || 'gemini-3.6-flash');
    }
}
