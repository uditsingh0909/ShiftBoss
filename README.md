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
- [Desktop app (Windows)](#desktop-app-windows)
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
| Automatic task moves | `gh pr view` for each PR seen in a transcript, and GitHub's compare API against the deployed versions |

Everything is one Bun process: the engine, the API and the web UI. There is no cloud service and no
account.

## Requirements

| Tool | Why | Check |
|---|---|---|
| [Bun](https://bun.sh) 1.2 or newer | Runs the server, the CLI and the MCP server | `bun --version` |
| [herdr](https://herdr.dev) | ShiftBoss reads your sessions from it | `herdr agent list` |
| [Claude Code](https://claude.com/claude-code) | The sessions themselves | `claude --version` |
| [GitHub CLI](https://cli.github.com) (optional) | Automatic task moves (PR open, On dev, Live) | `gh auth status` |

Tested on Windows 11 (Git Bash) with Bun 1.4. It should run on macOS and Linux; the login-startup
launcher below is Windows-only.

## Setup guide

### The quick way: let Claude Code do it

Paste this into Claude Code (any session, on the machine that runs herdr):

```
Set up ShiftBoss for me: https://github.com/uditsingh0909/ShiftBoss — clone it and follow its SETUP.md.
```

It checks the machine, asks you a few questions (your name, which extras, your lead session), installs
and starts ShiftBoss, then brings in the work your sessions are already doing. Open
<http://127.0.0.1:4400/#/welcome> to watch each step tick off, or take over there at any point. The same
steps are in the CLI (`shiftboss setup …`) and the MCP tools (`setup_status`, `onboarding_ask`, …).

### Not using herdr yet?

ShiftBoss watches sessions through herdr. If you run Claude Code on its own (the CLI, the TUI or the desktop app),
your sessions can move into herdr with nothing lost, because Claude keeps each session's history:

- **Get started → "Not on herdr yet? Bring your sessions in"** lists recent sessions that are not in herdr. Tick
  them, close their old windows, and press Open: each reopens in its own herdr tab with `claude --resume`.
- Or the CLI: `shiftboss session outside`, then `shiftboss session bring-in <session-id>`.
- Or by hand: in a herdr tab, `cd` to the project and run `claude --resume`, then `/rename <name>`.

Plain chats in the Claude desktop app are not Claude Code sessions, so there is nothing to watch; adding the
shiftboss MCP server to the desktop app still gives you the task board, Needs you and promises.

### By hand

About 15 minutes from a fresh clone to a full board. Each step says how to check it worked.
`bun scripts/setup.ts` runs steps 1 to 7 for you (`--help` is at the top of that file).

#### Before you start

- [ ] Bun, herdr and Claude Code are installed (see [Requirements](#requirements)).
- [ ] herdr is running and `herdr agent list` prints your sessions.
- [ ] Optional: `gh auth status` works (automatic PR open / On dev / Live moves).
- [ ] Optional, for the intake session: Claude Code has the Slack connector, and Gmail if you want
      meeting notes read.

#### 1. Install

```bash
git clone https://github.com/uditsingh0909/ShiftBoss.git shiftboss
cd shiftboss
bun install
bun test                     # every test should pass
```

#### 2. Configure

```bash
cp shiftboss.config.example.json shiftboss.config.json
```

The one field worth setting now is `ownerName` (your name; it appears in prompts ShiftBoss sends). Add
`herdrWorkspace` if you only want one herdr workspace shown. Everything else has a working default; the
full list is under [Configuration](#configuration).

```json
{ "ownerName": "Sam", "herdrWorkspace": "w1" }
```

#### 3. Start it

```bash
bash scripts/run.sh          # keeps it running; logs to data/server.log
```

Open <http://127.0.0.1:4400>. **Check:** your sessions appear within a few seconds. To start it with
Windows, see [Start at login](#start-at-login-windows).

#### 4. Follow Get started

With an empty board, ShiftBoss opens on **Get started** (also under *Get started* at the top right, or
`Ctrl+K`). It checks each step as you go:

| Step | What you do | What it gives you |
|---|---|---|
| 1. Connect the tools | Run the `claude mcp add …` command it shows (details in [step 5](#5-give-sessions-the-tools)) | Sessions can report their tasks |
| 2. Lead session | Name the session that coordinates the others | It always gets the big card on Sessions; `name-v2` takes over automatically |
| 3. Bring in current work | Tick sessions and press **Ask** | Each gets one prompt to put its tasks, stages and promises on the board. Their work is not changed |
| 4. Read back Slack and Gmail | Pick 1–14 days, press **Read back** | The intake reads everything since then and files what is still open (needs step 7) |
| 5. Import | Optional: `shiftboss import tasks.json` | Tasks from Jira or a spreadsheet ([format](#importing-tasks-from-another-tracker)) |

Press **Finish setup** when done. Every step can be run again later.

#### 5. Give sessions the tools

```bash
claude mcp add --scope user shiftboss -- bun /full/path/to/shiftboss/mcp/server.ts
claude mcp get shiftboss     # should say: Connected
```

Restart the sessions that were already running so they load the tools. Then paste the
[CLAUDE.md snippet](#what-to-tell-your-sessions) into the `CLAUDE.md` your sessions read, so they report
without being asked. **Check:** the Connect screen (`#/setup`) marks a session "reports with tools" once
it has used one.

#### 6. Exact usage numbers (optional)

Put the [status line tap](#exact-usage-numbers) in front of your status line command. **Check:** on
Connect, sessions started afterwards show "exact usage".

#### 7. Start the intake session

The intake reads Slack and Gmail for you and files asks as tasks. See
[The intake session](#the-intake-session). **Check:** the Intake card on Sessions says "Reading · checked
in … ago", and **Check now** runs a pass on demand.

#### 8. Check it all works

- [ ] Sessions shows every session, the lead in the big card, and either *All clear* or a *Needs
      attention* strip.
- [ ] Tasks has the work your sessions reported (step 4.3) and the intake filed (step 4.4).
- [ ] Pressing **Open in herdr** on an item focuses that pane and (on Windows) brings the herdr window to
      the front.
- [ ] `bun /full/path/to/shiftboss/cli/shiftboss.ts status` prints the same counts.

## Configuration

`shiftboss.config.json` holds everything specific to you and your team. It is gitignored, so nothing in it
is committed. Every field is optional; the defaults work for a single person with sessions in any herdr
workspace.

| Field | Default | What it does |
|---|---|---|
| `ownerName` | `"The owner"` | Your name. Used in prompts ShiftBoss sends to sessions, e.g. "Priya's answer to …". |
| `port` | `4400` | Port on 127.0.0.1. |
| `herdrWorkspace` | `""` | Only show sessions in this herdr workspace, e.g. `"w1"`. Empty means every workspace. |
| `handoffsDir` | `""` | Folder with one handoff file per session (`<session>.md`). ShiftBoss shows each file's age. |
| `lanes` | `{}` | Per session: what it works on and how many tasks it may hold, e.g. `{"billing-fix": {"lane": "billing, invoices", "slots": 2}}`. Also editable on the Settings screen. |
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
| Suggest replace at | 85% | Bars turn red; the session page offers Replace, and Replace… on Sessions pre-ticks these |
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

### Updates

ShiftBoss keeps itself up to date. Every 30 minutes it checks GitHub. If there is a newer version and your
copy has no local edits or commits, it installs it (and any new packages), checks that it builds, and restarts
quietly; open pages reload by themselves. If the new version does not build, it goes back to the one that was
running. It waits while an answer, a brief or a new session is in flight.

- Settings → Updates shows the running version and has **Check now** and an on/off switch.
- From a terminal: `shiftboss update` (or `shiftboss update --check` to only look). It works with ShiftBoss
  stopped too.
- A restart into the new version needs `scripts/run.sh` (setup and the login launcher use it). Started any other
  way, it updates and tells you to restart.

### Modes: how much ShiftBoss does on its own

Settings → **Mode**. Your own clicks always run; the mode covers what ShiftBoss does by itself (automatic sending,
monitor checks) and what a session asks it to do (start, replace or bring in sessions, prompt or stop another
session).

| Mode | What happens |
|---|---|
| **Dry run** | Nothing happens. Each action is recorded in Needs you → Dry run log. New installs start here. |
| **Ask first** | Every action waits in Needs you → Waiting for your approval (Approve, Reject, Approve all). |
| **Safe auto** | Routine actions run (a brief, an intake pass, a monitor check); risky ones wait: new sessions, replacing, prompting or stopping another session. |
| **Autopilot** | Everything runs. Installs from before modes existed stay here. |

Leaving Dry run asks whether to review what it recorded (it becomes approvals) or drop it.

### Your way of working

Settings → **Your way of working**: how you like work done, in your own words ("always let me review a PR before
it is merged"). ShiftBoss adds it to every brief, handoff and prompt it sends, the intake gets it from
`intake_begin`, and any session can read it with the `owner_instructions` tool.

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

## Desktop app (Windows)

`desktop/` wraps ShiftBoss in a native Windows app (Tauri 2): its own window, a tray icon (Open, Needs
you, Start at login, Quit), a desktop notification for each new decision in Needs you, and only one copy
running at a time. Closing the window keeps it in the tray; Quit is in the tray menu.

When it starts, it uses a ShiftBoss already answering on `127.0.0.1:4400`. If none is, it starts the
server bundled inside the app, with its data in the app's own data folder
(`%APPDATA%\dev.shiftboss.app`) instead of `data/`.

To build it you need [Rust](https://rustup.rs) and the Visual Studio C++ Build Tools (the "Desktop
development with C++" workload), plus Bun. Then:

```bash
cd desktop
bun install
bun scripts/build-server.ts                      # compiles the server into binaries/
./node_modules/.bin/tauri build --bundles nsis   # the installer
```

The installer lands in `desktop/src-tauri/target/release/bundle/nsis/`. Run it, or install silently to
a folder of your choice with `ShiftBoss_0.1.0_x64-setup.exe /S /D=D:\Apps\ShiftBoss`.

The window's browser data (WebView2) goes in `%LOCALAPPDATA%\dev.shiftboss.app`, about 20 MB.

macOS and Linux builds are planned but not yet built.

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
- At the start, read the owner's way of working with the shiftboss tool owner_instructions, and follow it.
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
after `.cjs`. If ShiftBoss keeps its data elsewhere (`SHIFTBOSS_DATA_DIR`, as the desktop app does), put
`--data-dir=<that folder>` right after `.cjs`; the Connect page shows the exact command. Commands that are
`.cmd` shims on Windows (`npx …`, `bunx …`) work as they are, and if your command fails the status line
says so in one short line instead of going blank.

## The intake session

An optional Sonnet session that reads Slack and Gmail every couple of minutes, logs each message it reads,
files new asks as tasks, and records promises. It only reads and files; it never posts, reacts or replies.

What it reads, from where it last stopped:

- **Slack:** messages that mention you, DMs, and new top-level messages in the watched channels
  (Settings → Intake). **Threads only where you are involved:** threads you are @-mentioned in, threads
  you started or replied in during the last 7 days, and the thread behind each open task. New replies in
  old threads count.
- **Gmail:** meeting notes (for example Gemini's "Notes by Gemini"; action items for you become tasks,
  things you said you would do become promises) and emails that ask you for something. Newsletters,
  notifications and receipts are skipped.

To start it:

1. Open a new herdr tab **in the folder you usually work in** and start Claude Code there: `claude --model sonnet`.
   Claude already trusts that folder, so it starts straight away; the intake needs nothing from the ShiftBoss folder.
2. Name it and start its loop (the Connect screen shows this command with your path filled in):

   ```
   /rename intake
   /loop 2m You are ShiftBoss's intake session. Each run, read /full/path/to/shiftboss/docs/INTAKE.md and follow it exactly: start with intake_begin, read Slack (mentions, DMs, watched channels, and new replies in threads the owner is in), then Gmail (meeting notes and emails with asks) from readFrom, log every message with the shiftboss tools, file new asks as tasks, record promises, end with intake_checkpoint. Never post, react, DM or do the work yourself.
   ```

Controlling it, from the Intake card on Sessions or the Intake screen:

| Button | What happens |
|---|---|
| **Check now** | Asks the intake for one pass right away instead of waiting for its loop |
| **Pause** / **Pause until…** | Each run checks in and does nothing until you resume (or until the time you picked) |
| **Resume and catch up** | Reads everything that came in while paused, oldest first |
| **Resume from now** | Skips what came in while paused |

It needs the Slack connector, plus Gmail for meeting notes. The rules it follows are in
[`docs/INTAKE.md`](docs/INTAKE.md); it re-reads them every run, so edits apply on the next pass.

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
| **Get started** | First-run setup: connect the tools, pick the lead, ask running sessions to register their work, send the intake back in time, import. |
| **Sessions** | Every session at a glance: the lead in the big card, a *Needs attention* strip (decisions, unhealthy sessions, overlaps, due promises, a silent intake), context pressure, usage limits, the intake card, live output. **New task** and **New session** (one, or several at once) start work from here; **Replace…** hands sessions over to fresh ones. |
| **Session page** | Read one session's output, send it a prompt, interrupt it, see its raw terminal, or ask it to write its handoff before replacing it. |
| **Roster** | Every session in a sortable table: lane, current task, context, tokens, handoff age. |
| **Tasks** | Board (drag a card, or press →) or list, with filters for Inbox, P1, unassigned and shipping. |
| **Task page** | The ask in the requester's words, what done means, the session on it, promises, the Slack thread with drafts to approve, and the full activity log by source. |
| **Intake** | Every message the intake read, its verdict, and a link back to Slack or Gmail. |
| **Needs you** | Decisions one at a time with Back, Next and Skip. Answers send after 10 seconds; Undo takes one back, Reopen asks the session to ignore an answer already sent. |
| **Promises** | Everyone waiting on something you said, filtered by open, overdue, ready to send or kept. |
| **Daily report** | A summary in plain words, for the team, or for yourself, ready to copy. ShiftBoss never sends it. |
| **Sent as you** | Every message logged as sent in your name, who wrote it and how it was approved, and which ones needed a correction. |
| **Health** | A 60-minute activity strip per session, and cards for sessions that are looping, stuck, heavy or waiting, with a one-click nudge. |
| **Overlaps** | Same file, same migration number or same task across two sessions, with who should go first. |
| **Connect** | Checks MCP, the status line tap and the intake, with the exact commands for this install. |
| **Settings** | General, warnings, automation, intake, usage budgets, and each session's lane and slots. |

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
| `intake_begin`, `intake_checkpoint` | `shiftboss intake begin`, `shiftboss intake checkpoint <ISO time>` | Intake only: start and end each run (pause, resume and catch-up) |
| `setup_status` | `shiftboss setup status [--json]` | What is connected, every session with its task count, what is left to set up |
| `setup_lead` | `shiftboss setup lead <session> [--workspace W]` | Set the lead session |
| `onboarding_ask` | `shiftboss setup ask <session…> \| --all` | Ask running sessions to register their work on the board |
| `onboarding_backfill` | `shiftboss setup backfill <1\|2\|3\|7\|14>` | Send the intake back that many days |
| `onboarding_done` | `shiftboss setup done` | Mark setup finished |
| `session_spawn` | `shiftboss session spawn <name> --cwd DIR [--model …] [--prompt …]` | Start Claude Code in a new herdr tab |
| | `shiftboss session spawn-many <file.json>` | Start up to 20 sessions one after another |
| `session_replace` | `shiftboss session replace <name…>` | Replace sessions through a handoff (see below) |

**Replacing a session.** ShiftBoss asks it to write a handoff (its handoff path, else
`<handoffs folder>/<name>.md`, else `HANDOFF-<name>.md` in its folder) with fixed sections (Open tasks,
PRs, Promises owed, Scheduled jobs, Worktrees and branches, Decisions made, Open questions, Next steps)
ending in `HANDOFF COMPLETE`. Once the file is written and complete, it starts `<name>-vN` in the same
folder with the same model, moves the open tasks, unsent questions and lane to it, and sends it a first
prompt: read the handoff, check the old transcript if unclear, register with `my_tasks`, continue. After
20 minutes without a complete handoff it shows as stalled. The old session is never closed: you close it.
A session sitting at a prompt is never typed into; the request waits until it moves on.

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
| `POST /api/sessions/spawn` | `{name, cwd, model?, prompt?}` | Start Claude Code in a new herdr tab |
| `POST /api/sessions/spawn-many` | `{sessions: [{name, cwd, model?, prompt?}, …]}` | Start up to 20, one after another; every row is checked before any starts |
| `POST /api/sessions/replace` | `{sessions: [name, …]}` | Start a handoff replacement for each; progress is `replacements` in the snapshot |
| `POST /api/replacements/:id/cancel` | | Stop a replacement before its new session starts |
| `POST /api/intake/run` | | Ask the intake for one pass now |
| `POST /api/intake/pause\|resume` | `{until?}` / `{catchUp}` | Pause or resume the intake |
| `POST /api/onboarding/ask` | `{sessions: [...]}` | Ask running sessions to register their tasks |
| `POST /api/onboarding/backfill` | `{days}` | Send the intake back 1, 2, 3, 7 or 14 days |
| `POST /api/onboarding/done` | `{done}` | Mark setup finished |
| `GET /api/setup` | | What is connected, and the commands for this install |
| `PUT /api/settings` | | Save settings |

## Importing tasks from another tracker

`shiftboss import tasks.json` takes an array like this:

```json
[{ "extId": "JIRA-123", "title": "Fix the billing export",
   "stage": 2, "ask": "…", "session": "billing-fix", "sourceUrl": "https://…", "held": false,
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

**A new session from New session sits in Needs you.** Claude asks "trust this folder?" the first time it
opens a folder. ShiftBoss never answers that for you: press Open in herdr and answer it there.

**Open in herdr doesn't bring the window forward.** Windows lets only the app you are using hand focus
away; ShiftBoss works around it, but a full-screen app or a locked screen can still win. The pane is
focused inside herdr either way.

**Check now says the intake is paused.** Resume it first (Resume and catch up keeps what came in
meanwhile).

**Get started keeps opening.** It opens while the board is empty and setup is unfinished. Press Finish
setup, or add a task.

**"database is locked" in the log.** Something else had `data/shiftboss.db` open. ShiftBoss waits up to 5
seconds and retries on the next pass. Avoid opening the database with other tools while it runs.
