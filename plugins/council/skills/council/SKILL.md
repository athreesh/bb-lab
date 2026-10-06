---
name: council
description: Launch the user's four-model council (GLM/OMP chief, Codex, Claude Code, DeepSeek/OMP) to deliberate a question. Use for /council or an explicit request to convene these agents. For an assigned seat or a message from an existing Council room, use council-seat instead.
---

# Launch the council

Invoking `/council <question>` requests a real four-agent debate through the
Council plugin. Launch it; do not simulate the seats in your own reply.

Use the question supplied with the invocation. For `/council` alone, use the
clear current decision/problem from the conversation. If none is clear, ask
what the council should discuss before starting agents. Explain-only questions
about `/council`, requests to edit this skill/plugin, and messages assigning you
a council seat do not request a launch.

## Launch

1. Write the question to a temporary UTF-8 text file. Include enough relevant
   conversation context, constraints, and file paths for independent agents;
   seats do not inherit this conversation. Keep the user's question and scope.
2. Run the bundled launcher (resolve its path relative to this SKILL.md):

   ```sh
   python3 <skill-directory>/scripts/launch.py --question-file <question-file>
   ```

   It uses `BB_PROJECT_ID` and `BB_ENVIRONMENT_ID` to put all four seats in this
   thread's workspace. If either is missing, obtain the intended project and
   environment from `bb status --json` or `bb thread show --self --json` and
   pass `--project <id> --environment <id>`. Do not guess a different checkout.
   Optional `--title <short-title>` and `--turns <2-40>` override the derived
   title and eight-turn default.
3. Check the returned council and `failures`. Report the council title/ID,
   GLM as chief, and that the debate is running in the **Council** panel.
   If failures are nonempty, say which seats failed to start. Do not report
   all four as running or automatically launch a duplicate council.

The preset is GLM 5.3 Flash (`webster/glm-5.3-flash`) on OMP as chief,
Codex with its current default model, Claude Code with its current default
model, and DeepSeek v4 Flash (`webster/deepseek-v4-flash`) on OMP. The server
resolves and saves the default models at launch and checks availability in the
selected workspace. It does not silently substitute models or omit seats.
GLM and DeepSeek retain the preset's permission to edit when the question calls
for changes; Codex and Claude are read-only.

## Follow-up

Use `bb council show <id>` for the transcript and `bb council say <id> <message>`
for a requested follow-up or an answer to a seat's question. `bb council halt
<id>` stops the council. To inspect structured state, call `councils_get` with
`{"councilId":"<id>"}` using `bb plugin rpc call council councils_get
--input-file <json-file> --json`.

If the launch command loses its connection, inspect `bb council list` and the
matching council before retrying: a council may already have started. Do not
claim a verdict is ready merely because its status is `verdict`; that status
also covers the chief still writing. If the user asks you to bring back the
result, wait for the chief's final reply and summarize it with unresolved
points. Never fabricate a seat's reply or the chief's verdict.
