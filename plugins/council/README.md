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

## Files

- `server.ts` — SQLite store, spawn/relay, footer parsing, debate scheduler,
  synthesis, RPC, the `bb council` CLI.
- `app.tsx` — **Council** nav panel: council list, transcript, convene/resume.
- `skills/council/SKILL.md` — the protocol every seat is given.

## Develop

```sh
npm install
bb plugin install .
bb plugin dev            # rebuild + reload on save
npx tsc -p .             # type-check
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
