# bb-lab

Plugins for [bb](https://github.com/get-bb/bb), the agent IDE that builds itself.

## Plugins

| Plugin | What you get | Surface |
| --- | --- | --- |
| [`council`](plugins/council/) | Several agents on different providers argue one question under a turn budget; a chief seat synthesizes the debate into a recorded verdict. | Nav panel, `/council` slash command, `bb council` CLI |
| [`usage-hud`](plugins/bb-plugin-usage-hud/) | Live inference metrics — context %, per-turn token breakdown, tok/s, TTFT, cost — as a fixed HUD in the bb window. | App overlay, `bb usage-hud` CLI |
| [`ceo-interaction`](plugins/bb-plugin-ceo-interaction/) | A headless skill, injected into every agent thread, that gives agents a working contract for collaborating with you: steer with proposals, escalate only real decisions, conclude-first reports. | Skill (no UI or CLI) |

Each plugin directory has its own README with full details.

## Install

```sh
git clone https://github.com/athreesh/bb-lab.git
cd bb-lab
bb plugin install ./plugins/council   # or usage-hud, ceo-interaction
```

## Develop

From a plugin directory:

```sh
npm install
bb plugin install .
bb plugin reload <plugin-name>   # reload after changes
bb plugin dev                    # rebuild + reload on save
```

## License

MIT
