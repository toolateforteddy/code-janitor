import { generateObject } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import {
    provider,
    modelName,
    testCmd,
    testTimeoutMs,
    lintCmd,
    enableTestGen,
    maxPRs,
    maxLineDiff,
    fileChangeSchema,
    FileChange,
    FixProposal,
    fixesResponseSchema,
    getModel,
} from './config.js';
import { runVerification } from './git.js';

export async function generateRepairProposals(buildErrorLogs: string): Promise<FixProposal[]> {
    const repairPrompt = `
    You are an expert software engineer and debugger.
    The project build or test suite is currently FAILING on the main branch.

    Analyze the build errors provided below and generate minimal, atomic fixes to resolve the issue and make the test suite pass.
    
    RULES:
    1. Fix ONLY what is necessary to resolve the build or test failures.
    2. Do NOT introduce new features or unnecessary refactoring.
    3. Keep diffs as concise as possible (under ~${maxLineDiff} total diff lines across all modified files).
    4. MULTI-FILE PROPOSALS SUPPORTED: Include all modified files in the 'changes' array. You can modify up to 5 related files in a single proposal (e.g., fixing a function signature and updating callers/test files).
    5. PRESERVE ALL EXISTING TOP-LEVEL DECLARATIONS: Each file's 'updatedContent' MUST contain the full updated file. Do NOT delete or omit existing top-level functions, composables, classes, or declarations.
    6. PRESERVE API CONTRACTS: If you modify a function signature, update all relevant caller sites across modified files in 'changes'.
    7. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT resolve warnings or errors by adding language suppression annotations (e.g. @Suppress) or deleting callers. Ensure imported standard library functions exist and are valid.
    8. RESPECT IDIOMATIC TEST PLACEMENT: Follow language-idiomatic conventions for test placement (e.g. in-file conditional modules where supported, or dedicated test files/directories).
    9. NON-TRIVIAL CHANGES REQUIRED: Each file in 'changes' MUST contain actual code additions, deletions, or modifications to resolve the failure. Do NOT output proposals where 'updatedContent' is identical to existing file content.
  `;

    console.log("🔧 Querying model for repair proposals...");
    const response = await generateObject({
        model: getModel(provider, modelName),
        schema: fixesResponseSchema,
        system: repairPrompt,
        prompt: `Build/Test Error Logs:\n\n${buildErrorLogs.slice(0, 15000)}`,
    });

    return response.object.fixes;
}

export async function generateFixProposals(diff: string): Promise<FixProposal[]> {
    const systemPrompt = `
    You are an expert static analyzer and software maintainer.
    Analyze the recent git diffs and identify up to ${maxPRs} distinct, high-value improvements or edge-case unit tests.
    
    RULES:
    1. Each fix MUST be completely self-contained and atomic.
    2. Do NOT propose changes larger than ~${maxLineDiff} total diff lines across all modified files.
    3. MULTI-FILE PROPOSALS SUPPORTED: Each proposal specifies a 'changes' array containing 1 to 5 file modifications. You can pair a production file refactor with a separate unit test file or update caller sites when modifying a signature.
    4. ${enableTestGen ? 'Feel free to generate unit tests for uncovered paths using language-idiomatic test patterns.' : 'Do NOT generate test files or test classes; focus only on code refactoring.'}
    5. Focus on idiomatic improvements, resource cleanup, performance, or edge-case bug fixes.
    6. PRESERVE ALL EXISTING TOP-LEVEL DECLARATIONS: 'updatedContent' MUST contain the full updated content for each file. Do NOT delete or omit existing top-level functions, composables, classes, or declarations.
    7. PRESERVE API CONTRACTS: If you modify a function signature, update all relevant call sites across modified files in 'changes'.
    8. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT swallow warnings or delete callers. Verify that all standard library functions and imports exist before using them.
    9. RESPECT IDIOMATIC TEST PLACEMENT: Follow language and project conventions for test structure and placement.
    10. NON-TRIVIAL CHANGES REQUIRED: Every proposed file change MUST include concrete code modifications, additions, or deletions compared to existing code. Do NOT output a proposal if 'updatedContent' is identical to the current code.
  `;

    console.log("🤖 Querying model for refactor proposals...");
    const response = await generateObject({
        model: getModel(provider, modelName),
        schema: fixesResponseSchema,
        system: systemPrompt,
        prompt: `Recent codebase diffs:\n\n${diff.slice(0, 15000)}`,
    });

    return response.object.fixes;
}

export async function attemptAutoFix(
    fix: FixProposal,
    failedStep: string,
    failureOutput: string,
    currentChanges: FileChange[],
    workDir: string,
    originalContents?: Map<string, string>
): Promise<{ success: boolean; updatedChanges: FileChange[]; verifResult: ReturnType<typeof runVerification> }> {
    console.log(`\n⚠️ Verification/Integrity failed during ${failedStep}. Attempting auto-fix retry...`);

    const retrySchema = z.object({
        explanation: z.string().describe('Explanation of how the failure or integrity issue is fixed'),
        changes: z.array(fileChangeSchema).min(1).describe('Full updated file contents for all modified files'),
    });

    const retrySystemPrompt = `
    You are an expert software engineer fixing a failing test, lint check, or file integrity violation caused by a refactoring attempt.
    Analyze the failure log output, original file contents, and current file contents across all modified files in 'changes', then generate revised versions of the file contents that resolve all failures and integrity errors while preserving the core refactoring intent.

    STRICT RULES:
    1. PRESERVE ALL EXISTING TOP-LEVEL DECLARATIONS: Do NOT delete, truncate, or omit existing top-level functions, composables, or classes from the original files. 'updatedContent' MUST contain the ENTIRE file for each change.
    2. PRESERVE API CONTRACTS: Keep existing parameter signatures intact or update callers consistently across modified files.
    3. NO UNJUSTIFIED SUPPRESSIONS & VALID APIS: Do NOT swallow warnings, delete caller functions, or use non-existent library imports.
    4. RESPECT IDIOMATIC TEST PLACEMENT: Follow language conventions for test placement. Do not add test framework imports or test runner annotations to production source files.
`;
    try {
        const fileContentsText = currentChanges.map(c => {
            const orig = originalContents?.get(c.filePath);
            return `--- File: ${c.filePath} ---\n${orig ? `Original Content:\n${orig}\n\n` : ''}Current Content:\n${c.updatedContent}`;
        }).join('\n\n');

        const retryPromptText = `Proposed Fix Title: ${fix.title}\n\nFailure Output (${failedStep}):\n${failureOutput}\n\nModified Files:\n${fileContentsText}`;

        const retryResponse = await generateObject({
            model: getModel(provider, modelName),
            schema: retrySchema,
            system: retrySystemPrompt,
            prompt: retryPromptText,
        });

        console.log(`🤖 Auto-fix proposal: ${retryResponse.object.explanation}`);
        const updatedChanges = retryResponse.object.changes;
        for (const change of updatedChanges) {
            const absolutePath = path.resolve(workDir, change.filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, change.updatedContent, 'utf-8');
        }

        console.log(`Rerunning verification after auto-fix attempt...`);
        const verifResult = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
        return { success: verifResult.success, updatedChanges, verifResult };
    } catch (retryErr) {
        console.error(`Failed during auto-fix generation/execution:`, retryErr);
        return {
            success: false,
            updatedChanges: currentChanges,
            verifResult: { success: false, failureOutput: String(retryErr), failedStep: 'retry' }
        };
    }
}
