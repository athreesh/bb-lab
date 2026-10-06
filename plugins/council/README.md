# bb-plugin-council

**THE COUNCIL**: several agents on different providers argue one problem to a
verdict, then a chief seat synthesizes the debate.

- A **Council** is a transcript owned by this plugin. Seats are ordinary bb
  threads, one per provider, sharing one workspace.
- **Convene** with a question and a turn budget. The moderator relays the
  question to every seat in parallel; each reply is parsed for its
  `STANCE / OPEN` footer and posted back.
- The debate continues while any seat is `disagree` with open points. The
  moderator picks the next speaker, always delivering a seat only what it has
  not seen, labeled by author. It stops early on consensus (every seat
  `agree`/`pass`, nothing open), on the turn cap, or pauses on `need-info`
  until you answer.
- The **chief** seat (chosen at creation) writes the final synthesis from the
  transcript; the verdict is recorded and stamped into the council.
- Seats are read-only unless marked `:edit`.

The **New council** form defaults to GLM 5.3 Flash on OMP (chief), Codex
(default model), Claude Code (default model), and DeepSeek v4 Flash on OMP.
The OMP seats use `webster/glm-5.3-flash` and `webster/deepseek-v4-flash`
explicitly, with file editing enabled. Unavailable providers are skipped;
a missing model catalog never changes an explicit model to the provider default.
Chief follows the selected seat when its handle changes. Removing it selects
the first remaining seat. Handles and other fields are validated before submit,
and RPC validation errors identify the affected field. CLI creation still uses
explicit `--seats`.

## Slash command

Invoke `/council <question>` in a BB thread to start the four-seat preset in
that thread's workspace. With no question, the agent uses the clear current
problem or asks what to discuss. GLM chairs; Codex and Claude's default models
are resolved and saved at launch. The launcher checks that all four choices
are available before creating a council. It reports any seat startup failures.

The launcher uses the `councils_launch` RPC with `projectId`, `environmentId`,
`question`, and optional `title`/`turns`. Its result contains `council` and
`failures` (seat handle and error). `/council-seat` is the separate participant
protocol; it never launches a nested council. The debate appears in the Council
panel; `bb council show <id>` reads the transcript.

## Files

- `server.ts` — SQLite store, spawn/relay, footer parsing, debate scheduler,
  synthesis, RPC, the `bb council` CLI.
- `app.tsx` — **Council** nav panel: council list, transcript, convene/resume.
- `skills/council/SKILL.md` — `/council` launcher and its safe JSON/RPC helper.
- `skills/council-seat/SKILL.md` — the participant protocol used by seat threads.

## Develop

```sh
npm install
bb plugin install .
bb plugin dev            # rebuild + reload on save
npm run typecheck
npm test                # rendered-form and backend contract regressions
bb plugin logs council
```

Schema changes are append-only in `MIGRATIONS`. To start over, disable the
plugin, delete `<dataDir>/plugins/council/data.db`, and enable it again.

## CLI

```sh
bb council list
bb council show <council> [--since <seq>]
bb council create --title <t> --project <id> \
  --seats claude=claude-code,codex=acp-codex,grok=acp-grok[:edit] \
  [--model handle=model] [--reasoning handle=level] [--chief handle] [--turns N]
bb council convene <council> <question...>        # start the debate
bb council say <council> [--as user] <message...> # answer need-info / interject
bb council resume <council>                       # resume a paused debate
bb council halt <council>                         # stop every running seat
bb council add <council> <handle>=<provider>[=model][:edit] [--brief full|summary|none]
bb council verdict <council>                      # force synthesis with current chief
bb council archive <council>
```
