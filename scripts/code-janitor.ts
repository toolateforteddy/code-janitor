import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { execSync, execFileSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Set API key fallback for Google provider
if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

// Parse arguments
const targetWorkspace = process.argv[2] || process.cwd();
process.chdir(targetWorkspace);

// Environment Configurations
const provider = (process.env.AI_PROVIDER || 'google').toLowerCase();
const modelName = process.env.AI_MODEL || 'gemini-3.6-flash';
const testCmd = process.env.TEST_CMD || 'go test ./...';
const testTimeoutMinutes = parseInt(process.env.TEST_TIMEOUT || '5', 10);
const testTimeoutMs = (isNaN(testTimeoutMinutes) || testTimeoutMinutes <= 0 ? 5 : testTimeoutMinutes) * 60 * 1000;
const lintCmd = process.env.LINT_CMD || '';
const targetPath = process.env.TARGET_PATH || '.';
const excludePathsStr = process.env.EXCLUDE_PATHS || '';
const enableTestGen = process.env.ENABLE_TEST_GEN === 'true';
const maxPRs = parseInt(process.env.MAX_PRS || '3', 10);
const maxLineDiff = parseInt(process.env.MAX_LINE_DIFF || '100', 10);
const reviewers = process.env.REVIEWERS || '';
const isDraft = process.env.DRAFT_PR === 'true';

function getModel(prov: string, mod: string) {
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

function runCmd(command: string, label: string, timeoutMs?: number): { success: boolean; output: string } {
    console.log(`Running ${label} command: ${command}`);
    try {
        const execOptions: ExecSyncOptionsWithStringEncoding = {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        };
        if (timeoutMs && timeoutMs > 0) {
            execOptions.timeout = timeoutMs;
        }
        const stdout = execSync(command, execOptions);
        if (stdout.trim()) {
            console.log(stdout.trim());
        }
        return { success: true, output: stdout };
    } catch (err: any) {
        const stdout = err.stdout ? err.stdout.toString() : '';
        const stderr = err.stderr ? err.stderr.toString() : '';
        let combined = (stdout + '\n' + stderr).trim();
        if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
            const timeoutMinutes = timeoutMs ? timeoutMs / 60000 : 0;
            const timeoutMsg = `❌ Command timed out after ${timeoutMinutes} minute(s).`;
            combined = combined ? `${combined}\n${timeoutMsg}` : timeoutMsg;
        } else if (!combined) {
            combined = err.message || 'Command failed';
        }
        console.error(`❌ ${label} command failed:\n${combined}`);
        return { success: false, output: combined };
    }
}

function runVerification(lCmd: string, tCmd: string, tTimeoutMs?: number): { success: boolean; failureOutput: string; failedStep: string } {
    if (lCmd) {
        const lintRes = runCmd(lCmd, 'lint');
        if (!lintRes.success) {
            return { success: false, failureOutput: lintRes.output, failedStep: 'lint' };
        }
    }
    if (tCmd) {
        const testRes = runCmd(tCmd, 'test', tTimeoutMs);
        if (!testRes.success) {
            return { success: false, failureOutput: testRes.output, failedStep: 'test' };
        }
    }
    return { success: true, failureOutput: '', failedStep: '' };
}

async function main() {
    console.log(`🧹 Code Janitor starting analysis using provider: [${provider}] model: [${modelName}]`);

    // Detect base/default branch dynamically
    let defaultBranch = 'main';
    try {
        defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim() || 'main';
    } catch {
        // Fallback to main
    }

    // Build diff target path arguments
    let pathSpecArgs = '';
    if (targetPath && targetPath !== '.') {
        pathSpecArgs += ` -- "${targetPath}"`;
    }
    if (excludePathsStr) {
        const excludes = excludePathsStr.split(',').map(p => p.trim()).filter(Boolean);
        for (const ex of excludes) {
            pathSpecArgs += ` ":(exclude)${ex}"`;
        }
    }

    // Fetch recent git diff
    let recentDiff = '';
    try {
        recentDiff = execSync(`git diff HEAD~1 HEAD${pathSpecArgs}`, { encoding: 'utf-8' });
    } catch (err) {
        console.warn("Unable to fetch diff between HEAD~1 and HEAD, reading current workspace diff...");
        recentDiff = execSync(`git diff${pathSpecArgs}`, { encoding: 'utf-8' });
    }

    if (!recentDiff.trim()) {
        console.log("No recent diff content detected. Janitor task completed.");
        return;
    }

    // Schema for proposed atomic fixes
    const schema = z.object({
        fixes: z.array(z.object({
            slug: z.string().describe('Short url-safe string for git branch, e.g., fix-nil-pointer'),
            title: z.string().describe('Concise PR title'),
            description: z.string().describe('Explanation of the refactor or added test'),
            filePath: z.string().describe('Relative path to the target file'),
            updatedContent: z.string().describe('Full new content for the file'),
        })).max(maxPRs),
    });

    const systemPrompt = `
    You are an expert static analyzer and software maintainer.
    Analyze the recent git diffs and identify up to ${maxPRs} distinct, high-value improvements or edge-case unit tests.
    
    RULES:
    1. Each fix MUST be completely self-contained and atomic.
    2. Do NOT propose changes larger than ~${maxLineDiff} total diff lines.
    3. ${enableTestGen ? 'Feel free to generate table-driven unit tests for uncovered paths.' : 'Do NOT generate new test files; focus only on code refactoring.'}
    4. Focus on idiomatic improvements, resource cleanup, performance, or edge-case bug fixes.
  `;

    console.log("🤖 Querying model for refactor proposals...");
    const response = await generateObject({
        model: getModel(provider, modelName),
        schema: schema,
        system: systemPrompt,
        prompt: `Recent codebase diffs:\n\n${recentDiff.slice(0, 15000)}`,
    });

    const fixes = response.object.fixes;
    console.log(`Found ${fixes.length} proposed atomic improvements.`);
    if (fixes.length > 0) {
        console.log("Planned PRs:");
        fixes.forEach((fix, idx) => {
            console.log(`  ${idx + 1}. 🧹 ${fix.title}`);
        });
    }

    for (const fix of fixes) {
        const timestamp = Date.now();
        const branchName = `janitor/${fix.slug}-${timestamp}`;

        try {
            console.log(`\n--- Processing Fix: ${fix.title} ---`);

            // Clean workspace state back to base branch
            execFileSync('git', ['checkout', defaultBranch]);
            try {
                execFileSync('git', ['reset', '--hard', `origin/${defaultBranch}`]);
            } catch {
                execFileSync('git', ['reset', '--hard', defaultBranch]);
            }
            execFileSync('git', ['checkout', '-b', branchName]);

            // Ensure file directory exists and apply update
            const absolutePath = path.resolve(fix.filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            let currentContent = fix.updatedContent;
            fs.writeFileSync(absolutePath, currentContent, 'utf-8');

            // Verify Diff Size Limit
            const diffStat = execSync('git diff --shortstat', { encoding: 'utf-8' });
            console.log(`Diff summary: ${diffStat.trim()}`);

            // First verification pass
            let verifResult = runVerification(lintCmd, testCmd, testTimeoutMs);

            if (!verifResult.success) {
                console.log(`\n⚠️ Verification failed during ${verifResult.failedStep}. Attempting auto-fix retry...`);

                try {
                    const retrySchema = z.object({
                        explanation: z.string().describe('Explanation of how the test/lint failure is fixed'),
                        updatedContent: z.string().describe('Full updated file content'),
                    });

                    const retrySystemPrompt = `
    You are an expert software engineer fixing a failing test or lint check caused by a recent refactoring attempt.
    Analyze the failure log output and the target file content, then generate a revised version of the file content that resolves the failures while preserving the core refactoring intent.
`;
                    const retryResponse = await generateObject({
                        model: getModel(provider, modelName),
                        schema: retrySchema,
                        system: retrySystemPrompt,
                        prompt: `Target File: ${fix.filePath}\n\nProposed Fix Title: ${fix.title}\n\nFailure Output (${verifResult.failedStep}):\n${verifResult.failureOutput}\n\nCurrent File Content:\n${currentContent}`,
                    });

                    console.log(`🤖 Auto-fix proposal: ${retryResponse.object.explanation}`);
                    currentContent = retryResponse.object.updatedContent;
                    fs.writeFileSync(absolutePath, currentContent, 'utf-8');

                    console.log(`Rerunning verification after auto-fix attempt...`);
                    verifResult = runVerification(lintCmd, testCmd, testTimeoutMs);
                } catch (retryErr) {
                    console.error(`Failed during auto-fix generation/execution:`, retryErr);
                    verifResult = { success: false, failureOutput: String(retryErr), failedStep: 'retry' };
                }
            }

            if (!verifResult.success) {
                throw new Error(`Verification failed after initial run and retry attempt (${verifResult.failedStep}).`);
            }

            // If tests pass, commit and open PR
            console.log(`Tests passed! Creating commit and PR...`);
            execFileSync('git', ['config', 'user.name', 'Code Janitor Bot']);
            execFileSync('git', ['config', 'user.email', 'bot@codejanitor.local']);
            execFileSync('git', ['add', fix.filePath]);
            execFileSync('git', ['commit', '-m', `refactor: ${fix.title}`]);
            execFileSync('git', ['push', 'origin', branchName]);

            const prArgs = [
                'pr', 'create',
                '--title', `🧹 ${fix.title}`,
                '--body', `${fix.description}\n\n_Generated by Code Janitor_`,
                '--head', branchName
            ];
            if (isDraft) prArgs.push('--draft');
            if (reviewers) prArgs.push('--reviewer', reviewers);

            execFileSync('gh', prArgs, { stdio: 'inherit' });
            console.log(` Successfully created PR for: ${fix.title}`);

        } catch (error) {
            console.error(`❌ Verification failed for fix '${fix.slug}'. Discarding branch...`, error);
            try {
                let failedDiff = '';
                try {
                    failedDiff = execSync('git diff HEAD', { encoding: 'utf-8' });
                } catch {
                    failedDiff = execSync('git diff', { encoding: 'utf-8' });
                }
                console.log(`\n=================== FAILED FIX DIFF (${fix.slug}) ===================`);
                console.log(failedDiff.trim() || '(No diff output detected)');
                console.log(`====================================================================\n`);
            } catch (diffErr) {
                console.error(`Failed to print git diff for '${fix.slug}':`, diffErr);
            }

            try {
                execFileSync('git', ['checkout', defaultBranch]);
                execFileSync('git', ['reset', '--hard', defaultBranch]);
            } catch (e) { /* ignore */ }
        }
    }
}

main().catch((err) => {
    console.error("Fatal Janitor Engine Error:", err);
    process.exit(1);
});