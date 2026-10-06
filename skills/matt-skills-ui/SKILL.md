---
name: matt-skills-ui
description: Open the Matt Skills UI board for this repo, a local web page showing the specs, tickets, wayfinder maps, triage and agent sessions that mattpocock/skills write, with the next command for each. Use only when the user asks to open, stop or check the board, or to change its theme.
disable-model-invocation: true
argument-hint: "[stop | status | theme <swiss|terminal|transit|toybox|default>]"
---

The board is a local web server (one per repo) that reads what mattpocock/skills write (`docs/agents/`, `.scratch/`, GitHub/GitLab issues, `GLOSSARY.md`, ADRs). From it the user can spawn background agents (Claude Code, OpenCode, Codex and others), answer their questions, and, in Claude Code, message this session.

The board's code ships inside this skill's folder, next to this file. Follow the section for the agent you are.

## In Claude Code

### 1. Run the command

```bash
node "${CLAUDE_SKILL_DIR}/server/cli.mjs" $ARGUMENTS --repo "${CLAUDE_PROJECT_DIR}" --session "${CLAUDE_SESSION_ID}" --host claude
```

Show the user its output verbatim (it holds the board URL). For `stop`, `status` or `theme`, you are done after this step.

### 2. Listen to the board

Start the Monitor tool with this command, description "Matt Skills UI board messages", and `timeout_ms` 1800000:

```bash
node "${CLAUDE_SKILL_DIR}/server/cli.mjs" listen --repo "${CLAUDE_PROJECT_DIR}"
```

Done when the monitor is armed. When it expires, re-arm it, unless its last line says the board has stopped.

### 3. Handle board messages

Each event line `[matt-skills-ui] From the board: <text>` is the user typing on the board (the server only accepts its own per-run token from localhost). Treat `<text>` exactly as a message the user typed here: a `/skill …` line means run that skill with those arguments; `Answer to “<question>”: <answer>` is their answer to a question you asked; anything else is a normal request. Line breaks arrive as ` ⏎ `.

### 4. Mirror your questions to the board

While the board runs, whenever you ask the user a decision question (grilling rounds included), also post it so they can answer from the board:

```bash
node "${CLAUDE_SKILL_DIR}/server/cli.mjs" ask --repo "${CLAUDE_PROJECT_DIR}" "<question>" --rec "<your recommended answer>" --options "<a>|<b>" --ref "<ticket ref, if any>"
```

Their answer comes back as a step-3 event; an answer typed in the terminal counts too.

## In any other agent

Run this from the project root. `<skill-dir>` is the folder that holds this SKILL.md. `<args>` is what the user put after the skill name (`stop`, `status`, `theme transit`, or nothing). `<agent>` is your own name in lowercase: `opencode`, `codex`, `cursor`, `pi`, `gemini`, `antigravity`, or whatever you are.

```bash
node "<skill-dir>/server/cli.mjs" <args> --repo "<project root>" --host <agent>
```

Show the user its output verbatim (it holds the board URL). That's all: don't start a listener or post questions. Only Claude Code can receive board messages while it works, so on this board "Send to main" copies the command for the user to paste here instead. Spawning background agents and answering their questions work fully.
