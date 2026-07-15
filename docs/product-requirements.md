# AI Pair Coding Guide Product Requirements

> **Status note (added retrospectively).** This is the original MVP requirements doc, written before the product form was settled. It still holds as the spec for the "brain layer" capabilities (Repo Map, Task Navigator, Diff Coach, Learning Log), all of which are implemented and passing tests. Two things have since moved beyond what's written here:
>
> - The product now ships as a **VS Code sidebar extension** (listed under §11 Future Work below), not just a local web app. The extension calls the same handlers **in-process** (`require`), so a running `localhost:3000` server is no longer required — the HTTP server remains as a browser/standalone fallback.
> - A **file/edit watcher with automatic diff coaching** and **AFK presence detection** are implemented in the extension.
>
> For the current architecture and product vision, see the Chinese docs in this folder: [产品定义.md](产品定义.md), [实现架构.md](实现架构.md), [设计原则.md](设计原则.md).

## 1. Product Positioning

AI Pair Coding Guide is a local developer tool for reversing the usual AI coding workflow.

The AI does not take the keyboard or directly implement code for the developer. Instead, it acts as a guide, mentor, navigator, and reviewer that helps the human stay oriented while working in an unfamiliar or complex codebase.

Core statement:

> An AI pair partner that guides humans through unfamiliar codebases without taking the keyboard.

Chinese positioning:

> 一个不抢键盘的 AI 结对伙伴，帮助程序员理解真实项目、完成改动，并沉淀项目知识。

The product is not meant to challenge developers aggressively. For a developer who is new to a project, the AI should first behave like an onboarding guide and senior teammate. As the developer becomes more familiar with the project, the AI can shift toward a reviewer or accountability partner.

## 2. Problem

AI coding tools often help developers produce code faster, but they can also weaken the developer's understanding of the codebase. This is especially risky when:

- a developer is onboarding to an unfamiliar repository
- a developer accepts AI-generated code without understanding impact
- changes touch modules with hidden dependencies
- tests, config, docs, or edge cases are easy to miss
- project knowledge stays in temporary chat history instead of becoming reusable context

The long-term goal is to improve developer productivity without giving up code ownership and understanding.

## 3. Goals

The MVP should help a developer:

- understand the structure of a local repository
- identify important entry points and modules
- turn a natural-language task into a reading and change route
- inspect the current git diff with mentor-style feedback
- understand impact, risks, and missing tests before finishing a task
- save a lightweight learning log for future reference

## 4. Non-Goals

The MVP should not:

- directly edit or overwrite user code
- act as a full IDE extension
- implement complex AST-level static analysis
- replace code review
- handle multi-user collaboration
- require cloud storage or authentication
- require an API key to run the demo

## 5. User Modes

### 5.1 Onboarding Guide

For developers new to a repository.

AI behavior:

- explain project structure
- identify key files and entry points
- recommend a reading order
- avoid adversarial review tone
- emphasize orientation and context

### 5.2 Task Navigator

For developers starting a concrete change.

AI behavior:

- search relevant files
- suggest which files to read first
- identify likely files to change
- explain concepts that matter before editing
- suggest small next steps

### 5.3 Diff Coach

For developers after making changes.

AI behavior:

- summarize the current diff
- explain likely behavior impact
- surface risks and missing tests
- ask reflection questions
- keep the tone helpful, not combative

### 5.4 Learning Log

For long-term project understanding.

AI behavior:

- record task context
- save changed files and suggested reading
- record open questions
- summarize what the developer likely learned

## 6. MVP User Flow

```text
Start local app
-> enter target repo path
-> scan repo
-> generate Repo Map
-> enter task
-> generate Task Navigator route
-> developer edits code manually
-> analyze git diff
-> review mentor notes and reflection questions
-> save Learning Log
```

## 7. Core Features

### 7.1 Repo Map

Input:

- local repository path
- file tree
- key files such as `README.md`, `package.json`, `go.mod`, `.env.example`

Output:

- project type
- likely entry points
- core modules
- recommended reading order
- testing strategy hints
- unknowns that need human confirmation
- project guide, a concise Markdown context similar to `CLAUDE.md`

Acceptance criteria:

- user can input an absolute repo path
- app displays a readable file tree
- app ignores heavy generated directories such as `.git`, `node_modules`, `dist`, `build`, `.next`, `vendor`
- app identifies common project files
- app reads repository-provided AI context files such as `CLAUDE.md`, `AGENTS.md`, and `AI_PAIR_GUIDE.md`
- app generates a `projectGuide` field and passes it into later AI requests
- app works without an external AI API key using local heuristic output

