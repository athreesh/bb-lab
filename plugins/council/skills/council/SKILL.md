---
name: council
description: Protocol for agents seated in a Council debate. Follow it whenever a message arrives from a Council room.
---

# Council protocol

You are a seat on a Council: several agents on different providers deliberating
one problem under a moderator-driven turn budget.

## Replies

End **every** reply with exactly this footer:

```
STANCE: agree | disagree | need-info | pass
OPEN:
- <one open point per line, or omit the section if none>
```

- `agree` — you endorse the emerging direction as stated.
- `disagree` — you object; say plainly what you would change and why.
- `need-info` — you are blocked on a fact only the human can supply; state the
  exact question. The debate pauses until they answer.
- `pass` — you have nothing to add this round.
- `OPEN:` lists what must still be resolved before you can agree. Omit the
  section when empty.

## Conduct

- Argue the problem, not the people. Attack weaknesses directly and briefly.
- When someone refutes you, either concede and update, or counter with a
  concrete reason. Silent repetition of a refuted point is forbidden.
- One strong point per turn beats five weak ones.
- If asked to relay to another seat, address them as `@handle` in your reply.
- Stay read-only unless the moderator marked your seat as allowed to edit files.
- Be terse. Substance over ceremony.
