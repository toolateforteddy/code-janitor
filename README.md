# 🧹 Code Janitor

> An asynchronous, zero-friction GitHub Action that sweeps code merged in the last 24 hours, refactors for performance & idioms, adds edge-case unit tests, and opens small, atomic Pull Requests.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-Enabled-blue)](https://github.com/features/actions)

---

## ✨ Features

- 🧹 **Non-Blocking Sweeps:** Runs on your schedule (`cron`) or on demand (`workflow_dispatch`) without slowing down daytime PR reviews.
- ⚡ **Auto-Detected Runtimes & Native Caching:** Automatically detects project ecosystems (Go, Node.js, Rust, Python, Android Kotlin / Gradle), provisions runtimes, and enables native build caching across workflow runs.
- 🔧 **Automatic Repair Mode:** Runs an initial health check on main. If tests or linters are failing, Janitor automatically switches to **Repair Mode** (`🚨`) to generate minimal fix PRs for the broken build/tests before attempting refactors.
- 🔁 **PR Deduplication:** Before proposing anything, Janitor checks the pull requests it has already opened. A repair sweep re-observes the same red `main` every night until the fix is merged, so proposals already covered by an open Janitor PR — or by one a human closed without merging — are skipped instead of re-opened as a fresh PR.
- 📍 **Persistent History Tracking & Uncached Fallback:** Uses a cached state cursor (`.janitor-state.json`) to track the last analyzed commit hash across runs. On uncached initial runs (or new repositories), Code Janitor automatically looks back across either the last 24 hours or 10 commits—whichever provides more commits to analyze.
- 🤖 **Ignores Its Own Work:** Commits the janitor made itself are not new work. They are recognized by their author (`Code Janitor Bot <bot@codejanitor.local>`, kept by merge commits and rebase-merges) or by the `Code-Janitor: refactor|repair` trailer on every janitor commit and PR body (kept by squash-merges). A window holding only janitor commits ends the run before any toolchain is set up; a mixed window is reviewed only in the files somebody else touched.
- 🧪 **Convention-Aware Test Generation:** Before writing tests, Janitor feeds the existing sibling test files for each changed source file into the model's context (counterpart tests first, then same-directory tests, mirrored JVM `src/test` roots, and finally any test file in the repo). Generated tests reuse the project's real test framework, imports, and helpers instead of inventing ones that fail to compile.
- 🎯 **Atomic PRs:** Splits refactors and fixes into tiny, single-responsibility PRs (<100 lines) so reviews take 30 seconds.
- 🛡️ **Zero Broken PR Guarantee:** Runs your native linters and test commands (`go test`, `cargo test`, `npm test`, `pytest`, `./gradlew test`) locally inside the runner. If a change breaks compilation or a test, **it is automatically discarded before a PR is opened**.
- 📚 **Architecture Docs Mode (opt-in):** Keeps the short repo maps an agent reads before the code accurate. A separate weekly run reads what changed since each listed doc was last updated, fixes only what drifted, checks every path, name and command it adds against the tree, and opens one small draft PR that names the commit behind each change. It edits nothing but the listed docs.
- 📊 **Job Summary for Every Run:** Each run publishes a GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`) — sweep type, branch health, proposal counts, and the outcome of every proposed fix with a link to the PR it opened — so you can see what a nightly sweep did without opening the logs.
- 🔄 **Provider Fallback When Tokens Run Out:** Configure a backup provider and Janitor keeps going when the primary's token/credit allowance is spent — run Claude first, fail over to Gemini for the rest of the run. Exhausted-quota errors are told apart from ordinary rate limits, so a real 429 is still retried with backoff instead of burning the fallback.
- 💸 **Near-Zero Running Cost ($0–$0.05/mo):** Powered by fast, affordable models like **Gemini 3.6 Flash**. Includes early exit logic if no recent code changes exist.

---

## 🛠️ Supported Languages & Auto-Detection

Code Janitor automatically detects your repository's language ecosystem, provisions the required runtime environment, and enables native dependency and build caching across workflow runs. Callers can also explicitly specify custom language runtime versions.

| Language / Stack | Auto-Detection File(s) | Default Runtime | Configurable Input | Native Caching |
| :--- | :--- | :--- | :--- | :--- |
| **Go** | `go.mod` | Read from `go.mod` | `go_version` | Go build & module cache |
| **Node.js (JS / TS)** | `package.json` | Read from `.nvmrc`, `.node-version`, or `package.json` (fallback `24`) | `node_version` | npm cache |
| **Rust / Cargo** | `Cargo.toml` | `stable` | `rust_toolchain` | Cargo registry & build cache |
| **Python** | `pyproject.toml`, `requirements.txt` | Read from `pyproject.toml` or `.python-version` (fallback `3.11`) | `python_version` | pip cache |
| **Android Kotlin (Gradle)** | `build.gradle`, `build.gradle.kts` | JDK `17` | `java_version` | Gradle cache |

---

## 🚀 Quickstart

### 1. Add API Key Secret
Add your provider key (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) to your GitHub organization or repository secrets.

### 2. Configure Workflow Permissions

Ensure the workflow job is granted `contents: write` (to push fix branches) and `pull-requests: write` (to open PRs).

### 3. Create Workflow

Add `.github/workflows/code-janitor.yml` in your target repository:

#### Option A: Composite Action (Recommended)
```yaml
name: Code Janitor Sweep

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  sweep:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout Target Repo
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Run Code Janitor
        uses: toolateforteddy/code-janitor@main
        with:
          provider: 'google'
          model: 'gemini-3.8-flash'
          test_command: 'go test ./...'
          test_timeout: 5
          janitor_mode: 'auto'
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

#### Option B: Reusable Workflow
```yaml
name: Code Janitor Sweep

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  sweep:
    permissions:
      contents: write
      pull-requests: write
    uses: toolateforteddy/code-janitor/.github/workflows/code-janitor.yml@main
    with:
      provider: 'google'
      model: 'gemini-3.8-flash'
      test_command: 'go test ./...'
      test_timeout: 5
      janitor_mode: 'auto'
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

---

## 🔑 Required Repository Permissions & Setup

If you encounter `Permission denied to github-actions[bot]` or HTTP 403 errors when pushing branches or opening PRs, ensure both your workflow file and repository settings permit GitHub Actions to write contents and create pull requests:

### 1. Workflow YAML Permissions
Your job must include explicit write permissions for `contents` and `pull-requests`:
```yaml
permissions:
  contents: write
  pull-requests: write
```

### 2. GitHub Repository Settings
1. Navigate to your target repository's **Settings** > **Actions** > **General**.
2. Scroll down to **Workflow permissions**.
3. Under default permissions, **Read repository contents and packages permissions** is fine (and recommended) as long as your workflow YAML includes the `permissions:` block above. *(Alternatively, select **Read and write permissions** to grant write permissions by default).*
4. Check **Allow GitHub Actions to create and approve pull requests** (Required).
5. Click **Save**.

Without these settings, `GITHUB_TOKEN` will be restricted to read-only access and pushing fix branches or creating PRs will fail with `403 Forbidden`.

> [!TIP]
> **Security Best Practice: Preventing Bot Self-Approval**  
> GitHub groups PR creation and PR approval under a single repository policy toggle (*"Allow GitHub Actions to create and approve pull requests"*). To ensure Code Janitor or any GitHub Action workflow cannot self-approve or auto-merge PRs:
> 1. Navigate to **Settings** > **Branches** (or **Rulesets**) in your repository.
> 2. Edit your protection rule for your default branch (e.g. `main`).
> 3. Enable **Require a pull request before merging**.
> 4. Check **Require review from someone other than the last push / PR creator**.

---

## ⚙️ Configuration Inputs

| Input | Description | Default |
| :--- | :--- | :--- |
| `provider` | AI Provider (`google`, `anthropic`, `openai`, `claude-code`). See [Running on a Claude subscription](#-running-on-a-claude-subscription) | `'google'` |
| `model` | AI Model ID to execute | `'gemini-3.8-flash'` |
| `fallback_provider` | Backup AI provider used for the rest of the run once the primary reports an exhausted token/credit allowance. Empty disables the fallback | `''` |
| `fallback_model` | Model ID for the backup provider. Empty uses that provider's default | `''` |
| `triage_model` | Model for the triage request that picks which files of a large window to review. Empty means `haiku` on the `claude-code` provider and the main model otherwise | `''` |
| `claude_code_agent` | On the `claude-code` provider, Claude Code implements each fix in its worktree and runs the checks itself. `false` goes back to returned edits | `true` |
| `claude_code_max_turns` | Turns a read-only `claude-code` request (triage, proposals) may take, file reads included. Used instead of `max_llm_tool_steps` on that provider | `20` |
| `claude_code_agent_max_turns` | Turns the implementing agent may take per pass; each fix gets at most two passes | `40` |
| `trust_claude_checks` | Skip the janitor's own lint and test run when Claude Code's last check run passed on exactly the files being committed. Saves Actions runner minutes; see below | `false` |
| `claude_code_oauth_token` | Claude subscription token from `claude setup-token`, used by the `claude-code` provider | `''` |
| `test_command` | Command to run tests | `'go test ./...'` |
| `test_timeout` | Timeout for test execution in minutes | `5` |
| `lint_command` | Command to run linters before tests | `''` |
| `install_command` | Command to install project dependencies (e.g. `npm ci`, `poetry install`, `pip install -r requirements.txt`). Runs in the workspace and in any worktree still missing dependencies | `''` |
| `install_timeout` | Timeout for dependency installation in minutes | `10` |
| `auto_install` | Auto-detect and run a Node install command (`npm ci` / `yarn` / `pnpm`) when dependencies are missing and `install_command` is empty | `true` |
| `target_path` | Subdirectory path to restrict diff analysis to | `'.'` |
| `exclude_paths` | Comma-separated glob patterns to ignore | `'.github/workflows/**, vendor/**, generated/**, dist/**'` |
| `enable_test_generation` | Whether to write unit tests for uncovered code | `true` |
| `max_prs_per_run` | Maximum atomic PRs to open in one run | `3` |
| `max_line_diff` | Hard cap on total diff lines to non-test files per atomic PR | `100` |
| `max_test_line_diff` | Hard cap on total diff lines to test files per atomic PR (counted separately from `max_line_diff`) | `200` |
| `enforce_line_budget` | Reject proposals whose measured diff exceeds the caps above (set `false` for prompt-only guidance) | `true` |
| `max_concurrency` | Maximum number of fixes to process in parallel (via git worktrees) per run. Empty means 3, or 1 on the `claude-code` provider | `''` |
| `reviewers` | Comma-separated GitHub handles or teams to request review | `''` |
| `assignees` | Comma-separated GitHub usernames to assign each PR to (`@me` for the token owner). Reviewers alone do not put a PR in someone's "assigned to me" queue or the GitHub mobile app; assignees do. Teams cannot be assigned. | `''` |
| `draft_pr` | Open PRs in Draft state | `true` |
| `janitor_mode` | Execution mode (`auto`, `repair-only`, `refactor-only`, `architecture-docs`). `architecture-docs` refreshes the files in `architecture_docs` and sweeps no code; see [Keeping Architecture Docs Accurate](#-keeping-architecture-docs-accurate) | `'auto'` |
| `architecture_docs` | Comma-separated repo-relative Markdown files that `architecture-docs` mode keeps in step with the code, and the only files it may change. Read only in that mode | `''` |
| `enable_llm_tools` | Allow LLM to call workspace tools (`read_file`, `list_directory`, `run_command`) | `true` |
| `max_llm_tool_steps` | Maximum tool call steps per LLM request. The `claude-code` provider uses `claude_code_max_turns` instead | `5` |
| `llm_max_retries` | Retries after a transient LLM API failure (429, 5xx, dropped connection, unparseable response). An exhausted token/credit allowance is never retried — it fails over to the backup model instead. `0` disables retrying | `4` |
| `llm_retry_base_delay_ms` | Base delay in ms for exponential backoff between LLM retries | `1000` |
| `llm_retry_max_delay_ms` | Maximum delay in ms between LLM retries | `30000` |
| `dedupe_prs` | Skip proposals already covered by an existing (open, or closed-unmerged) Code Janitor PR | `true` |
| `edit_format` | How the model expresses file changes: `edits` (targeted search/replace) or `rewrite` (full file content) | `'edits'` |
| `go_version` | Go version (e.g. `"1.22"`, `"stable"`). Reads `go.mod` if empty | `''` |
| `node_version` | Node.js version (e.g. `"18"`, `"20"`, `"22"`, `"24"`). Reads `.nvmrc`, `.node-version`, or `package.json` if empty (fallback `"24"`) | `''` |
| `python_version` | Python version (e.g. `"3.10"`, `"3.11"`, `"3.12"`). Reads `pyproject.toml` or `.python-version` if empty (fallback `"3.11"`) | `''` |
| `rust_toolchain` | Rust toolchain channel (e.g. `"stable"`, `"nightly"`). Defaults to `"stable"` | `'stable'` |
| `java_version` | Java/JDK version for Android Kotlin / Gradle (e.g. `"17"`, `"21"`). Defaults to `"17"` | `'17'` |
| `gemini_api_key` | Gemini API key (can also be supplied via `GEMINI_API_KEY` env var) | `''` |
| `anthropic_api_key` | Anthropic API key (can also be supplied via `ANTHROPIC_API_KEY` env var) | `''` |
| `openai_api_key` | OpenAI API key (can also be supplied via `OPENAI_API_KEY` env var) | `''` |

---

## 📦 Dependencies in Parallel Worktrees (Node / Python)

Each proposed fix is verified inside its own `git worktree`, which is a **clean checkout**: gitignored dependency trees like `node_modules/` and `.venv/` do not come along. Go modules, Cargo, and Gradle keep their caches outside the repository, so only Node- and Python-style projects hit this. Left alone, every proposal would fail verification with `Cannot find module` or `No module named …` no matter how good the fix was.

Code Janitor prepares each worktree before running lint/tests:

1. **Reuse first.** Dependency directories found in the primary workspace (`node_modules`, `.venv`, `venv`, including nested ones such as `packages/api/node_modules`) are symlinked into the worktree. Nothing is reinstalled per fix, and an existing directory in the worktree is never overwritten. Linking happens *after* the proposal's changes are staged for inspection, so linked dependencies can never be mistaken for — or committed as — part of a PR.
2. **Install what is still missing.** If `install_command` is set, it runs in any workspace or worktree that still looks uninstalled. Otherwise, with `auto_install` enabled (the default), the install command for Node projects is derived from the lockfile: `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package-lock.json` / `npm-shrinkwrap.json` → `npm ci`, otherwise `npm install`.

The same step runs once on the primary checkout before the initial health check, so a Node repo whose workflow never installed dependencies is not misdiagnosed as a broken `main`.

Python installs are never guessed — set `install_command` (e.g. `pip install -r requirements.txt`, `poetry install`, `uv sync`) if your tests need one. A project-local `.venv/` is linked automatically, and a globally installed interpreter environment is inherited by worktrees as-is.

```yaml
- uses: toolateforteddy/code-janitor@v1
  with:
    test_command: 'npm test'
    install_command: 'npm ci'   # optional; auto-detected from the lockfile when omitted
```

---

## ✂️ Change Format: Edits vs. Full Rewrites

A proposal describes each touched file in one of two ways:

```jsonc
// edits — preferred for an existing file
{
  "filePath": "internal/store/store.go",
  "edits": [
    { "oldText": "\tif err != nil {\n\t\treturn err\n\t}", "newText": "\tif err != nil {\n\t\treturn fmt.Errorf(\"load: %w\", err)\n\t}" }
  ]
}

// updatedContent — required for a new file
{ "filePath": "internal/store/store_test.go", "updatedContent": "package store\n\n..." }
```

`oldText` must be copied verbatim from the file and match exactly one place in it (trailing whitespace and tab/space indent drift are tolerated; set `"replaceAll": true` when every occurrence should change). Edits are applied in order against the file on disk. An edit that matches nothing, or matches ambiguously, leaves the file untouched and hands the model a specific reason on the auto-fix retry — it never guesses.

**Why this is the default.** A full-file rewrite forces the model to retype every unedited line of the file, and the longer the file, the likelier one of those lines goes missing. Code Janitor's integrity check exists to catch exactly that: a rewrite that silently drops a top-level declaration is rejected and costs an auto-fix round trip, or the whole proposal. Edits remove the failure mode instead of policing it — code outside an edit is copied through byte for byte, so it cannot be lost.

That changes what the integrity check has to do:

| Check | Full rewrite | Edits |
| --- | --- | --- |
| Omitted top-level declarations | Enforced (catches truncation) | **Skipped** — an absent declaration can only be a deliberate deletion |
| Mass deletion (>50% of a file over 25 lines) | Enforced | Enforced |
| Test framework imports added to `src/main/**` | Enforced | Enforced |
| Line budgets (`max_line_diff` / `max_test_line_diff`) | Enforced | Enforced |

The checks that remain are about *intent* and *size*, not truncation, so they apply either way. Edits also make the line budgets easier to stay inside: the diff a proposal produces is only what it actually changed.

Set `edit_format: rewrite` to go back to whole-file content for every change (and the full integrity check with it). Full rewrites are always still accepted for new files, and as the model's fallback when an existing file needs restructuring that edits can't express cleanly.

---

## 🔁 PR Deduplication

The janitor runs on a schedule, but its PRs are merged by humans on their own time. A failing `main` therefore looks identical on every run until the pending repair lands — so without deduplication, repair mode proposes the same fix and opens a brand-new PR every single night.

When `dedupe_prs` is `true` (default), each run first lists the pull requests on branches the janitor itself created (`janitor/<slug>-<timestamp>`) via the GitHub CLI:

- **Open PRs** — the fix is already submitted and awaiting review.
- **Closed, unmerged PRs** — a human looked at that fix and rejected it.
- **Merged PRs are deliberately ignored.** That change already landed; if it didn't hold, the janitor should be free to try again.

Those PRs are used twice. They are passed to the model as context ("do not re-propose these"), and any proposal that comes back anyway is filtered out before a branch is created, matched on:

1. **Slug** — the branch the janitor would mint is effectively the same one.
2. **Normalized title** — emoji and `fix:`/`refactor:` prefixes are stripped before comparing.
3. **Identical set of touched files** — **repair mode only.** A repair run re-reads the same failure logs and lands on the same files; two refactor proposals touching one file, by contrast, are routinely genuinely different improvements.

Duplicates within a single batch are collapsed too, so one run can't race two near-identical branches into existence. Every skip is logged (`⏭️ Skipping proposal 'fix-nil-deref' — already open as #42`).

Deduplication **fails open**: if `gh` is unavailable or unauthenticated, the run logs a warning and proceeds without it rather than aborting the sweep. Set `dedupe_prs: false` to disable it entirely.

---

## 📊 Job Summary

Every run writes a markdown report to `$GITHUB_STEP_SUMMARY`, rendered at the top of the workflow run page in the Actions UI. It answers "what did last night's sweep actually do?" without scrolling through step logs:

| Field | Value |
| --- | --- |
| Mode | `auto` |
| Sweep | 🧹 Refactor |
| Provider / model | `google` / `gemini-3.8-flash` |
| Main branch health | ✅ Green |
| Proposals | 3 |
| Skipped as duplicates | 2 |
| Existing janitor PRs | 5 |
| PRs opened | 1 |
| Duration | 1m 32s |

Below the run metadata, each proposal gets a row with its outcome — `✅ PR opened` (linked to the pull request), `❌ Verification failed` (with the step that failed: lint, test, or integrity), `⚠️ No changes produced`, or `💥 Error` — followed by any notes explaining an early exit, such as a failing `main` under `refactor-only` or an empty diff window.

The summary is written in a `finally` block, so runs that stop early or fail outright still report why. It requires no configuration: `$GITHUB_STEP_SUMMARY` is provided by the Actions runner, and outside Actions (local runs) writing it is a no-op.

---

## 🧰 LLM Workspace Tools & Safety Limits

When `enable_llm_tools` is set to `true` (default), the LLM can dynamically inspect your workspace using Vercel AI SDK function calling before outputting repair or refactor proposals.

### Available Tools
- `read_file`: Reads the text contents of a workspace file relative to the project root.
- `list_directory`: Lists directory entries (files and folders) within the workspace, ignoring `.git`, `node_modules`, `dist`, `build`, etc.
- `run_command`: Executes small, safe, read-only diagnostic commands (`ls`, `dir`, `find`, `git status`, `git log`, `git diff`, `git ls-files`, `cat`, `grep`, `pwd`, `tree`, `head`, `tail`).

### Step Budget Exhaustion
The tool loop is bounded by `max_llm_tool_steps`. If the model spends every step on tool calls and never returns its structured answer, the run does **not** fail: the janitor re-asks once with tools disabled, replaying the tool calls and their output in the prompt, so the sweep still produces proposals. This applies to the AI SDK providers; `claude-code` has its own budget, `claude_code_max_turns` (see below).

### Tool Logging & Visibility
All tool invocations are logged directly to standard output during execution (e.g., `🛠️ Tool call: read_file("src/utils.ts") -> Read 1452 chars`), giving full visibility in GitHub Action logs into what data the model accessed.

### Output Size Limits & Guardrails
To prevent context overflow and control token costs, output size caps are strictly enforced:
- **File Output Limit (`read_file`):** Truncated at **40,000 characters (~40KB)**.
- **Command Output Limit (`run_command`):** Truncated at **10,000 characters (~10KB)**.
- **Directory Entry Limit (`list_directory`):** Truncated at **100 entries**.
- **Path Traversal Protection:** All file paths are strictly validated (`isPathInsideWorkspace`) to prevent access outside the repository root.
- **Command Whitelist & Chaining Protection:** Destructive commands (`rm`, `mv`, `git push`, etc.) and shell operators (redirection `>`, command chaining `;`) are blocked.

---

## 🔄 Provider Fallback When Tokens Run Out

Set `fallback_provider` (and optionally `fallback_model`) to keep a run alive when the primary provider's token/credit allowance is spent. The classic setup is a paid Claude plan in front and Gemini behind it:

```yaml
        with:
          provider: 'anthropic'
          model: 'claude-sonnet-4-5'
          fallback_provider: 'google'
          fallback_model: 'gemini-3.8-flash'
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

Both providers' keys must be present — the fallback is only reachable if its key is configured.

**What counts as "out of tokens".** An exhausted allowance and an ordinary rate limit both arrive as HTTP 429, so the two are told apart by what the provider actually says: `insufficient_quota`, `quota exceeded`, `credit balance is too low`, `billing hard limit reached`, `usage limit reached`, and the like, plus any `402 Payment Required`. A plain "rate limit exceeded, please retry" is still treated as transient and retried with backoff, because it clears on its own.

**What happens on a switch:**

1. The failing request is not retried — an exhausted balance does not refill during a backoff, so retrying it only burns the retry budget before failing anyway.
2. The request is re-issued immediately against the backup model.
3. The switch is **sticky for the rest of the run**: every later request goes straight to the backup rather than paying another failed round trip to the primary.
4. The run log records `🔁 anthropic/claude-sonnet-4-5 is out of tokens/quota; falling back to google/gemini-3.8-flash for the rest of this run`, and the job summary reports the model that actually did the work plus a note explaining the switch.

If the backup is exhausted too — or no fallback is configured — the error propagates and the run fails, as before. A `fallback_provider`/`fallback_model` identical to the primary is ignored.

---

## 🪪 Running on a Claude Subscription

The `claude-code` provider bills a Claude Pro or Max plan instead of an API key. It runs each request through the Claude Code CLI (`claude -p`) rather than calling a model API itself, because a subscription token is only accepted by Claude Code: Anthropic does not allow it to be used from other API clients, the `anthropic` provider here included.

1. On your own machine, run `claude setup-token` and approve it in the browser. It prints a token valid for a year.
2. Save it as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN`. The token is one line; if your terminal wrapped it, the janitor strips the line breaks a paste picks up.
3. Point the janitor at it:

```yaml
        with:
          provider: 'claude-code'
          model: 'sonnet'              # any Claude Code model alias or full ID; empty uses Claude Code's default
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          fallback_provider: 'google'  # optional: keeps the run alive when the plan's usage window is spent
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

The action installs the CLI when either `provider` or `fallback_provider` is `claude-code`. Triage and proposal requests inspect the workspace with Claude Code's own read-only tools (`Read`, `Grep`, `Glob`), bounded by `claude_code_max_turns`. That budget is larger than `max_llm_tool_steps` because the claude-code proposal prompt lists the files under review by path rather than pasting them, so the request spends turns reading them. A request that runs out of turns has no tool-less re-ask to fall back on, so its retry gets twice the turns of the attempt before it, up to four times `claude_code_max_turns`. Only the implementing step below can edit files, and only inside a fix's worktree. A spent plan (`You've hit your limit`) counts as out of tokens, so a configured fallback takes over for the rest of the run.

**Claude Code writes the fixes itself.** With the other providers the model returns each fix as search/replace edits inside its JSON answer; the janitor applies them, runs the checks, and on a failure asks for corrected edits once. On `claude-code` the work is split differently:

1. **Plan.** The proposal request asks only for each fix's title, description and the files it will touch. No code is written at this step, so none is paid for twice.
2. **Implement.** For each fix, Claude Code runs in that fix's worktree with `Read`, `Grep`, `Glob`, `Edit` and `Write`, plus `Bash` for exactly one command: a verify script, kept outside the worktree, that runs `lint_command` and `test_command`. Edits outside the worktree and every other shell command are denied (nobody is there to approve them in a CI run). It edits, runs the checks, reads the failures and iterates, up to `claude_code_agent_max_turns` turns.
3. **Check.** The janitor ignores what the agent says about its own checks. It reads the changed files off disk, applies the same integrity and line-budget checks as always, and runs lint and tests itself. A failure there goes back to the agent for one more pass with the output, the same single retry the edit flow gets. Only then is the change committed and the PR opened, with the agent's own summary added to the description.

**Trusting Claude's check run (`trust_claude_checks`).** By default a fix's lint and tests run three times before it can merge: by Claude Code while it works, by the janitor in step 3, and by the PR's own CI. The middle run repeats the first on the same runner and only costs Actions minutes, since CI runs the same checks again before anything merges. Set `trust_claude_checks: 'true'` to skip it. That is worth doing on private repositories, where those minutes count against the account's allowance or are billed; standard GitHub-hosted runners are free for public repositories, so there it saves little more than wall-clock time and the default is fine. This is about reducing wasted runner minutes, not about trusting what the model reports: the verify script stamps a fingerprint of the worktree's files (a git tree hash, staged and unstaged changes alike) only after lint and tests actually pass, and the janitor skips its run only when that stamp matches the files it is about to commit. Any edit after the last passing run, a failing run, or a model that never ran the checks means the janitor runs them itself as usual. The integrity and line-budget checks always run.

If the plan's allowance runs out mid-run and a `fallback_provider` takes over, fixes already planned for Claude Code are reported as not implemented rather than handed to a provider that cannot edit files. Set `claude_code_agent: 'false'` to keep the edit flow on `claude-code` too.

**What it does differently to save your allowance.** On a subscription every token comes out of the same allowance as your own Claude use, so the provider spends less of it:

- **Nothing is sent twice.** Claude Code already loads the workspace's root `CLAUDE.md`, so it is left out of the prompt. With workspace tools on, the changed files and example tests are listed by path for Claude to open with `Read` as needed, rather than pasted whole into every request.
- **Triage runs on Haiku.** Picking which files of a large window to review needs only the commit log and a file stat, so it goes to `haiku` unless `triage_model` says otherwise. Fix proposals and auto-fixes stay on `model`.
- **One fix at a time.** `max_concurrency` defaults to 1 here, so parallel agents do not race through the plan or run test suites over each other. Set it explicitly to run fixes in parallel anyway.
- **Usage in the job summary.** Each run's summary has a *Claude Code usage* row: requests, turns, input (and how much was cached) and output tokens, plus what that would have cost at API prices, as a gauge of how much of the plan a sweep takes.

**Keep it to your own repositories.** Anthropic's terms allow a subscription token to drive Claude Code for your own ordinary use, which a scheduled sweep of your own repos is. They do not allow sharing one person's subscription across other people's repositories or offering it as a service; use an API key (`provider: 'anthropic'`) for that. Runs draw on the same usage limits as your interactive Claude use.

---

## 📚 Keeping Architecture Docs Accurate

Some repositories keep short maps that tell an agent what is where without reading all the code: a `docs/repo-architecture.md` listing each directory, its entry points and what is generated, say, linked from `CLAUDE.md` or `AGENTS.md`. They rot quietly as directories, modules, entry points and generated files change. `architecture-docs` mode refreshes them. It is off unless you turn it on, and an unset `architecture_docs` changes nothing.

### Turning it on

Add a second workflow that runs the action weekly in this mode. Keep your nightly sweep as it is.

```yaml
name: Code Janitor Architecture Docs

on:
  schedule:
    - cron: '0 5 * * 1'   # Mondays
  workflow_dispatch:

# Share the nightly sweep's group so the two never run at once.
concurrency:
  group: code-janitor
  cancel-in-progress: false

jobs:
  refresh:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0   # the mode reads each doc's history
      - uses: toolateforteddy/code-janitor@main
        with:
          janitor_mode: 'architecture-docs'
          architecture_docs: 'docs/repo-architecture.md, docs/code-architecture.md'
          provider: 'claude-code'
          model: 'sonnet'
          assignees: 'your-handle'
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

`fetch-depth: 0` matters: with a shallow checkout there is no history to measure drift from.

### What a run does

1. **Checks for an open docs PR.** While one is open, the run does nothing: last week's PR still covers the same drift. If the latest docs PR was closed without merging, the next window starts after the commit it covered (`Architecture-Docs-Head:` in its body), so rejected drift is not proposed again every week.
2. **Measures each doc's window.** For each listed doc, the commits since the last commit that changed it (`git log -1 -- <doc>`), excluding commits that only touched the listed docs, with the files each added, deleted, renamed or modified. No commits: no model request, no PR. The sweep's cursor is not read or moved; the two runs keep separate state.
3. **Asks for the drift, one doc at a time.** The model sees the doc and the commit list, may read the code with read-only tools (`Read`, `Grep`, `Glob` on `claude-code`; `read_file`, `list_directory` and the read-only `run_command` elsewhere), and answers with search/replace edits. It is told to fix only what the commits made wrong (new or removed directories and modules, moved responsibilities, renamed entry points, generated files and their commands), to keep the doc's structure and voice, and to make no style rewrites. Each edit names the commits that caused it and every path, name and command it states.
4. **Keeps only what checks out.** An edit is dropped whole, and listed in the PR as left out, when:
   - it cites no commit from the window;
   - anything it adds cannot be found: a path that is not tracked (globs and `<placeholder>` segments match any name, and a path may be the tail of a longer one, as maps name `fight/turn.rs` under a `rust/engine/src/` heading), a name or expression whose identifiers do not appear in any non-Markdown tracked file, a link that does not resolve from the doc's directory, or a command whose `cd` targets, repository scripts, path arguments, Cargo packages (`-p`), npm scripts and make targets do not exist, or whose program is neither a common toolchain command nor named in the code;
   - its `oldText` is not in the doc, or it would take the docs past `max_line_diff` changed lines.

   Markdown is never evidence: a name that only appears in a doc has not been shown to exist in the code. **Commands are checked, not run**: a map can name a deploy script as easily as a test, and a model's answer is not a reason to run either.
5. **Opens one PR, or none.** Nothing drifted, or nothing survived: the run ends without a PR. Otherwise one PR (draft per `draft_pr`) on a `janitor/architecture-docs-<timestamp>` branch, separate from code-fix PRs and left out of their deduplication. Its body lists each change with the commit that caused it and what was left out and why. The janitor writes the edits itself, to the listed files only, and refuses to open the PR if anything else in the worktree changed.

### Only the listed files

In this mode the listed docs are the only files that can change, whatever `exclude_paths` allows; the model has no write tools, and the janitor applies edits to those paths alone. Other docs, which hold design decisions somebody made, are read as context at most. `target_path` and `exclude_paths` do not narrow the window either, because a repo map describes the whole repository. Entries in `architecture_docs` that are absolute, contain `..` or a glob, or are not Markdown are ignored with a note in the job summary. A listed doc that does not exist yet is skipped: the mode updates maps, it does not write them.

### Why a weekly run of its own

Not a step of the nightly sweep, for four reasons:

- **Different scope.** A sweep is usually narrowed to the code it can verify (`target_path`, `exclude_paths`, often `docs/**` excluded). A repo map covers everything, so it needs the opposite settings.
- **Different gate.** The sweep stops at repair mode while `main` is red, and exits early when its cursor has not moved. Docs drift has nothing to do with either, and should not wait for a green build.
- **Batching.** Structure changes slowly. A week of drift in one small PR is easier to review than a PR a night that grows by a row, and spends fewer model turns.
- **Independent failures.** A docs run that fails, or is skipped behind an open PR, never costs the code sweep its night, and the other way round.

Use the same `concurrency` group as the sweep so the two queue rather than overlap.

---

## 📏 Line Budget Enforcement

`max_line_diff` and `max_test_line_diff` are stated in the model prompt *and* enforced in code — a model is free to ignore prompt guidance, so the proposal is measured before a PR is opened.

- Each proposal's diff is counted per file as **added + removed lines** against the file's pre-change content (a new file counts every line as added), using the same minimal line edit script `git diff --numstat` reports.
- Files are classified by path: anything matching a language test convention (`*_test.go`, `*.test.ts`, `FooTest.kt`, `*_spec.rb`) or living under a test directory (`tests/`, `__tests__/`, `src/test/`) counts against `max_test_line_diff`; everything else counts against `max_line_diff`. The two budgets are independent, so a large test never squeezes out the production change (or vice versa).
- Every run logs its usage: `📏 Line budget for 'fix-nil-deref': production 42/100 diff lines, tests 88/200 diff lines`.
- An over-budget proposal fails validation alongside the other integrity checks. The failure reason (with the measured counts and offending files) is fed to the auto-fix retry, which gets one chance to shrink the change; if it still exceeds the budget, the branch is discarded and no PR is opened.

Set `enforce_line_budget: false` to fall back to prompt-only guidance.

---

## 🪞 Code Janitor Sweeps Itself

This repository runs Code Janitor on its own engine, nightly at 07:00 UTC and on demand, via [`.github/workflows/janitor-self-sweep.yml`](.github/workflows/janitor-self-sweep.yml).

The self sweep is deliberately different from the quickstart workflows in two ways:

- **It runs the working tree, not a published ref.** The step is `uses: ./`, so every sweep exercises the action as it currently exists on the branch being swept. An engine regression shows up in our own nightly run before it reaches anyone consuming `@main`.
- **It is scoped to the engine.** `target_path: scripts` limits analysis to the TypeScript engine, the only part of the repo a proposal can actually be verified against — `lint_command` (`npx tsc --noEmit`) and `test_command` (`npm test`) are the same checks [CI](.github/workflows/ci.yml) runs on every PR, so a proposal that breaks the build is discarded before a PR is opened. Workflow files, `node_modules`, and the npm lockfile are excluded.

### Secrets

| Secret | Required | Used for |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Yes (with the default `provider: google`) | The primary model for scheduled sweeps. |
| `ANTHROPIC_API_KEY` | Optional | Enables the fallback provider; without it the sweep simply stops when the primary's allowance is spent. |
| `OPENAI_API_KEY` | Optional | Only needed if a manual run selects `provider: openai`. |

### Running it manually

`workflow_dispatch` accepts `provider`, `model`, `janitor_mode`, and `max_prs_per_run`, so a sweep can be pointed at a different model or restricted to `repair-only` without editing the workflow. Manual runs bypass the "no new commits" early exit, which makes them the fastest way to test an engine change end to end against a real repository.
