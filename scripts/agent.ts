import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import {
    FileChange,
    FixProposal,
    lintCmd,
    testCmd,
    testTimeoutMs,
    maxLineDiff,
    maxTestLineDiff,
    enableTestGen,
    claudeCodeAgentMaxTurns,
    trustClaudeChecks,
} from './config.js';
import { CLAUDE_CODE_PROVIDER, generateWithClaudeCode } from './claudecode.js';
import { modelFallback } from './ai.js';
import { runVerification } from './git.js';
import { validateFixIntegrity } from './integrity.js';
import { recordClaudeCodeUsage } from './summary.js';
import { isQuotaExhaustedError } from './retry.js';

/**
 * The claude-code agent flow: Claude Code implements a planned fix by editing the
 * worktree and running the checks itself, instead of returning edits as JSON for the
 * janitor to apply and patch up.
 *
 * The janitor keeps every decision that matters. The agent can edit files only inside
 * the worktree and run exactly one command, a verify script that runs the configured
 * lint and test commands. Whatever it reports, the janitor then reads the result off
 * disk, enforces integrity and the line budgets, and runs lint and tests again itself
 * (unless trust_claude_checks is on and the verify script stamped this exact worktree
 * state as passing). A failure there earns the agent one more pass with the failure
 * output, the same single retry the edit flow's auto-fix gets.
 */

const AGENT_PASSES = 2;
/** Generous: a pass may run the test suite several times. */
const AGENT_TIMEOUT_MS = 45 * 60 * 1000;

export const agentReportSchema = z.object({
    summary: z.string().describe('What was changed and why, in a few sentences, for the pull request description'),
    checksPassed: z.boolean().describe('Whether the last run of the verify script passed'),
});

export interface AgentFixOutcome {
    success: boolean;
    changes: FileChange[];
    /** Each changed file's content at HEAD ('' for a new file). */
    originalContents: Map<string, string>;
    /** What the agent said it did, for the PR description. Empty when it never reported. */
    summary: string;
    failedStep: string;
    failureOutput: string;
}

/** Paths `git status` reports as changed or new in `workDir`, untracked files listed individually. */
export function listChangedPaths(workDir: string): string[] {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd: workDir, encoding: 'utf-8' });
    const paths: string[] = [];
    const entries = out.split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        paths.push(entry.slice(3));
        // A rename or copy is followed by its source path, which is not a change of its own.
        if (status[0] === 'R' || status[0] === 'C') i++;
    }
    return paths;
}

/**
 * Reads what the agent left on disk as the janitor's own change list: every path that
 * changed since `baseline` (the paths already dirty before the agent ran, such as linked
 * dependency folders), with its content now and its content at HEAD.
 *
 * Deleted files are not carried: a janitor fix never deletes a file, and the commit
 * stages only paths that exist.
 */
export function collectAgentChanges(workDir: string, baseline: Set<string>): { changes: FileChange[]; originalContents: Map<string, string> } {
    const changes: FileChange[] = [];
    const originalContents = new Map<string, string>();
    for (const relPath of listChangedPaths(workDir)) {
        if (baseline.has(relPath)) continue;
        const absPath = path.join(workDir, relPath);
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
        let original = '';
        try {
            original = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
            // Not in HEAD: a new file.
        }
        originalContents.set(relPath, original);
        changes.push({ filePath: relPath, updatedContent: fs.readFileSync(absPath, 'utf-8') });
    }
    return { changes, originalContents };
}

/**
 * Records the exact state of `workDir` as a git tree id, built in a scratch index at
 * `indexPath` so the worktree's own index is never touched. Covers every tracked and
 * untracked file that is not gitignored, so any edit after the stamp changes the id.
 */
export function treeFingerprintCommands(indexPath: string): string[] {
    const index = JSON.stringify(indexPath);
    return [
        `GIT_INDEX_FILE=${index} git read-tree HEAD`,
        `GIT_INDEX_FILE=${index} git add -A`,
        `GIT_INDEX_FILE=${index} git write-tree`,
    ];
}

