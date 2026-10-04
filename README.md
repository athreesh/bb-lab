# bb-lab

Plugins and experiments for [bb](https://github.com/get-bb/bb), the agent IDE that builds itself.

| Plugin | What it does |
| --- | --- |
| [`plugins/council/`](plugins/council/) | **THE COUNCIL** — put the same problem in front of several agents on different providers, let them argue it out under a turn budget, then have a synthesizer merge the debate into one answer. |

## Install

```sh
git clone https://github.com/athreesh/bb-lab.git
cd bb-lab
bb plugin install ./plugins/council
```

Iterate with `bb plugin reload council` (or `bb plugin dev` inside the plugin directory); type-check with `npx tsc -p .`.

## Council quickstart

Create a council, pick its seats, convene it — from the UI panel or the CLI:

```sh
bb council create --title "DB choice" --project <id> \
  --seats claude=claude-code,codex=acp-codex,grok=acp-grok --chief claude --turns 8
bb council convene <council> "Should we use Postgres or SQLite for this service?"
```

Every reply ends with a stance footer that the plugin parses to drive the debate:

```
STANCE: agree | disagree | need-info | pass
OPEN:
- one open point per line
```

The debate ends early once every seat is at `agree`/`pass` with nothing left open, when the turn budget runs out, or when someone blocks with `need-info` (you answer in the council, then resume). The chief writes the final synthesis and the verdict is recorded. Seats are read-only unless you mark them `:edit`.

## License

MIT
