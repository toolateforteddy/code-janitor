# 🧹 Code Janitor

> An asynchronous, zero-friction GitHub Action that sweeps code merged in the last 24 hours, refactors for performance & idioms, adds edge-case unit tests, and opens small, atomic Pull Requests.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-Enabled-blue)](https://github.com/features/actions)

---

## ✨ Features

- 🧹 **Non-Blocking Sweeps:** Runs on your schedule (`cron`) or on demand (`workflow_dispatch`) without slowing down daytime PR reviews.
- 🎯 **Atomic PRs:** Splits refactors into tiny, single-responsibility PRs (<100 lines) so reviews take 30 seconds.
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
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}