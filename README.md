# 🧹 Code Janitor

> An asynchronous, zero-friction GitHub Action that sweeps code merged in the last 24 hours, refactors for performance & idioms, adds edge-case unit tests, and opens small, atomic Pull Requests.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-Enabled-blue)](https://github.com/features/actions)

---

## ✨ Features

- 🧹 **Non-Blocking Sweeps:** Runs on your schedule (`cron`) or on demand (`workflow_dispatch`) without slowing down daytime PR reviews.
- ⚡ **Auto-Detected Runtimes & Native Caching:** Automatically detects project ecosystems (Go, Node.js, Rust, Python, Android Kotlin / Gradle), provisions runtimes, and enables native build caching across workflow runs.
- 🔧 **Automatic Repair Mode:** Runs an initial health check on main. If tests or linters are failing, Janitor automatically switches to **Repair Mode** (`🚨`) to generate minimal fix PRs for the broken build/tests before attempting refactors.
- 📍 **Persistent History Tracking:** Uses a cached state cursor (`.janitor-state.json`) to track the last analyzed commit hash, ensuring unanalyzed commit windows are never lost across workflow runs.
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
| `go_version` | Go version (e.g. `"1.22"`, `"stable"`). Reads `go.mod` if empty | `''` |
| `node_version` | Node.js version (e.g. `"18"`, `"20"`, `"22"`, `"24"`). Reads `.nvmrc`, `.node-version`, or `package.json` if empty (fallback `"24"`) | `''` |
| `python_version` | Python version (e.g. `"3.10"`, `"3.11"`, `"3.12"`). Reads `pyproject.toml` or `.python-version` if empty (fallback `"3.11"`) | `''` |
| `rust_toolchain` | Rust toolchain channel (e.g. `"stable"`, `"nightly"`). Defaults to `"stable"` | `'stable'` |
| `java_version` | Java/JDK version for Android Kotlin / Gradle (e.g. `"17"`, `"21"`). Defaults to `"17"` | `'17'` |