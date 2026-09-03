# 🧹 Code Janitor

> An asynchronous, zero-friction GitHub Action that sweeps code merged in the last 24 hours, refactors for performance & idioms, adds edge-case unit tests, and opens small, atomic Pull Requests.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-Enabled-blue)](https://github.com/features/actions)

---

## ✨ Features

- 🧹 **Non-Blocking Sweeps:** Runs on your schedule (`cron`) or on demand (`workflow_dispatch`) without slowing down daytime PR reviews.
- ⚡ **Auto-Detected Runtimes & Native Caching:** Automatically detects project ecosystems (Go, Node.js, Rust, Python, Android Kotlin / Gradle), provisions runtimes, and enables native build caching across workflow runs.
- 🔧 **Automatic Repair Mode:** Runs an initial health check on main. If tests or linters are failing, Janitor automatically switches to **Repair Mode** (`🚨`) to generate minimal fix PRs for the broken build/tests before attempting refactors.
- 📍 **Persistent History Tracking & Uncached Fallback:** Uses a cached state cursor (`.janitor-state.json`) to track the last analyzed commit hash across runs. On uncached initial runs (or new repositories), Code Janitor automatically looks back across either the last 24 hours or 10 commits—whichever provides more commits to analyze.
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
| `target_path` | Subdirectory path to restrict diff analysis to | `'.'` |
| `exclude_paths` | Comma-separated glob patterns to ignore | `'.github/workflows/**, vendor/**, generated/**, dist/**'` |
| `enable_test_generation` | Whether to write unit tests for uncovered code | `true` |
| `max_prs_per_run` | Maximum atomic PRs to open in one run | `3` |
| `max_line_diff` | Hard cap on total diff lines per atomic PR | `100` |
| `max_concurrency` | Maximum number of fixes to process in parallel (via git worktrees) per run | `3` |
| `reviewers` | Comma-separated GitHub handles or teams to request review | `''` |
| `draft_pr` | Open PRs in Draft state | `true` |
| `janitor_mode` | Execution mode (`auto`, `repair-only`, `refactor-only`) | `'auto'` |
| `enable_llm_tools` | Allow LLM to call workspace tools (`read_file`, `list_directory`, `run_command`) | `true` |
| `max_llm_tool_steps` | Maximum tool call steps per LLM request | `5` |
| `go_version` | Go version (e.g. `"1.22"`, `"stable"`). Reads `go.mod` if empty | `''` |
| `node_version` | Node.js version (e.g. `"18"`, `"20"`, `"22"`, `"24"`). Reads `.nvmrc`, `.node-version`, or `package.json` if empty (fallback `"24"`) | `''` |
| `python_version` | Python version (e.g. `"3.10"`, `"3.11"`, `"3.12"`). Reads `pyproject.toml` or `.python-version` if empty (fallback `"3.11"`) | `''` |
| `rust_toolchain` | Rust toolchain channel (e.g. `"stable"`, `"nightly"`). Defaults to `"stable"` | `'stable'` |
| `java_version` | Java/JDK version for Android Kotlin / Gradle (e.g. `"17"`, `"21"`). Defaults to `"17"` | `'17'` |
| `gemini_api_key` | Gemini API key (can also be supplied via `GEMINI_API_KEY` env var) | `''` |
| `anthropic_api_key` | Anthropic API key (can also be supplied via `ANTHROPIC_API_KEY` env var) | `''` |
| `openai_api_key` | OpenAI API key (can also be supplied via `OPENAI_API_KEY` env var) | `''` |

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