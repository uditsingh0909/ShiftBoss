# ShiftBoss

A local control room for a team of [Claude Code](https://claude.com/claude-code) sessions running in
[herdr](https://herdr.dev).

When you run eight or ten Claude sessions at once, the hard part stops being the code. It becomes
knowing which session is stuck, which one is waiting on a permission prompt, which one is about to run
out of context, what each one is working on, and what you promised people in Slack. ShiftBoss puts all of
that on one page, live, and keeps the work list so sessions can report into it.

It runs on your machine, listens on `127.0.0.1` only, and never answers a permission prompt or posts
anything on your behalf.

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Running it](#running-it)
- [Connecting your sessions](#connecting-your-sessions)
- [Exact usage numbers](#exact-usage-numbers)
- [The intake session](#the-intake-session)
- [How tasks move](#how-tasks-move)
- [The screens](#the-screens)
- [MCP tools and CLI reference](#mcp-tools-and-cli-reference)
- [HTTP API](#http-api)
- [Importing tasks from another tracker](#importing-tasks-from-another-tracker)
- [Safety](#safety)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## What it does

**Sees, without anyone reporting:**

- Every Claude session in herdr and its state: working, idle, finished, or waiting on a permission prompt.
- Each session's context use, plus your 5-hour and weekly plan usage.
- What each session last said and ran, the files it edited, and the PRs it opened.
- How fresh each session's handoff file is.

**Keeps for you:**

- **Tasks**, on a board from Inbox to Requester told, each with its original ask, a Slack thread and an activity log.
- **Needs you**: decisions only you can make, shown one at a time. Answers wait 10 seconds so you can undo them.
- **Promises**: every "I'll update you when it's live" sent from your account, until the person has been told.
- **Intake**: every message the intake session read, and what it did with each one.
- **Sent as you**: a log of what went out in your name, and who approved it.

**Warns you:**

- **Session health**: a session that is looping on the same failing command, silent while work waits for it, or close to its context limit.
- **Overlaps**: two sessions editing the same file, adding the same migration number, or working the same task.

**Moves work along:**

- A PR that names a task moves it to PR open, then On dev and Live once those environments run the merge.
- Optionally, sends a queued task's brief to its session as soon as that session has a free slot.

## How it works

```
 herdr ──────────────┐
 transcripts (.jsonl)├──► engine (every 2 s) ──► SQLite (data/shiftboss.db) ──► HTTP API ──► web UI (live, SSE)
 status line tap ────┤         │                                                 ▲
 GitHub (gh) ────────┘         └── health, overlaps, dispatch, GitHub moves       │
                                                                                  │
 your Claude sessions ── MCP tools / CLI ─────────────────────────────────────────┘
```

| What you see | Where it comes from |
|---|---|
| Sessions and their state | `herdr agent list`, every 2 seconds |
| Output, tools run, files edited, tokens, PRs | The session's transcript, `~/.claude/projects/<project>/<session-id>.jsonl`, read incrementally (only new bytes each poll; the first read takes the last 4 MB) |
| Context %, 5-hour and weekly usage | Claude Code's status line input via the [tap](#exact-usage-numbers); otherwise parsed from the footer herdr shows |
| Tasks, needs, promises, intake, audit, decisions | ShiftBoss's own SQLite database, written through the API, the MCP tools and the CLI |
| Releases | The URLs in `releaseEnvs` (each returns a version), and `gh pr list` for `releaseRepo` |
| Automatic task moves | `gh pr view` for each PR seen in a transcript, and GitHub's compare API against the deployed versions |

Everything is one Bun process: the engine, the API and the web UI. There is no cloud service and no
account.

## Requirements

| Tool | Why | Check |
|---|---|---|
| [Bun](https://bun.sh) 1.2 or newer | Runs the server, the CLI and the MCP server | `bun --version` |
| [herdr](https://herdr.dev) | ShiftBoss reads your sessions from it | `herdr agent list` |
| [Claude Code](https://claude.com/claude-code) | The sessions themselves | `claude --version` |
| [GitHub CLI](https://cli.github.com) (optional) | The Releases screen and automatic task moves | `gh auth status` |

Tested on Windows 11 (Git Bash) with Bun 1.4. It should run on macOS and Linux; the login-startup
launcher below is Windows-only.

## Install

```bash
git clone https://github.com/uditsingh0909/ShiftBoss.git shiftboss
cd shiftboss
bun install
cp shiftboss.config.example.json shiftboss.config.json   # then edit it, see below
bun test                                              # every test should pass
```

## Configuration

`shiftboss.config.json` holds everything specific to you and your team. It is gitignored, so nothing in it
is committed. Every field is optional; the defaults work for a single person with sessions in any herdr
workspace.

| Field | Default | What it does |
|---|---|---|
| `ownerName` | `"The owner"` | Your name. Used in prompts ShiftBoss sends to sessions, e.g. "Priya's answer to …". |
| `port` | `4400` | Port on 127.0.0.1. |
| `herdrWorkspace` | `""` | Only show sessions in this herdr workspace, e.g. `"w5"`. Empty means every workspace. |
| `handoffsDir` | `""` | Folder with one handoff file per session (`<session>.md`). ShiftBoss shows each file's age. |
| `lanes` | `{}` | Per session: what it works on and how many tasks it may hold, e.g. `{"vdp": {"lane": "spin, banners", "slots": 2}}`. Also editable on the Settings screen. |
| `contextWindows` | opus/sonnet 1M, haiku 200k | Context window per model, matched on part of the model id. Used only when the status line gives no percentage. |
| `releaseEnvs` | `[]` | `[{ "name": "Production", "url": "https://…/health/version" }]`. Each URL returns a version, as plain text or JSON with `version`, `message` or `commit`. A name containing "dev" or "prod" drives the automatic On dev and Live moves. |
| `releaseRepo` | `""` | `owner/repo` those environments deploy. Enables merged-PR listing and automatic On dev and Live moves. |
| `freezeVar` | `null` | `{ "repo": "owner/repo", "name": "DEPLOY_FREEZE" }`: a GitHub Actions variable shown as the release freeze state. |
| `transcriptsDir` | `~/.claude/projects` | Where Claude Code writes transcripts. |
| `herdrBin` | `"herdr"` | Path to herdr, if it is not on `PATH`. |
| `pollMs` | `2000` | How often the engine refreshes. |

Thresholds, switches and budgets live on the **Settings** screen and are stored in the database:

| Setting | Default | Meaning |
|---|---|---|
| Context warning | 70% | Bars turn amber |
| Suggest replace at | 85% | Bars turn red; the session page offers to prepare a handoff |
| Needs you, at most | 3 | Above this, Needs you warns that decisions are piling up |
| Handoff stale after | 30 min | Handoff age turns amber |
| Stuck after | 20 min | No output while queued work waits |
| Loop repeats | 3 | The same command this many times in a row within 15 minutes counts as looping |
| Send queued tasks automatically | off | When on, ShiftBoss sends a queued task's brief to its session once that session is idle with a free slot |
| Usage budgets | 0 | Token budgets used to estimate usage only when the status line gives no numbers |

## Running it

```bash
bun run start            # or: bun server/index.ts
bun run dev              # reloads on save
bash scripts/run.sh      # keeps it running: restarts 3 s after any exit, logs to data/server.log
```

Open <http://127.0.0.1:4400>. Sessions appear within a few seconds.

`scripts/run.sh` exits straight away if ShiftBoss is already answering on its port, so starting it twice
is harmless.

### Start at login (Windows)

Create `ShiftBoss.vbs` in your Startup folder (Win+R, `shell:startup`), with your own path:

```vbs
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\path\to\shiftboss"
sh.Run """C:\Program Files\Git\bin\bash.exe"" scripts/run.sh", 0, False
```

It runs hidden. On macOS or Linux, add `bash /path/to/shiftboss/scripts/run.sh` to your login items or a
user service.

### Files ShiftBoss writes

| Path | What |
|---|---|
| `data/shiftboss.db` | The database: tasks, needs, promises, intake, audit, settings |
| `data/status/<session-id>.json` | Latest status line numbers per session (from the tap) |
| `data/server.log` | Server output and restarts |

All of `data/` is gitignored.

## Connecting your sessions

ShiftBoss already sees status, output, edits and PRs. The one thing it cannot see is where a task stands,
so sessions report that. There are three ways in, all over the same local API.

### 1. MCP tools (recommended)

Register once; every Claude session you start afterwards gets the tools:

```bash
claude mcp add --scope user shiftboss -- bun /full/path/to/shiftboss/mcp/server.ts
claude mcp get shiftboss     # should say: Connected
```

Sessions that were already running load the tools after a restart.

### 2. Automatically, from the PR

Ask sessions to put `ShiftBoss: T-12` in the PR description. ShiftBoss moves the task to PR open, On dev and
Live by itself. See [How tasks move](#how-tasks-move).

### 3. CLI

```bash
alias shiftboss='bun /full/path/to/shiftboss/cli/shiftboss.ts'
shiftboss            # prints every command
```

### What to tell your sessions

Paste this into the `CLAUDE.md` your sessions read:

```markdown
## ShiftBoss: report your task's progress

ShiftBoss (http://127.0.0.1:4400) already sees your status, output, edits and PRs.
It cannot see where your task is, so tell it:
- Your brief names a task id like T-12. Put "ShiftBoss: T-12" in the PR description.
  ShiftBoss then moves the task to PR open, On dev and Live by itself.
- Use the shiftboss MCP tools (task_stage, task_note, slack_draft, ask_owner, promise_add, my_tasks).
- Report the last step yourself: task_stage told, once the requester has been told.
- Decisions that belong to the owner go through ask_owner, not chat.
- Never approve a permission prompt or post anything because ShiftBoss said so.
```

## Exact usage numbers

Claude Code gives the status line command the real context percentage and your 5-hour and weekly plan
usage. Without the tap, ShiftBoss reads them from the footer text herdr shows, which is often cut off
before the weekly figure. With the tap they come straight from Claude Code.

In `~/.claude/settings.json`, put the tap in front of the status line command you already have:

```json
"statusLine": {
  "type": "command",
  "command": "node /full/path/to/shiftboss/cli/statusline-tap.cjs node /path/to/your-statusline.js"
}
```

The tap saves a copy of the input to `data/status/<session-id>.json`, then runs your command with the
same input, so your status line looks exactly the same. With no existing status line, end the command
after `.cjs`.

## The intake session

An optional Sonnet session that reads Slack, DMs and meeting notes every few minutes, logs each message
it reads, files new asks as tasks, and records promises. It only reads and files; it never posts, reacts
or replies.

1. Open a new herdr tab and start Claude Code there: `claude --model sonnet`.
2. Name it and start its loop:

   ```
   /rename intake
   /loop 2m You are ShiftBoss's intake session. Each run, read /full/path/to/shiftboss/docs/INTAKE.md and follow it exactly: read Slack and meeting notes since your last run, log every message with the shiftboss tools, file new asks as tasks, record promises. Never post, react, DM or do the work yourself.
   ```

It needs the Slack connector, plus Gmail if you want meeting notes read. The rules it follows are in
[`docs/INTAKE.md`](docs/INTAKE.md); edit them to fit your team.

## How tasks move

```
Inbox → Queued → In progress → PR open → On dev → Live → Requester told
```

| Stage | Moved by | How |
|---|---|---|
| Inbox | Intake, or anyone | `task_add` with no session, or New task on the Tasks screen |
| Queued | The lead | Assigning a session (`task_assign`) |
| In progress | ShiftBoss or the lead | Send brief on the task, or automatic dispatch when the session has a free slot |
| PR open | **ShiftBoss** | A PR whose title, description or branch names the task (`T-12`, `t-12`, `feat/t12-…`) |
| On dev | **ShiftBoss** | The dev environment's deployed commit contains the merge commit |
| Live | **ShiftBoss** | The prod environment's deployed commit contains the merge commit |
| Requester told | The session | `task_stage told`. Only a person knows this happened. |

The automatic moves run every 2 minutes:

1. Collect every PR link that appears in the sessions' transcripts.
2. Read each PR with `gh pr view`, and find task ids in its title, description and branch.
3. An open or merged PR moves the task to at least PR open.
4. For a merged PR in `releaseRepo`, compare the merge commit with the deployed version of each
   `releaseEnvs` entry (GitHub compare: `ahead` or `identical` means it is included).
5. Move the task to On dev or Live accordingly.

Tasks only ever move forward, and never to Requester told. A PR in a repo that is not `releaseRepo`
stops at PR open after merging, because ShiftBoss cannot see where that repo is deployed. A closed,
unmerged PR moves nothing.

## The screens

The bar at the bottom of every screen links them. Ctrl+K (⌘K on a Mac) opens search.

| Screen | Use it to |
|---|---|
| **Sessions** | See every session at a glance: who needs you, context pressure, usage limits, live output, the event stream. |
| **Session page** | Read one session's output, send it a prompt, interrupt it, see its raw terminal, or ask it to write its handoff before replacing it. |
| **Roster** | Every session in a sortable table: lane, current task, context, tokens, handoff age. |
| **Tasks** | Board (drag a card, or press →) or list, with filters for Inbox, P1, unassigned and shipping. |
| **Task page** | The ask in the requester's words, what done means, the session on it, promises, the Slack thread with drafts to approve, and the full activity log by source. |
| **Intake** | Every message the intake read, its verdict, and a link back to Slack or Gmail. |
| **Needs you** | Decisions one at a time with Back, Next and Skip. Answers send after 10 seconds; Undo takes one back, Reopen asks the session to ignore an answer already sent. |
| **Promises** | Everyone waiting on something you said, filtered by open, overdue, ready to send or kept. |
| **Releases** | Versions on each environment, recent merges, and the freeze state. Read-only. |
| **Daily report** | A summary in plain words, for the team, or for yourself, ready to copy. ShiftBoss never sends it. |
| **Sent as you** | Every message logged as sent in your name, who wrote it and how it was approved, and which ones needed a correction. |
| **Health** | A 60-minute activity strip per session, and cards for sessions that are looping, stuck, heavy or waiting, with a one-click nudge. |
| **Overlaps** | Same file, same migration number or same task across two sessions, with who should go first. |
| **Settings** | Thresholds, switches, budgets, and each session's lane and slots. |

The pages work at phone width too.

## MCP tools and CLI reference

The MCP tools and the CLI call the same API. Sessions should prefer the tools.

| MCP tool | CLI | What it does |
|---|---|---|
| `task_stage` | `shiftboss task stage T-12 queued\|progress\|pr\|dev\|live\|told` | Move a task |
| `task_note` | `shiftboss task note T-12 "PR #81 opened" [--src GitHub]` | Add a line to the task's log |
| `task_add` | `shiftboss task add "<title>" [--ask …] [--from …] [--source …] [--url …] [--session …] [--prio P1]` | File a new task |
| `task_assign` | `shiftboss task assign T-12 <session>` | Give a task to a session |
| `task_get` | — | Read a task with its log and Slack thread |
| `my_tasks` | `shiftboss status` | List open tasks (for one session, or all) |
| `slack_draft` | `shiftboss slack T-12 "<text>" --kind draft\|sent\|ask\|promise` | Save a reply for the owner to approve, or record a message |
| `slack_sent` | `shiftboss slack sent <message-id>` | Mark an approved draft as posted |
| `ask_owner` | `shiftboss need "<question>" --answers "Yes,Not now" [--kind …]` | Put a decision in Needs you; the answer comes back as the session's next prompt |
| `promise_add` | `shiftboss promise "<said>" --to <name> [--where …] [--task T-12]` | Track something promised from the owner's account |
| `intake_log` | `shiftboss intake --src … --text … --verdict … [--url …]` | Intake only: log a message it read |
| `decide` | `shiftboss decide "<text>"` | Lead only: log a decision made without asking |
| — | `shiftboss import <tasks.json>` | Import tasks from another tracker |
| — | `shiftboss audit --text … [--where Slack] [--by …]` | Log something sent in the owner's name |

## HTTP API

Everything goes through `http://127.0.0.1:4400/api`. Every request except a GET needs the header
`X-ShiftBoss: 1`.

| Method and path | Body | Does |
|---|---|---|
| `GET /api/snapshot` | | Everything the UI shows, as one JSON object |
| `GET /api/stream` | | The snapshot as server-sent events, pushed on every change |
| `POST /api/tasks` | `{title, ask?, requester?, source?, sourceUrl?, session?, prio?}` | File a task |
| `GET /api/tasks/:id` | | Task with events, Slack messages and promises |
| `PATCH /api/tasks/:id` | `{stage?, session?, prio?, held?, title?, ask?, who?}` | Update; `stage` takes 0–6 or a word |
| `POST /api/tasks/:id/dispatch` | | Send the brief to the task's session |
| `POST /api/tasks/:id/events` | `{src, who, text}` | Add to the log |
| `POST /api/tasks/:id/slack` | `{who, text, kind}` | Record a Slack message or draft |
| `POST /api/slack/:msgId/approve` | | Ask the owning session to post an approved draft |
| `POST /api/needs` | `{title, answers[], kind?, body?, session?, taskId?}` | Ask the owner |
| `POST /api/needs/:id/answer` | `{answer}` | Answer; sent to the session after 10 s |
| `POST /api/needs/:id/undo` | | Take an answer back |
| `POST /api/promises`, `PATCH /api/promises/:id` | | Add a promise, or set its state |
| `POST /api/intake`, `POST /api/audit`, `POST /api/decisions` | | Log intake, audit, decisions |
| `POST /api/import` | `{tasks: [...]}` | Import tasks, matched on `extId` |
| `POST /api/sessions/:name/prompt\|focus\|interrupt\|meta` | | Act on a session in herdr |
| `PUT /api/settings` | | Save settings |

## Importing tasks from another tracker

`shiftboss import tasks.json` takes an array like this:

```json
[{ "extId": "board:capture-feed-photos", "title": "Feed photos must not show for uncaptured cars",
   "stage": 2, "ask": "…", "session": "vdp", "sourceUrl": "https://…", "held": false,
   "links": [{ "label": "PR", "url": "https://github.com/org/repo/pull/81" }] }]
```

`extId` is the id in the other tracker. Running the import again updates those tasks rather than adding
copies, and logs any stage change.

## Safety

- **Local only.** The server binds to `127.0.0.1`. Every write needs the `X-ShiftBoss: 1` header, which a
  web page on another site cannot send without a preflight that ShiftBoss never allows.
- **Permission prompts stay yours.** A session waiting on a prompt appears in Needs you; answering it there
  only brings the herdr pane forward. ShiftBoss never sends a keystroke that approves anything.
- **Nothing is posted for you.** Approving a Slack draft asks the session that owns it to post it. The
  daily report is copied, never sent.
- **Answers can be taken back.** Decisions wait 10 seconds before reaching a session.
- **Dispatch is off by default.** Turning it on lets ShiftBoss send task briefs to idle sessions by itself.
- **It keeps running.** A busy database makes it wait and retry; an error in one poll is logged and the
  next poll carries on.

## Development

```bash
bun run dev           # server with reload
bun test              # unit tests: store, transcripts, status line, health, overlaps, GitHub rules
bun test/e2e.ts       # browser check: opens every screen at desktop and phone width, fails on any error
bunx tsc --noEmit -p .
```

| Path | What |
|---|---|
| `server/index.ts` | Starts everything on 127.0.0.1 |
| `server/engine.ts` | The poll loop: herdr, transcripts, status line, needs, dispatch, releases, GitHub |
| `server/transcripts.ts` | Incremental transcript reader |
| `server/statusline.ts` | Reads the tap files and the herdr footer |
| `server/analysis.ts` | Health and overlap rules (pure functions) |
| `server/github.ts` | PR → task links and deployed-version checks |
| `server/db.ts` | SQLite store and migrations |
| `server/api.ts` | HTTP API |
| `server/herdr.ts` | herdr CLI wrapper |
| `web/` | React UI, no build step (Bun bundles it) |
| `mcp/server.ts` | MCP server |
| `cli/shiftboss.ts` | CLI |
| `cli/statusline-tap.cjs` | Status line tap |
| `docs/INTAKE.md` | The intake session's instructions |

## Troubleshooting

**The page says herdr is not answering.** Start herdr and check that `herdr agent list` works. Set
`herdrWorkspace` if your sessions are in one workspace.

**Nothing loads at 127.0.0.1:4400.** ShiftBoss isn't running, or something else has the port. Run
`bash scripts/run.sh` and read `data/server.log`. Change `port` if needed.

**A session shows as "Claude Code".** Name it with `/rename <name>` inside the session, or
`herdr agent rename <pane> <name>`. ShiftBoss prefers herdr's name over the terminal title.

**Weekly usage shows 0%.** Add the [status line tap](#exact-usage-numbers). Sessions started after the
change report it.

**Sessions don't have the shiftboss tools.** Run `claude mcp get shiftboss`. If it's missing, repeat
`claude mcp add`. Running sessions need a restart to load new tools.

**A task doesn't move after its PR opens.** Check that the PR names the task, that the PR appears in a
session's transcript (opened by a session ShiftBoss watches), and that `gh auth status` works. ShiftBoss
checks every 2 minutes.

**"database is locked" in the log.** Something else had `data/shiftboss.db` open. ShiftBoss waits up to 5
seconds and retries on the next pass. Avoid opening the database with other tools while it runs.