### 7.2 Task Navigator

Input:

- scanned repo map
- project guide from Repo Map
- user task, for example `change login session timeout`
- keyword search results from repository files

Output:

- task understanding
- files to read first
- likely files to change
- questions before coding
- suggested steps

Acceptance criteria:

- user can enter a natural-language task
- app returns a concrete route through the codebase
- AI does not generate a full implementation
- route is based on actual files in the scanned repo

### 7.3 Diff Coach

Input:

- target repository path
- `git diff -- .`
- `git diff --name-only -- .`
- repo map
- project guide from Repo Map

Output:

- change summary
- changed files
- likely impact
- risks
- missing tests
- reflection questions

Acceptance criteria:

- target path must be a git repository
- app analyzes unstaged working-tree changes
- app explains the diff in mentor tone
- app highlights whether tests were changed
- app does not modify code

### 7.5 Scheduled Diff Watcher

Input:

- target repository path
- repo map
- project guide from Repo Map
- previous diff hash
- user-selected interval

Output:

- latest check timestamp
- whether a diff exists
- whether the diff changed since the last check
- changed files
- mentor suggestions when the diff changed

Acceptance criteria:

- user can start and stop scheduled checks from the Diff Coach view
- interval must be at least 10 seconds
- watcher checks the current unstaged git diff
- watcher avoids calling the AI provider when the diff hash has not changed
- watcher logs each check through the normal API logging system
- watcher does not modify code

### 7.4 Learning Log

Input:

- current repo path
- current task
- navigator output
- diff coach output

Output:

- local session record
- task summary
- learned concepts
- changed files
- open questions

Acceptance criteria:

- user can save the current session
- sessions are stored locally in `data/sessions.json`
- sessions can be viewed in the app
- later Navigator and Diff Coach requests recall relevant sessions from the same repo
- recalled sessions are included in AI context as project memory
- recalled sessions are visible in the UI

## 8. AI Provider Requirements

The app should support multiple AI providers but remain demoable offline.

Supported provider modes:

- `local`: heuristic guidance, no API call
- `openai`: OpenAI Chat Completions
- `anthropic`: Anthropic Messages API
- `auto`: Anthropic if `ANTHROPIC_API_KEY` exists, otherwise OpenAI if `OPENAI_API_KEY` exists, otherwise local

Environment variables:

```env
AI_PROVIDER=auto
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_VERSION=2023-06-01
ANTHROPIC_MAX_TOKENS=4096
PORT=3000
```

AI responses should be requested as structured JSON so the UI can render consistent sections.

If a provider call fails, the app should return local fallback output instead of breaking the demo.

The generated `projectGuide` should be included in every post-scan AI request so the model receives stable repository context similar to how tools use `CLAUDE.md`.

## 9. UX Requirements

The app should feel like a developer workstation tool, not a marketing landing page.

UX principles:

- first screen should be the usable app
- no hero page
- UI should prioritize scanning, comparison, and repeated action
- controls should be obvious and compact
- AI output should be structured into actionable sections
- the app should make clear whether output came from local, OpenAI, or Anthropic mode

Main views:

- Repo Map
- Navigator
- Diff Coach
- Learning Log

## 10. Demo Script

Recommended hackathon demo:

1. Start the local app.
2. Enter a target repo path.
3. Click `Scan Repo`.
4. Show generated project map and reading order.
5. Enter task: `change login session timeout`.
6. Show suggested files and questions before coding.
7. Make a small manual code change in the target repo.
8. Open Diff Coach and analyze the current diff.
9. Show risks, missing tests, and reflection questions.
10. Save the session to Learning Log.

Demo message:

> AI should not only make code faster. It should help humans stay in control.

Chinese version:

> AI 不只是让代码写得更快，也应该帮助程序员保持理解和掌控。

## 11. Future Work

Potential extensions after MVP:

- ✅ VS Code extension — **done** (sidebar webview, in-process brain layer)
- ✅ file watcher for near real-time diff coaching — **done** (save/change listeners + polling, hash-deduped)
- staged diff support with `git diff --cached`
- untracked file detection — **done** (`git add -N` intent-to-add in `git.js`)
- richer project knowledge graph
- per-module familiarity score
- task history search
- test command detection and execution
- AST-aware call graph for supported languages
- explicit mode switch between Guide, Navigator, Reviewer, and Mentor
- hesitation sensing (卡住检测) — planned, still open
- style-profile memory (越用越懂你的命名/结构偏好) — planned, still open
