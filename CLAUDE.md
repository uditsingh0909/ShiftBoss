# CLAUDE.md — ShiftBoss

Guide for Claude Code (and people) working on this repo. The README is the user guide; this file is
how to change the code without breaking what it promises.

## What ShiftBoss is

A local control room for Claude Code sessions running in [herdr](https://herdr.dev). One Bun process
polls herdr, the session transcripts and the status line every 2 s, keeps tasks / decisions / promises
in SQLite, and streams a live snapshot to a React UI over server-sent events. Sessions report into it
through MCP tools or the `shiftboss` CLI, both thin clients of the same local HTTP API.

Planned next (not built): a hosted version — an outbound-only agent per machine, a cloud with accounts
and passkeys, `shiftboss login` via the OAuth device flow, a phone app, and an alert ladder
(push → Telegram → alarm → call). Until that work starts, keep everything single-machine and local.

## Layout

| Path | What |
|---|---|
| `server/index.ts` | Entry point. Binds `127.0.0.1` only, runs the promise backfill, starts the engine |
| `server/engine.ts` | The poll loop: herdr, transcripts, status line, auto "needs you" for blocked panes, answer sending, dispatch, releases, GitHub moves |
| `server/transcripts.ts` | Incremental reader for `~/.claude/projects/<slug>/<session>.jsonl` (new bytes only; first read = last 4 MB) |
| `server/statusline.ts` | Exact usage from `data/status/<session>.json` (the tap), else parsed from herdr's footer |
| `server/analysis.ts` | Pure health and overlap rules |
| `server/github.ts` | PR → task links and "does dev/prod run this merge" checks |
| `server/db.ts` | SQLite store and in-place migrations |
| `server/api.ts` | HTTP API |
| `server/herdr.ts` | herdr CLI wrapper |
| `server/config.ts` | Defaults + `shiftboss.config.json` (gitignored) + `SHIFTBOSS_*` env overrides |
| `shared/types.ts` | Types shared by server and UI, plus small pure helpers (`resolveLead`) |
| `web/` | React 18 UI, no build step: Bun bundles `web/index.html` on request |
| `mcp/server.ts` | MCP server (`shiftboss`), 20 tools over the HTTP API |
| `scripts/setup.ts` | One-shot setup (checks, config, start, and opt-in MCP / status line / login / intake). `SETUP.md` is the runbook Claude Code follows with it |
| `shared/port.ts` | The install's port for the CLI, MCP and scripts: env, then config, then 4400 |
| `cli/shiftboss.ts` | CLI over the HTTP API |
| `cli/statusline-tap.cjs` | Status line tap: copies Claude Code's status JSON to `data/status/`, then runs the user's own command |
| `desktop/` | Tauri 2 app (Windows built; macOS/Linux on hold). Reuses a running server or starts the compiled sidecar |
| `docs/INTAKE.md` | Instructions the intake session follows |
| `web/tour.tsx` | First-visit guided tour per page |
| `scripts/run.sh` | Restart loop; exits if ShiftBoss already answers on its port |
| `test/core.test.ts` | Unit tests |
| `test/e2e.ts` | Browser check: every screen at 1920 and 390 px, fails on errors or sideways scroll |
| `test/shots.ts` | Screenshots for docs |

## Commands

```bash
bun install
bun run dev              # server with reload, http://127.0.0.1:4400
bun test                 # unit tests — must pass before every commit
bunx tsc --noEmit -p .   # typecheck — must be clean
bun test/e2e.ts          # with the server running: every screen, desktop + phone width
```

Desktop (Windows): see README → "Desktop app (Windows)". Needs Rust and the VS C++ Build Tools.

## Rules that keep ShiftBoss safe

These are product promises. Do not weaken them without the owner asking.

- **Local only.** The server binds `127.0.0.1`. Every non-GET request needs the header `X-ShiftBoss: 1`
  (a page on another origin cannot send it without a preflight we never allow). Do not add CORS.
- **Never answer a permission prompt.** A blocked pane becomes a "needs you" item; answering it only
  *focuses* the herdr pane. No code path may send keys that approve a Claude Code permission prompt.
- **Never post for the user.** Approving a Slack draft asks the owning session to post it; the daily
  report is copied, not sent. ShiftBoss itself makes no outbound posts.
- **Answers are undoable.** A decision answer waits 10 s (`UNDO_MS`) before the engine sends it; keep the
  undo and reopen paths working.
- **Tasks only move forward automatically**, and never to "Requester told" — only a session or person
  sets that.
- **Every promise belongs to a task.** `addPromise` files one if needed; `linkOrphanPromises` backfills.
- **One bad poll never crashes the server.** Catch per item, log to the feed, retry next tick. The DB
  uses `busy_timeout`; process-level handlers log instead of exiting.
- **Transcripts are sensitive.** Read them locally only; never send their contents anywhere.

## Conventions

- **No team-specific details in the repo.** Names, channels, repos, URLs and paths belong in
  `shiftboss.config.json` (gitignored) or the database, never in code, tests, docs or examples. Use
  placeholders (`Sam`, `acme/api`, `C:/path/to/…`). The repo is public.
- **The name is ShiftBoss** (display) / `shiftboss` (CLI, package, files, env vars `SHIFTBOSS_*`).
- **Migrations live in `Store.migrate()`** and must be safe to re-run: `CREATE TABLE IF NOT EXISTS`,
  `PRAGMA table_info` before `ALTER TABLE`. Never rewrite an existing column in place.
- **UI**: black and white, colour only for state (red / amber / green). No gradients, no glow, no emoji.
  Use the helpers in `web/lib.tsx` (`Card`, `Seg`, `Hero`, `Bar`, `Dot`, `act`, `api`). Every screen must
  work at 390 px wide (the e2e check enforces no sideways scroll). Real `<button>`, `<a href>`,
  `<label>`. Copy in plain words.
- **Live data**: screens render from the SSE snapshot (`useSnap()`). Anything fetched separately must
  re-fetch when `snap.now` changes, so it stays live.
- **Tests**: new rules get a unit test in `test/core.test.ts` (pure functions and the in-memory `Store`).
  Changes to screens get a run of `bun test/e2e.ts` against a running server.
- **Commits**: small, with a body explaining why. No secrets, no `data/`, no binaries.

## Gotchas

- **Restarting**: if the server runs under `scripts/run.sh`, `npx kill-port 4400` restarts it with new code
  within ~3 s. Don't start a second copy. Server changes need that restart; for `web/` changes a page reload
  is enough under `bun run dev`.
- **Windows shells**: Git Bash rewrites arguments that start with `/` into paths. When sending slash
  commands to a pane (`herdr agent prompt <pane> "/exit"`), set `MSYS_NO_PATHCONV=1`.
- **herdr names**: a pane's `name` (from `herdr agent rename`) wins over its terminal title.
- **Lead session**: `settings.leadSession` is a base name; `resolveLead` picks the highest
  `name-vN` running, so a replaced lead takes over the big card automatically.
- **Compiled server** (`bun build --compile`): `import.meta.dir` is virtual there, so the desktop app
  passes `SHIFTBOSS_DATA_DIR` and `SHIFTBOSS_PORT`.
