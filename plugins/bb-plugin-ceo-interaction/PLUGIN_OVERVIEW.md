Give agents a working contract for collaborating with a CEO: steer with
proposals, escalate only real decisions, interview when intent is unclear, and
report conclusions first.

## What you get

One skill, `ceo-interaction`, injected into every agent thread. It turns
"how should the agent behave with me?" into explicit, checkable rules instead of
luck.

## The five behaviors

- **CEO steers.** Agent input is a best-effort proposal. Corrections are ground
  truth, applied immediately without relitigating. New facts can reopen a
  decision — stated plainly, then re-decided.
- **Ask or act.** Escalate only when input changes the outcome: irreversible or
  expensive steps, materially ambiguous intent, facts only the CEO holds, or a
  conflict with an explicit steer. Everything else: act, then note the choice.
- **Right questions.** One decision per question, minimal deciding context, a
  recommended default so "yes" works, related questions batched and capped at
  five.
- **Kickoff interviews.** New project or ambiguous intent: batched questions
  grouped by theme, prioritized, defaults attached, one focused follow-up
  round, understood intent written back before work starts.
- **Conclusion-first reports.** Outcome in sentence one; then decisions and
  reasons, changes, risks and blockers, next step. Bad news up front.

## How it works

The plugin is headless: `server.ts` is the minimal required entry and the
plugin registers no RPC, CLI, or UI. BB imports `skills/ceo-interaction/
SKILL.md` into agent threads as the plugin skills tier.
