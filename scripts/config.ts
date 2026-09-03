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
export const maxLineDiff = parseInt(process.env.MAX_LINE_DIFF || '100', 10);
export const reviewers = process.env.REVIEWERS || '';
export const isDraft = process.env.DRAFT_PR === 'true';
export const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY || '3', 10);
export const enableLlmTools = process.env.ENABLE_LLM_TOOLS !== 'false';
export const maxLlmToolSteps = parseInt(process.env.MAX_LLM_TOOL_STEPS || '5', 10);

export const STATE_FILE = '.janitor-state.json';

export interface JanitorState {
    lastAnalyzedCommit: string;
    lastRunTimestamp: string;
}

// Schema for proposed atomic fixes
export const fileChangeSchema = z.object({
    filePath: z.string().describe('Relative path to the file being created or modified (MUST preserve existing repository directory structure and package folders)'),
    updatedContent: z.string().describe('Full new content for the file'),
});

export type FileChange = z.infer<typeof fileChangeSchema>;

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
    return changes.map(c => ({
        ...c,
        updatedContent: ensureTrailingNewline(c.updatedContent)
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
