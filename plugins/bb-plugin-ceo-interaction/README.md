# bb-plugin-ceo-interaction

A headless instructional BB plugin. It adds no UI, CLI, storage, or services —
its entire surface is a single agent skill, `ceo-interaction`, that BB injects
into agent threads.

The skill encodes how an agent works with its user as a CEO:

- **Steering** — agent output is a best-effort proposal; the CEO's corrections
  are ground truth, applied immediately.
- **Ask-or-act rule** — a four-condition test for when CEO input genuinely
  changes the outcome versus when to act and note the default taken.
- **Right questions** — one decision per question, recommended default
  attached, related questions batched, batch capped at five, prioritized.
- **Kickoff interviews** — when intent is ambiguous or a new project/thread
  starts, batch questions grouped by theme, defaults attached, one follow-up
  round, then write the understood intent back before starting.
- **Conclusion-first reports** — outcome in the first sentence; then decisions
  made and why, changes, risks and blockers, next step.

## Layout

- `server.ts` — minimal required backend entry; registers nothing.
- `skills/ceo-interaction/SKILL.md` — the skill content. BB imports every
  `skills/<name>/SKILL.md` into agent threads as the plugin skills tier.

## Install

```
npm install
bb plugin install .
```

After editing the skill, reload:

```
bb plugin reload ceo-interaction
```
