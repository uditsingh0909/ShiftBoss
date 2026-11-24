# Foreman

A control room for a team of Claude Code sessions running in [herdr](https://herdr.dev).
One local page shows every session live, the tasks they are working on, the decisions
waiting on you, and the promises you have made to people.

It runs on your machine, binds to `127.0.0.1` only, and never answers a permission prompt
or posts to Slack for you.

## Run it

```
bun install
cp foreman.config.example.json foreman.config.json   # then edit it
bun run start                                         # http://127.0.0.1:4400
```

`bun run dev` reloads on save. `bun test` runs the tests.

## Where the numbers come from

| What | Source |
|---|---|
| Sessions, status (working / idle / done / blocked) | `herdr agent list` every 2 s |
| Output, last tool, files edited, tokens | the session's transcript, `~/.claude/projects/<project>/<session-id>.jsonl`, read incrementally |
| Context %, 5-hour and weekly usage | Claude Code's status line: exact with the tap below, otherwise read from the footer herdr shows |
| Tasks, decisions, promises, intake, audit | Foreman's own SQLite file, `data/foreman.db`, written through the API and the CLI |
| Releases | `releaseEnvs` URLs and `gh pr list` for `releaseRepo` (optional) |

### Exact usage numbers (optional)

Claude Code gives the status line command the real context and plan usage. Wrap your
existing status line with the tap and Foreman reads the same numbers:

```json
"statusLine": { "type": "command",
  "command": "node D:/Ditra/foreman/cli/statusline-tap.cjs node C:/Users/you/.claude/statusline-command.js" }
```

The tap writes `data/status/<session-id>.json` and passes the input on, so what you see in
the terminal does not change.

## How sessions talk to Foreman

Every session can run the CLI (`bun D:/Ditra/foreman/cli/foreman.ts …`, or link it as `foreman`):

```
foreman task add "Name every screen" --from Temgire --source "#platform" --session general-tasks --prio P1
foreman task stage T-12 pr        # queued | progress | pr | dev | live | told
foreman slack T-12 "Live on dev: every screen named" --kind draft --who general-tasks
foreman promise "I'll update here when it's live" --to Temgire --where "#platform" --task T-12
foreman need "Restore recordings at 9 stores?" --answers "Yes,Not now" --kind "Production write" --task T-13
foreman intake --src "#platform" --who Temgire --text "Can we show chat time?" --verdict "filed T-12" --task T-12
```

`docs/INTAKE.md` is the prompt for the intake session that reads Slack and meeting notes and
files tasks with these commands.

## Safety

- Binds to `127.0.0.1`. Every write needs the `X-Foreman: 1` header, so another web page cannot trigger one.
- Permission prompts: Foreman shows them and focuses the herdr pane. You answer in herdr.
- Slack drafts: approving one asks the owning session to post it. Foreman itself never posts.
- Automatic dispatch is off by default; when on, Foreman sends queued task briefs to idle sessions with a free slot.
