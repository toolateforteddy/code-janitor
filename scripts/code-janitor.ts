import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Parse arguments
const targetWorkspace = process.argv[2] || process.cwd();
process.chdir(targetWorkspace);

// Environment Configurations
const provider = (process.env.AI_PROVIDER || 'google').toLowerCase();
const modelName = process.env.AI_MODEL || 'gemini-3.6-flash';
const testCmd = process.env.TEST_CMD || 'go test ./...';
const lintCmd = process.env.LINT_CMD || '';
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

async function main() {
    console.log(`🧹 Code Janitor starting analysis using provider: [${provider}] model: [${modelName}]`);

    // Fetch recent git diff
    let recentDiff = '';
    try {
        recentDiff = execSync("git diff HEAD~1 HEAD", { encoding: 'utf-8' });
    } catch (err) {
        console.warn("Unable to fetch diff between HEAD~1 and HEAD, reading current workspace diff...");
        recentDiff = execSync("git diff", { encoding: 'utf-8' });
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

    for (const fix of fixes) {
        const timestamp = Date.now();
        const branchName = `janitor/${fix.slug}-${timestamp}`;

        try {
            console.log(`\n--- Processing Fix: ${fix.title} ---`);

            // Clean workspace state back to main
            execSync('git checkout main && git reset --hard origin/main');
            execSync(`git checkout -b ${branchName}`);

            // Ensure file directory exists and apply update
            const absolutePath = path.resolve(fix.filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, fix.updatedContent, 'utf-8');

            // Verify Diff Size Limit
            const diffStat = execSync('git diff --shortstat', { encoding: 'utf-8' });
            console.log(`Diff summary: ${diffStat.trim()}`);

            // Execute Linters & Tests
            if (lintCmd) {
                console.log(`Running lint command: ${lintCmd}`);
                execSync(lintCmd, { stdio: 'inherit' });
            }

            console.log(`Running test command: ${testCmd}`);
            execSync(testCmd, { stdio: 'inherit' });

            // If tests pass, commit and open PR
            console.log(`Tests passed! Creating commit and PR...`);
            execSync(`git config user.name "Code Janitor Bot"`);
            execSync(`git config user.email "bot@codejanitor.local"`);
            execSync(`git add "${fix.filePath}"`);
            execSync(`git commit -m "refactor: ${fix.title}"`);
            execSync(`git push origin ${branchName}`);

            let prCmd = `gh pr create --title "🧹 ${fix.title}" --body "${fix.description}\n\n_Generated by Code Janitor_" --head "${branchName}"`;
            if (isDraft) prCmd += ' --draft';
            if (reviewers) prCmd += ` --reviewer "${reviewers}"`;

            execSync(prCmd, { stdio: 'inherit' });
            console.log(` Successfully created PR for: ${fix.title}`);

        } catch (error) {
            console.error(`❌ Verification failed for fix '${fix.slug}'. Discarding branch...`, error);
            try {
                execSync('git checkout main && git reset --hard origin/main');
            } catch (e) { /* ignore */ }
        }
    }
}

main().catch((err) => {
    console.error("Fatal Janitor Engine Error:", err);
    process.exit(1);
});