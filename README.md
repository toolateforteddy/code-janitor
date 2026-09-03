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
- 🧪 **Convention-Aware Test Generation:** Before writing tests, Janitor feeds the existing sibling test files for each changed source file into the model's context (counterpart tests first, then same-directory tests, mirrored JVM `src/test` roots, and finally any test file in the repo). Generated tests reuse the project's real test framework, imports, and helpers instead of inventing ones that fail to compile.
- 🎯 **Atomic PRs:** Splits refactors and fixes into tiny, single-responsibility PRs (<100 lines) so reviews take 30 seconds.
- 🛡️ **Zero Broken PR Guarantee:** Runs your native linters and test commands (`go test`, `cargo test`, `npm test`, `pytest`, `./gradlew test`) locally inside the runner. If a change breaks compilation or a test, **it is automatically discarded before a PR is opened**.
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
          model: 'gemini-3.6-flash'
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
      model: 'gemini-3.6-flash'
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
| `provider` | AI Provider (`google`, `anthropic`, `openai`) | `'google'` |
| `model` | AI Model ID to execute | `'gemini-3.6-flash'` |
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
| `max_concurrency` | Maximum number of fixes to process in parallel (via git worktrees) per run | `3` |
| `reviewers` | Comma-separated GitHub handles or teams to request review | `''` |
| `draft_pr` | Open PRs in Draft state | `true` |
| `janitor_mode` | Execution mode (`auto`, `repair-only`, `refactor-only`) | `'auto'` |
| `enable_llm_tools` | Allow LLM to call workspace tools (`read_file`, `list_directory`, `run_command`) | `true` |
| `max_llm_tool_steps` | Maximum tool call steps per LLM request | `5` |
| `llm_max_retries` | Retries after a transient LLM API failure (429, 5xx, dropped connection, unparseable response). `0` disables retrying | `4` |
| `llm_retry_base_delay_ms` | Base delay in ms for exponential backoff between LLM retries | `1000` |
| `llm_retry_max_delay_ms` | Maximum delay in ms between LLM retries | `30000` |
| `dedupe_prs` | Skip proposals already covered by an existing (open, or closed-unmerged) Code Janitor PR | `true` |
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

## 🧰 LLM Workspace Tools & Safety Limits

When `enable_llm_tools` is set to `true` (default), the LLM can dynamically inspect your workspace using Vercel AI SDK function calling before outputting repair or refactor proposals.

### Available Tools
- `read_file`: Reads the text contents of a workspace file relative to the project root.
- `list_directory`: Lists directory entries (files and folders) within the workspace, ignoring `.git`, `node_modules`, `dist`, `build`, etc.
- `run_command`: Executes small, safe, read-only diagnostic commands (`ls`, `dir`, `find`, `git status`, `git log`, `git diff`, `cat`, `grep`, `pwd`, `tree`, `head`, `tail`).

### Tool Logging & Visibility
All tool invocations are logged directly to standard output during execution (e.g., `🛠️ Tool call: read_file("src/utils.ts") -> Read 1452 chars`), giving full visibility in GitHub Action logs into what data the model accessed.

### Output Size Limits & Guardrails
To prevent context overflow and control token costs, output size caps are strictly enforced:
- **File Output Limit (`read_file`):** Truncated at **40,000 characters (~40KB)**.
- **Command Output Limit (`run_command`):** Truncated at **10,000 characters (~10KB)**.
- **Directory Entry Limit (`list_directory`):** Truncated at **100 entries**.
- **Path Traversal Protection:** All file paths are strictly validated (`isPathInsideWorkspace`) to prevent access outside the repository root.
- **Command Whitelist & Chaining Protection:** Destructive commands (`rm`, `mv`, `git push`, etc.) and shell operators (redirection `>`, command chaining `;`) are blocked.