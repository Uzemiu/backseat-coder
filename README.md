# AI Pair Coding Guide

A hackathon MVP for reversing the usual pair-coding relationship: the AI does not take the keyboard. It guides a human through an unfamiliar codebase, explains context, reviews the current diff, and keeps a lightweight learning log.

## Run

```powershell
npm run dev
```

Open `http://localhost:3000`.

## Monitor A Project

This app does not need to be installed inside the project you want to inspect. Start this app first, then enter the target repository path in the browser.

### Start The App

From this repository:

```powershell
cd G:\code\ai_pair_coding
npm run dev
```

Open:

```text
http://localhost:3000
```

### Scan A Target Repo

In the left sidebar, enter the absolute path of the project you want to monitor:

```text
G:\code\some-project
```

Then click `Scan Repo`.

The app will:

- read the target repo file tree
- detect key files such as `README.md`, `package.json`, `go.mod`, and `.env.example`
- read AI guidance files such as `CLAUDE.md`, `AGENTS.md`, and `AI_PAIR_GUIDE.md` when present
- build a Repo Map
- generate a CLAUDE.md-like `Project Guide`
- show likely entry points, core modules, and recommended reading order

### Navigate A Task

After scanning, open `Navigator` and enter the task you want to do in that repo:

```text
change login session timeout
```

Click `Create Route`.

The app will search the scanned files and suggest:

- files to read first
- likely files to change
- questions to answer before editing
- small next steps

The generated `Project Guide` from Repo Map is included in this AI request as persistent repository context.

### Monitor Current Changes

To analyze code changes in the target repo, the target path must be a git repository.

Make changes in your editor, then open `Diff Coach` and click `Analyze Git Diff`.

The app runs the equivalent of:

```powershell
git diff -- .
git diff --name-only -- .
```

inside the target repo path, then explains:

- what changed
- possible impact
- risks
- missing tests
- reflection questions for the developer

The generated `Project Guide` from Repo Map is also included in this AI request.

Only unstaged working-tree changes are included. If you already staged changes, unstage them or extend the tool later to also read `git diff --cached`.

### Scheduled Diff Watcher

In `Diff Coach`, use `Scheduled Checks` to periodically inspect the target repo.

1. Set `Interval seconds`.
2. Click `Start Watch`.
3. Keep coding in your editor.
4. When the current `git diff` changes, the app runs Diff Coach and shows a new suggestion.

The watcher calls:

```text
POST /api/diff/check
```

It computes a diff hash first. If the diff has not changed since the last check, it does not call the AI provider again. This keeps the watcher useful without repeatedly spending tokens on the same diff.

The minimum interval is 10 seconds.

### Save A Learning Log

Open `Learning Log` and click `Save Current Session`.

Logs are stored locally in:

```text
data/sessions.json
```

Saved learning logs are also used as project memory. During `Create Route`, `Diff Coach`, and scheduled diff checks, the server recalls up to five relevant sessions from the same repo and passes them into the AI request alongside the Project Guide.

The UI shows the recalled sessions under `Recalled Memories`, so you can see which previous work influenced the current suggestion.

## Logs And Debugging

The server writes structured JSON logs for every important operation:

- server startup
- every `/api/*` request
- repo scan start and completion
- task search start and completion
- git diff commands
- OpenAI and Anthropic provider selection
- provider request success, HTTP failure, or network exception
- API request failures with `requestId`

Main log file:

```text
data/app.log
```

When the app is started in the background by redirecting output, these files may also exist:

```text
data/server.out.log
data/server.err.log
```

Watch logs in PowerShell:

```powershell
Get-Content data\app.log -Wait
```

Show recent errors:

```powershell
Get-Content data\app.log | Select-String '"level":"error"' | Select-Object -Last 20
```

If the browser shows a request id, search for it:

```powershell
Select-String -Path data\app.log -Pattern "request-id-here"
```

If the UI says `Network request failed`, the browser could not reach the local server. Check that `npm run dev` is still running and that `http://localhost:3000` opens.

## Model And Provider

The app supports four provider modes:

- `local`: no API call; uses built-in heuristic guidance.
- `openai`: uses OpenAI Chat Completions.
- `anthropic`: uses Anthropic Messages API.
- `auto`: uses Anthropic if `ANTHROPIC_API_KEY` exists, otherwise OpenAI if `OPENAI_API_KEY` exists, otherwise local mode.

### Recommended Local Setup

Copy `.env.example` to `.env` and edit the values you want:

```powershell
Copy-Item .env.example .env
```

Example `.env` for Anthropic:

```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_api_key
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_VERSION=2023-06-01
ANTHROPIC_MAX_TOKENS=4096
PORT=3000
```

Example `.env` for OpenAI:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
PORT=3000
```

For compatible gateways or self-hosted forwarding services, change the base URL:

```env
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
ANTHROPIC_BASE_URL=http://127.0.0.1:8080
```

OpenAI requests append `/chat/completions` to `OPENAI_BASE_URL`. Anthropic requests append `/v1/messages` to `ANTHROPIC_BASE_URL`.

If your machine reaches model APIs through a local proxy, set `AI_PROXY_URL`:

```env
AI_PROXY_URL=http://127.0.0.1:7890
```

`AI_PROXY_URL` is preferred. If it is empty, the server also checks `HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY`.

Then run:

```powershell
npm run dev
```

### Switch Provider In PowerShell

Use Anthropic:

```powershell
$env:AI_PROVIDER="anthropic"
$env:ANTHROPIC_API_KEY="your_api_key"
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"
$env:ANTHROPIC_MODEL="claude-sonnet-4-5"
npm run dev
```

Use OpenAI:

```powershell
$env:AI_PROVIDER="openai"
$env:OPENAI_API_KEY="your_api_key"
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="gpt-4.1-mini"
npm run dev
```

Use local fallback explicitly:

```powershell
$env:AI_PROVIDER="local"
npm run dev
```

Use automatic selection:

```powershell
$env:AI_PROVIDER="auto"
npm run dev
```

Without an API key, the app still works so the demo is reliable offline.

## MVP Features

- Repo Map: scans a local repository and identifies project type, key files, entry points, and testing hints.
- Task Navigator: turns a task description into a reading route and likely files to inspect.
- Diff Coach: analyzes `git diff` and explains impact, risks, missing tests, and reflection questions.
- Learning Log: stores session summaries in `data/sessions.json`.

## Philosophy

The assistant is a guide, not an autopilot. It helps the developer stay oriented and in control:

- explain where to look
- ask useful context questions
- surface impact and tests
- record what the human learned
