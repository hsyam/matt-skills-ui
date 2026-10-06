---
name: run-matt-skills-ui
description: Run, test, screenshot or smoke-test the matt-skills-ui plugin (the web board for mattpocock/skills). Use to start the board server, check a change works in the real UI, or take screenshots of its four themes.
---

matt-skills-ui is a Claude Code plugin: a zero-dependency Node server (`server/`) plus a static web app (`web/`). Drive it with `driver.mjs` in this folder: it copies `test/fixtures/acme-local` (a repo in the exact formats mattpocock/skills writes) to a temp dir, starts the real server there, and talks to it over HTTP and the CLI. Paths below are relative to the plugin root (`matt-skills-ui/`).

## Prerequisites

Node ≥ 20 (tested on 24). No `npm install`. Screenshots use Playwright's `chrome-headless-shell` from `~/Library/Caches/ms-playwright` (or `~/.cache/ms-playwright`), falling back to Chrome; set `MSU_CHROME=<binary>` to override. `spawn` needs the `claude` CLI logged in.

## Run (agent path)

```bash
node .claude/skills/run-matt-skills-ui/driver.mjs smoke            # 13 API + CLI checks, ~10 s, free
node .claude/skills/run-matt-skills-ui/driver.mjs smoke --shots    # + one PNG per theme in $TMPDIR/matt-skills-ui-shots/
node .claude/skills/run-matt-skills-ui/driver.mjs spawn            # + a real headless claude agent (haiku, plan mode, ~$0.10)
node .claude/skills/run-matt-skills-ui/driver.mjs spawn --agent opencode   # same through opencode | codex | cursor | gemini | pi, read-only mode
node .claude/skills/run-matt-skills-ui/driver.mjs up               # start a board on a fresh fixture copy; prints the URL
node .claude/skills/run-matt-skills-ui/driver.mjs shot "<url>" out.png --theme transit --size 1440,900
node .claude/skills/run-matt-skills-ui/driver.mjs down             # stop every board the driver started
```

Each check prints `PASS`/`FAIL`; exit code is non-zero on any failure. Read the PNGs with the Read tool to look at them. For clicking through the UI, open the `up` URL in the in-app browser (Claude_Browser tools) or Playwright MCP; `?theme=swiss|terminal|transit|toybox` forces a theme without saving it.

Driver state lives in `$TMPDIR/matt-skills-ui-driver` (`MATT_SKILLS_UI_HOME`), never in `~/.matt-skills-ui`.

## Direct invocation

Most changes touch the readers or the next-move engine; test those without a server:

```bash
npm test                                                           # node --test test/*.test.mjs
node -e "import('./skills/matt-skills-ui/server/lib/model.mjs').then(async m => console.log(JSON.stringify(await m.buildModel('test/fixtures/acme-local'), null, 1)))"
```

`skills/matt-skills-ui/web/engine.mjs` is plain ESM shared by the browser and node: import it, `bind(state)`, call `nextFor` / `effortNext` / `stateOf`.

## Run (human path)

Load the plugin into a session and run its command in the repo you want to see:

```bash
claude --plugin-dir /path/to/matt-skills-ui
```

Then `/matt-skills-ui` (opens the browser), `/matt-skills-ui theme toybox`, `/matt-skills-ui stop`. Check manifests with `npm run validate`.

## Gotchas

- **Full Chrome `--headless` hangs** inside Claude Code's sandboxed Bash, even on `data:` URLs. `chrome-headless-shell` works. The driver prefers it.
- **`--virtual-time-budget` hangs** because the page holds an SSE connection open. Instead the server inlines the first state into `index.html` (`window.__STATE__`) when the URL carries the token, so the board paints before `load`. The driver uses `--timeout` plus `--force-prefers-reduced-motion`, which stops the load animation from showing up as a blank screenshot.
- **There's no `timeout` command on macOS.** To bound a process use `perl -e 'alarm 30; exec @ARGV' …`.
- `node --test test/` fails on Node 24 because the directory is treated as a module. Use the glob (`npm test`).
- **Skill bodies substitute** `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}` and `$ARGUMENTS`. They do not substitute `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` or `${user_config.*}`. So the theme picked at install is read from `pluginConfigs` in `~/.claude/settings.json` (`server/lib/config.mjs`), and data lives in `~/.matt-skills-ui`.
- **Spawned agents** go through the adapters in `skills/matt-skills-ui/server/lib/agents.mjs`. Claude runs `claude -p --input-format stream-json --output-format stream-json --verbose`. `--verbose` is required with stream-json. Each `result` event ends a turn, and the process stays alive waiting on stdin, which is how board replies continue the conversation. Every other agent runs one process per turn, and the next turn resumes the session id from the first turn's output. Their parser tests replay real CLI output from `test/fixtures/agents/`.
- **Spawned agents get `PWD` set to their working directory, and the preamble names the realpath.** The server's own `PWD` leaks otherwise, and OpenCode takes its project root from `PWD`. It then auto-rejects reads of the real repo as `external_directory`, and the turn ends silently (the rejection only shows on stderr). macOS's `/var` → `/private/var` symlink causes the same rejection.
- **`codex exec` reads stdin when it's piped**, so the adapter sends the prompt there (`-`). `opencode run` takes it after `--`, so a prompt starting with `-` isn't read as a flag.
- **Headless agents can't ask for permission.** Anything the settings don't allow is denied, so pick `acceptEdits`/`auto` for implementers.
- **Worktree spawns** land in `<data>/repos/<hash>/worktrees/<id>` on a branch `msu/<id>`. They are not cleaned up automatically.
- **The main session's context gauge** reads the last `usage` in `~/.claude/projects/<slug>/<session>.jsonl`. That's an internal format, so it's best-effort and shows "—" if the format changes.
- **`fs.watch` recursive** fires for `.git/` churn too. The server filters to the paths the skills write.

## Troubleshooting

- `FAIL listen: …` means a listener from an older run is consuming the outbox. Run `driver.mjs down` and retry; delivery is tracked server-side, so only one listener gets each message.
- `SKIP screenshot` or `screenshot failed`: no headless shell was found. Install one with `npx playwright install chromium-headless-shell`, or set `MSU_CHROME`.
- Board shows "Can’t reach the board server": the server died. Read `<MATT_SKILLS_UI_HOME>/repos/<hash>/server.log`.
