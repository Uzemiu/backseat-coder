# AI Agent Setup Guide

This repository is a local Node.js app for guiding a human through unfamiliar codebases. The app serves a browser UI, scans a target repo, creates AI-assisted navigation advice, analyzes git diffs, and stores lightweight learning sessions locally.

## Runtime

- Use Node.js 20 or newer.
- Install dependencies with `npm install` if `node_modules` is missing.
- Start the app with:

```powershell
npm run dev
```

- Default URL: `http://localhost:3000`.
- Override the port with `PORT` in `.env` or the shell.

## Configuration

- `.env.example` documents supported settings.
- `.env` may contain real API keys and must not be committed or printed in full.
- Provider modes:
  - `AI_PROVIDER=local`: no model API call; use built-in heuristics.
  - `AI_PROVIDER=openai`: use OpenAI Chat Completions.
  - `AI_PROVIDER=anthropic`: use Anthropic Messages API.
  - `AI_PROVIDER=auto`: prefer Anthropic when configured, then OpenAI, then local.
- `AI_PROXY_URL` is preferred over standard proxy env vars when present.

## Architecture

- `server.js`: process entrypoint and dependency wiring only.
- `src/app.js`: HTTP server, static serving, and `/api/*` route orchestration.
- `src/config.js`: `.env` loading and normalized runtime config.
- `src/core/http.js`: response helpers, request body parsing, static file serving.
- `src/core/logger.js`: structured JSON logging with secret redaction.
- `src/core/proxy.js`: undici proxy setup.
- `src/services/repository.js`: repo scanning, file tree generation, search, local repo map.
- `src/services/git.js`: git command execution and diff collection.
- `src/services/ai.js`: provider selection, OpenAI/Anthropic calls, local fallbacks.
- `src/storage/sessions.js`: local session persistence in `data/sessions.json`.
- `public/`: browser UI assets.
- `tests/`: Node built-in test runner tests.

Keep API response shapes compatible with `public/app.js` unless you update the frontend at the same time.

## Verification

Run the test suite:

```powershell
npm test
```

Run syntax checks after broad refactors:

```powershell
Get-ChildItem -Recurse src,tests -File | ForEach-Object { node --check $_.FullName }
node --check server.js
```

Local smoke check with no model calls:

```powershell
$env:PORT="3138"
$env:AI_PROVIDER="local"
npm run dev
```

Then verify:

```powershell
Invoke-RestMethod -Uri "http://localhost:3138/api/sessions" -Method Get
Invoke-RestMethod -Uri "http://localhost:3138/api/scan" -Method Post -ContentType "application/json" -Body '{"repoPath":"G:\\code\\ai_pair_coding"}'
```

## Operational Notes

- Logs are JSON lines in `data/app.log`.
- `data/server.out.log`, `data/server.err.log`, and `data/sessions.json` are local runtime artifacts.
- Do not treat `data/app.log` changes as source changes unless the user explicitly asks about logs.
- Repo scanning intentionally caps depth, scanned files, text file size, and AI prompt size. Preserve those limits unless changing product behavior deliberately.
- The git diff coach currently reads unstaged changes only with `git diff -- .` and `git diff --name-only -- .`.
- `src/services/ai.js` must preserve local fallbacks when provider calls fail; the app should remain usable without model API access.

## Development Rules

- Prefer small, compatible changes because this is a local MVP with a simple frontend contract.
- Keep `server.js` thin. Put new behavior in a service or `src/app.js` orchestration.
- Redact keys, tokens, passwords, authorization headers, and secrets in logs.
- Do not add heavyweight frameworks unless the user explicitly wants that migration.
- If you change provider selection, update `tests/ai.test.js`.
