# Usage Hud

Live inference metrics for the thread you're looking at, rendered as a fixed
HUD in the bottom-left of the bb window.

## What it shows

- **Context ring + %** — native `thread/contextWindowUsage/updated` events,
  available for every provider (omp sends them via ACP `usage_update`).
- **in / cache / out / think** — per-turn token breakdown. On codex,
  claude-code, and pi this comes from native `thread/tokenUsage/updated`
  events. On omp threads it comes from omp's own session store.
- **tok/s + TTFT** — omp per-model rolling aggregates (decode throughput,
  time-to-first-token) from `~/.omp/agent/agent.db` `model_perf`.
- **cost** — omp's per-response cost estimate (null when the provider reports
  zero cost).

## How the omp join works

bb passes each provider session a UUID that surfaces in the thread event log
as `providerThreadId`. omp names its session files
`~/.omp/agent/sessions/-<path>/<timestamp>_<sessionUuid>.jsonl` with the same
UUID. The plugin therefore maps a bb thread to its omp session file directly,
tails the last 2 MB for the newest assistant message record, and reads its
`usage` object. The `model_perf` row is keyed by the model ID recorded in the
same message.

No omp changes required. omp already emits a context-window figure over ACP
(`usage_update` → `thread/contextWindowUsage/updated`); the richer breakdown
is read locally from disk.

## CLI

```
bb usage-hud show <thread-id> [--json]
```

Prints the same payload the HUD renders: native token usage, context window,
and the omp enrichment block.

## Files

- `server.ts` — RPC (`usage_for_thread`) + `bb usage-hud` CLI. Reads bb
  thread events via `bb.sdk`; reads omp session store read-only.
- `app.tsx` — `experimental_appOverlay` component fixed to the bottom-left;
  follows the active split pane's thread; refreshes on
  `thread:changed` realtime events (debounced) plus a 15 s backstop poll.
