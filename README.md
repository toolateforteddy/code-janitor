# 🧹 Code Janitor

> An asynchronous, zero-friction GitHub Action that sweeps code merged in the last 24 hours, refactors for performance & idioms, adds edge-case unit tests, and opens small, atomic Pull Requests.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-Enabled-blue)](https://github.com/features/actions)

---

## ✨ Features

- 🧹 **Non-Blocking Sweeps:** Runs on your schedule (`cron`) or on demand (`workflow_dispatch`) without slowing down daytime PR reviews.
- 🔧 **Automatic Repair Mode:** Runs an initial health check on main. If tests or linters are failing, Janitor automatically switches to **Repair Mode** (`🚨`) to generate minimal fix PRs for the broken build/tests before attempting refactors.
- 📍 **Persistent History Tracking:** Uses a cached state cursor (`.janitor-state.json`) to track the last analyzed commit hash, ensuring unanalyzed commit windows are never lost across workflow runs.
- 🎯 **Atomic PRs:** Splits refactors and fixes into tiny, single-responsibility PRs (<100 lines) so reviews take 30 seconds.
- 🛡️ **Zero Broken PR Guarantee:** Runs your native linters and test commands (`go test`, `cargo test`, `npm test`, `pytest`) locally inside the runner. If a change breaks compilation or a test, **it is automatically discarded before a PR is opened**.
- 💸 **Near-Zero Running Cost ($0–$0.05/mo):** Powered by fast, affordable models like **Gemini 3.6 Flash**. Includes early exit logic if no recent code changes exist.

---

## 🚀 Quickstart

### 1. Add API Key Secret
Add your provider key (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) to your GitHub organization or repository secrets.

### 2. Create Workflow
Add `.github/workflows/code-janitor.yml` in your target repository:

```yaml
name: Code Janitor Sweep

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  sweep:
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
| `reviewers` | Comma-separated GitHub handles or teams to request review | `''` |
| `draft_pr` | Open PRs in Draft state | `true` |
| `janitor_mode` | Execution mode (`auto`, `repair-only`, `refactor-only`) | `'auto'` |