export function treeFingerprint(workDir: string, indexPath: string): string | null {
    try {
        const out = execFileSync('bash', ['-c', `set -e; ${treeFingerprintCommands(indexPath).join('; ')}`], {
            cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        return out.trim().split('\n').pop() || null;
    } catch {
        return null;
    }
}

export interface VerifyScript {
    /** The one command the agent may run. */
    command: string;
    /**
     * The worktree state the agent's latest verify run passed on, or null when its latest
     * run failed or it never ran one. Written by the script itself, outside the worktree,
     * where the agent's edits cannot reach.
     */
    passedFingerprint: () => string | null;
    /** The worktree's state now, in the same terms. */
    currentFingerprint: () => string | null;
    dispose: () => void;
}

/**
 * Writes the one command the agent may run: lint, then tests, in the worktree. It lives
 * outside the worktree so it can never be committed, and runs the same commands as the
 * janitor's own verification. On success it stamps the worktree state it passed on, so
 * the janitor can skip re-running the checks on a state that has already passed them.
 */
export function writeVerifyScript(workDir: string, lint: string, test: string): VerifyScript {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-verify-'));
    const script = path.join(dir, 'verify.sh');
    const stamp = path.join(dir, 'passed');
    const lines = [
        '#!/usr/bin/env bash',
        'set -e',
        // A run that fails must not leave an earlier pass standing.
        `rm -f ${JSON.stringify(stamp)}`,
        `cd ${JSON.stringify(workDir)}`,
    ];
    if (lint) lines.push('echo "== lint"', lint);
    if (test) lines.push('echo "== test"', test);
    if (!lint && !test) lines.push('echo "No lint or test command is configured; nothing to check."');
    lines.push(
        // Stamped after the checks, so whatever they rewrote (a formatter, say) is included.
        `( ${treeFingerprintCommands(path.join(dir, 'stamp-index')).join(' && ')} ) > ${JSON.stringify(stamp)}`,
        'echo "== all checks passed"',
    );
    fs.writeFileSync(script, lines.join('\n') + '\n', { mode: 0o755 });
    return {
        command: script,
        passedFingerprint: () => {
            try {
                return fs.readFileSync(stamp, 'utf-8').trim().split('\n').pop() || null;
            } catch {
                return null;
            }
        },
        currentFingerprint: () => treeFingerprint(workDir, path.join(dir, 'check-index')),
        dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

export function buildAgentSystemPrompt(verifyCommand: string): string {
    return `
    You are an expert software engineer implementing one small, reviewed change in a fresh checkout of the repository (your working directory).

    RULES:
    1. Implement exactly the fix described, nothing more. Keep untouched code byte-identical.
    2. Touch only the files the plan names unless a caller or test genuinely has to change too; never more than 5 files.
    3. LINE BUDGETS (ENFORCED AFTERWARDS, AND A FIX OVER BUDGET IS DISCARDED): at most ${maxLineDiff} changed lines (added + removed) across production files, and separately at most ${maxTestLineDiff} across test files.
    4. ${enableTestGen ? 'Add or extend tests where the plan calls for them, following the existing test files exactly: same framework, imports, helpers, naming and placement.' : 'Do NOT add or change tests; this repository has test generation turned off.'}
    5. Never delete a file, and never remove an existing top-level declaration unless the plan says to.
    6. Do not add suppressions (e.g. @Suppress, eslint-disable, # type: ignore) to get the checks green.
    7. Follow the repository's own agent instructions (CLAUDE.md and the like) where they apply.
    8. The ONLY command you can run is: ${verifyCommand}
       It runs the project's lint and test commands. Run it after your change, read any failure, fix your change, and run it again until it passes or you are sure it cannot pass for reasons outside this fix. No other shell command is available.
    9. When done, report what you changed and whether the last verify run passed. If the plan turns out to be wrong or unnecessary, change nothing and say why.
`;
}

export function buildAgentPrompt(fix: FixProposal, previousFailure?: { step: string; output: string }): string {
    const files = fix.plannedFiles?.length ? `\n\nFiles the plan expects to touch:\n${fix.plannedFiles.map(f => `- ${f}`).join('\n')}` : '';
    const base = `Fix to implement: ${fix.title}\n\n${fix.description}${files}`;
    if (!previousFailure) return base;
    return `${base}\n\nYour change is already in the working directory, but the janitor's own check rejected it at the ${previousFailure.step} step:\n\n${previousFailure.output.slice(0, 12000)}\n\nRevise the change in place so it passes, keeping to the plan and the line budgets.`;
}

/**
 * Checks what the agent left on disk exactly as the edit flow checks a proposal:
 * integrity and line budgets first, then lint and tests run by the janitor itself.
 */
export function checkAgentChanges(workDir: string, baseline: Set<string>, verify?: VerifyScript, trustPassedRun: boolean = trustClaudeChecks): AgentFixOutcome {
    const { changes, originalContents } = collectAgentChanges(workDir, baseline);
    if (changes.length === 0) {
        return { success: false, changes, originalContents, summary: '', failedStep: 'no-changes', failureOutput: 'The agent left the working directory unchanged.' };
    }
    const integrity = validateFixIntegrity(originalContents, changes);
    if (!integrity.valid) {
        return { success: false, changes, originalContents, summary: '', failedStep: 'integrity', failureOutput: integrity.reason };
    }
    // With trust_claude_checks on, a state the agent's last verify run stamped as passing
    // is not run again: the same commands already passed on exactly these files. Any other
    // state, including one edited after its last passing run, is checked here from scratch.
    const passed = trustPassedRun ? verify?.passedFingerprint() : null;
    if (passed && passed === verify?.currentFingerprint()) {
        console.log(`✅ Lint and tests already passed on this exact change in the agent's last verify run (tree ${passed.slice(0, 12)}); not running them again.`);
        return { success: true, changes, originalContents, summary: '', failedStep: '', failureOutput: '' };
    }
    const verification = runVerification(lintCmd, testCmd, testTimeoutMs, workDir);
    return { success: verification.success, changes, originalContents, summary: '', failedStep: verification.failedStep, failureOutput: verification.failureOutput };
}

/**
 * Has Claude Code implement `fix` in `workDir`, then verifies the result independently.
 * `workDir` must be a checkout of the fix's branch with dependencies already in place.
 */
export async function implementFixWithAgent(fix: FixProposal, workDir: string, options: { command?: string } = {}): Promise<AgentFixOutcome> {
    const active = modelFallback.active;
    if (active.provider !== CLAUDE_CODE_PROVIDER) {
        return {
            success: false,
            changes: [],
            originalContents: new Map(),
            summary: '',
            failedStep: 'agent-unavailable',
            failureOutput: `This fix was planned for Claude Code to implement, but the run has switched to ${active.provider}.`,
        };
    }

    const baseline = new Set(listChangedPaths(workDir));
    const verify = writeVerifyScript(workDir, lintCmd, testCmd);
    const system = buildAgentSystemPrompt(verify.command);
    let outcome: AgentFixOutcome = { success: false, changes: [], originalContents: new Map(), summary: '', failedStep: 'agent', failureOutput: '' };

    try {
        for (let pass = 1; pass <= AGENT_PASSES; pass++) {
            const previous = pass > 1 ? { step: outcome.failedStep, output: outcome.failureOutput } : undefined;
            console.log(`🤖 Claude Code is implementing '${fix.slug}' (pass ${pass} of ${AGENT_PASSES})...`);
            let summary = outcome.summary;
            try {
                const report = await generateWithClaudeCode(agentReportSchema, system, buildAgentPrompt(fix, previous), {
                    model: active.model,
                    workDir,
                    allowTools: true,
                    maxTurns: claudeCodeAgentMaxTurns,
                    timeoutMs: AGENT_TIMEOUT_MS,
                    agent: { verifyCommand: verify.command },
                    onUsage: recordClaudeCodeUsage,
                    command: options.command,
                });
                summary = report.summary;
                console.log(`   Agent report (checks ${report.checksPassed ? 'passed' : 'not passing'}): ${report.summary}`);
            } catch (err) {
                if (isQuotaExhaustedError(err)) {
                    // The plan's allowance is spent: another pass would fail the same way.
                    outcome = { success: false, changes: [], originalContents: new Map(), summary: '', failedStep: 'subscription-limit', failureOutput: err instanceof Error ? err.message : String(err) };
                    break;
                }
                // A run that ends without a report (out of turns, a crash) may still have
                // left a good change on disk; the janitor's own check decides.
                console.warn(`⚠️ Claude Code did not finish its report: ${err instanceof Error ? err.message : String(err)}`);
            }

            outcome = { ...checkAgentChanges(workDir, baseline, verify), summary };
            if (outcome.success || outcome.failedStep === 'no-changes') break;
            console.warn(`⚠️ Janitor check failed for '${fix.slug}' at ${outcome.failedStep}.`);
        }
    } finally {
        verify.dispose();
    }
    return outcome;
}
