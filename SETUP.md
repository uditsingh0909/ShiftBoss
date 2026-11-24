# Setting up ShiftBoss (for Claude Code)

You are Claude Code, and someone has asked you to set up ShiftBoss from this repository. Follow these
steps in order. The person should only have to answer a few questions. The Get started screen
(`http://127.0.0.1:<port>/#/welcome`) shows the same steps and updates live while you work. Point the
person at it once ShiftBoss is running, so they can watch or take over.

## Ground rules

- **Ask before changing anything outside the ShiftBoss folder.** That covers registering the MCP server,
  editing `~/.claude/settings.json` (status line) and adding a login item. Each is its own flag below,
  so run only what the person agreed to.
- **Ask before prompting their sessions.** "Bring in current work" sends one prompt to each running
  session. Show them the list first.
- **Never answer a permission prompt or a "trust this folder?" prompt** in any session, including ones
  ShiftBoss starts. Tell the person to answer it in herdr.
- ShiftBoss never posts to Slack or anywhere else. Don't set up anything that does.

## 1. Get the code

Ask where to put it if they haven't said. Default to a `shiftboss` folder next to their other repos.

```bash
git clone https://github.com/uditsingh0909/ShiftBoss.git shiftboss
cd shiftboss
```

## 2. Check the machine (changes nothing)

```bash
bun scripts/setup.ts --json
```

Read `checks`. Fix or report anything not ok before going on:

| Check | If it fails |
|---|---|
| `bun` | You are running it with bun, so this passes |
| `herdr` | Ask them to start herdr. ShiftBoss reads sessions from it |
| `claude` | Claude Code is not on `PATH` |
| `gh (optional)` | Fine to skip. Without it, tasks don't move to PR open, On dev and Live by themselves |

## 3. Ask the person (one round, with your question tool)

1. **Their name**, as teammates know them. It appears in prompts ShiftBoss sends to sessions.
2. **Which extras to turn on**, as a multi-select:
   - MCP tools (recommended: sessions report their progress through them). Runs `claude mcp add --scope user`.
   - Exact usage numbers. Puts a small tap in front of their status line in `~/.claude/settings.json`, with a backup.
   - Start at login (Windows).
   - Intake session. Reads Slack and Gmail for them; it needs the Slack connector, plus Gmail for meeting notes.
3. **Their lead session**: the session that coordinates the others. Offer the names from
   `herdr agent list` (or "none yet").
4. **How much ShiftBoss may do on its own** (`--mode`). Recommend **Dry run** for the first hours: it only
   records what it would do (start sessions, send briefs, run checks), so they can see it is safe before going live.
   - `dry` Dry run: nothing happens, everything is recorded
   - `ask` Ask first: every action waits for their approval in Needs you
   - `safe` Safe auto: routine actions (sending a brief, a monitor check) run; risky ones (new sessions, prompting another session) wait
   - `auto` Autopilot: everything runs
   They switch any time in Settings → Mode. Their own clicks in ShiftBoss always run.
5. **Only if they have several herdr workspaces:** which one to show.

## 4. Run setup with their answers

```bash
bun scripts/setup.ts --owner "<name>" --lead <session> --mode <dry|ask|safe|auto> --start [--workspace <id>] [--mcp] [--status-line] [--startup] [--intake --intake-cwd "<folder you were started in>"]
```

Include only the extras they picked. It prints what it did and what is left. Then tell them to open
`http://127.0.0.1:4400/#/welcome` (or the port it printed).

Start the intake in **the folder this Claude session was started in** (`--intake-cwd`), not the ShiftBoss folder: Claude already
trusts that folder, so the new tab starts straight away. The intake needs nothing from the ShiftBoss folder. Only if setup
says it fell back to the ShiftBoss folder will the tab stop at "trust this folder?"; then tell them to answer it in herdr.

## 5. Bring in what is already running

This session started before the MCP tools were registered, so use the CLI here. The tools work in
sessions started from now on. `shiftboss` below means `bun <shiftboss folder>/cli/shiftboss.ts`.

```bash
shiftboss setup status                # sessions, their task counts, and who was asked
```

1. **Sessions outside herdr.** If they also use Claude Code without herdr (the plain CLI, the TUI or the desktop
   app), those sessions can move into herdr with their full history:

   ```bash
   shiftboss session outside --days 7   # recent Claude sessions not running in herdr
   ```

   Show them the list and ask which to bring in. Ask them to **close each one's old window first**, so two copies
   don't write the same history (a row marked ACTIVE NOW is probably still open). Then:

   ```bash
   shiftboss session bring-in <session-id> <session-id> …   # each reopens in its own herdr tab, claude --resume
   ```

   The Get started screen has the same list with checkboxes. Skip this if they only use herdr.
2. Show them the sessions that `setup ask --all` would pick: not the intake, not asked yet, no tasks on
   the board. Once they agree:

   ```bash
   shiftboss setup ask --all            # or: shiftboss setup ask <name> <name> …
   ```

   Each session gets one prompt to register its tasks, stages and promises, and is told not to change
   its work. Busy sessions answer after their current step; blocked ones answer once unblocked.
3. If the intake is running, ask how far back to read (1, 2, 3, 7 or 14 days; 3 is a good default).
   If the intake tab is waiting on a prompt in herdr, the time is still saved and the intake reads from it once
   it runs; the command says so:

   ```bash
   shiftboss setup backfill 3
   ```

4. Optional: tasks from Jira or a spreadsheet can be imported as JSON (`shiftboss import tasks.json`,
   format in the README).

## 6. Finish

```bash
shiftboss setup done
shiftboss setup status                # confirm
```

Tell them, in a few lines:

- the link (`http://127.0.0.1:<port>`);
- what you turned on;
- that sessions they restart now get the shiftboss tools;
- for every session to report on its own: paste the "What to tell your sessions" snippet from the README
  into the `CLAUDE.md` their sessions read. It is in the Connect screen too, with a copy button.

## If something goes wrong

- `ShiftBoss running` failed: read `data/server.log`. If another program has the port, rerun with
  `--port 4401`.
- `MCP tools: registered to another install`: they have ShiftBoss elsewhere too. Ask before
  `--mcp`, because it repoints the tools to this install.
- Everything is re-runnable: run `bun scripts/setup.ts` again at any time to see where things stand.
