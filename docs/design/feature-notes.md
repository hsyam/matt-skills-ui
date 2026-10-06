# Matt Skills UI: a web UI over mattpocock/skills (working notes)

**Name:** `matt-skills-ui`. Plugin id, repo and slash command are all `matt-skills-ui` (`/matt-skills-ui`); the UI shows "Matt Skills UI".
- **Description:** "Unofficial web UI for mattpocock/skills: see your specs, tickets and wayfinder maps as a graph, with the next command for each."
- **Tags:** `mattpocock-skills`, `claude-code-plugin`, `claude-code`, `skills`
- **Unofficial:** the name reads as official, so the description and README must open with "Unofficial". Ask Matt before publishing (issue or DM); his yes removes the rename risk.
- **Availability (checked 2026-10-06):** free on npm; no GitHub repo has the name.

Throwaway notes that go with the UI prototype in this folder. Open `index.html?variant=A|B|C|D`.

## What the server has to read (the skills' on-disk contract)

Everything the UI shows comes from files and CLIs that the skills already write. Matt Skills UI adds no new state of its own except the session registry.

| Concept | Where it lives | Written by |
|---|---|---|
| Setup state | `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`, plus the `## Agent skills` block in `CLAUDE.md`/`AGENTS.md` | `/setup-matt-pocock-skills` |
| Tracker kind | the issue-tracker.md heading: GitHub (`gh`), GitLab (`glab`), Local (`.scratch/`), or free-form "Other" | setup |
| Spec | Local: `.scratch/<feature>/spec.md`. GitHub/GitLab: an issue labelled `ready-for-agent` | `/to-spec` |
| Tickets | Local: `.scratch/<feature>/issues/NN-slug.md` with `**Blocked by:**`, `**Status:**`, `- [ ]` criteria. GitHub: issues with native `blocked_by` dependencies, or a `## Blocked by` section | `/to-tickets` |
| Wayfinder map | Local: `.scratch/<effort>/map.md` (Destination / Notes / Decisions so far / Not yet specified / Out of scope). GitHub: an issue labelled `wayfinder:map` with sub-issues | `/wayfinder` |
| Decision tickets | `Type:` research/prototype/grilling/task, `Status:` claimed/resolved, `Blocked by: NN`; on GitHub a `wayfinder:<type>` label, and the assignee is the claim | `/wayfinder` |
| Triage state | label strings mapped via `triage-labels.md` (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix) plus bug/enhancement | `/triage` |
| Rejected requests | `.out-of-scope/<concept>.md` | `/triage` |
| Domain | `GLOSSARY.md` or `GLOSSARY-MAP.md`, `docs/adr/NNNN-*.md` | `/grill-with-docs`, `/domain-modeling` |
| Prototypes | `prototype/<name>` branches, with a pointer from the issue | `/prototype` |
| Research | `research/<name>` branches, or cited markdown in the repo | `/research` |
| Other artifacts | `$TMPDIR/architecture-review-*.html`, `$TMPDIR/handoff-*.md`, `to-questionnaire-*.md` | the matching skills |
| Integration work | integration branch + per-ticket worktrees | `/implement-spec` |

Derived rules the UI computes:
- **Frontier**: tickets that are open, unblocked (every blocker closed) and unclaimed.
- **HITL vs AFK**: research is AFK; prototype, grilling and HITL tasks need you.
- **Critical path**: the longest chain of open tickets.

## Next-move engine (one recommended command per item)

| Situation | Recommend |
|---|---|
| Setup files missing or stale | `/setup-matt-pocock-skills` |
| Spec has no tickets | `/to-tickets <spec>` |
| Spec with 2 or more frontier tickets | `/implement-spec <spec>` (parallel), or `/implement <ticket>` each |
| One frontier ticket | `/implement <ticket>`, or spawn a background implementer |
| Every ticket closed | `/code-review main`, then `/pr`, then `/retro` |
| Map frontier ticket (research) | spawn a research subagent (AFK) |
| Map frontier ticket (grilling/prototype/task) | `/wayfinder <map> <ticket>` (needs you) |
| Map with nothing open and no fog | `/to-spec <map>` |
| Issue unlabeled or needs-triage | `/triage <n>`; flag any `.out-of-scope` match |
| needs-info and the reporter replied | `/triage <n>` |
| ready-for-human | you, with the reason |
| Main session context over ~150k | phase-boundary advice (continue, clear, handoff, subagent, compact) |

## Feature list

**Asked for**
1. All specs, tickets, wayfinder maps, prototypes, research and artifacts in one place.
2. A dependency graph per spec or map: blocked edges, frontier glow, critical path.
3. Labels and states on every ticket and issue.
4. Skills setup health: what setup wrote, what is missing or stale, which skills are installed.
5. A next or recommended command on every ticket, spec, map and issue.
6. Spawning sessions and subagents, and sending messages to the main session.

**Proposed extras**
7. **Questions inbox.** Grilling and HITL questions from any running session show up as cards with the agent's recommended answer. You accept it in one click, or reply.
8. **Session dock.** Every session's context gauge against the ~150k smart zone, plus its current skill, worktree and live log.
9. **Phase-boundary advisor.** It turns ask-matt's PHASE-BOUNDARIES tree into a live suggestion.
10. **Flow rail.** Shows where each effort sits on grill, prototype, spec, tickets, implement, review, PR, retro, or on the wayfinder on-ramp.
11. **Wayfinder view.** Destination, a decisions-so-far trail, fog patches, out-of-scope, and the frontier.
12. **Triage buckets.** Unlabeled, needs-triage, and needs-info with reporter activity, with automatic `.out-of-scope` matching.
13. **Glossary hover.** Terms from `GLOSSARY.md` are underlined everywhere, which works like `/wait-what` without asking.
14. **Live.** File watcher plus `gh` polling pushed over server-sent events (SSE), so the board moves as agents edit `.scratch/` or close issues.
15. **Lint.** Blocked-by cycles, dangling references, two state roles on one issue, tickets without a Status line, and a map whose fog duplicates a ticket.
16. **Artifacts gallery.** Prototype and research branches, architecture reports, handoffs, questionnaires and ADRs, each linked to its ticket.
17. **Concurrency view for `/implement-spec`.** Frontier width, which worktree holds which ticket, and merge status.
18. **⌘K palette.** Jump to any ticket, or run any skill with arguments filled in from the current selection.
19. Later: write-back edits, such as dragging a card to change Status or drawing an edge to add Blocked by. This is risky because the markdown belongs to the skills, so read-only first.

## Architecture sketch (for after a design is picked)

- `/matt-skills-ui` is a user-invoked skill. It starts `node server.mjs` in the background on a free port and prints the URL. It also starts a `Monitor` on the server's outbox, so UI messages reach the main session as events.
- **Read side:** adapters for local `.scratch`, `gh` and `glab`, all normalized into one `{efforts, tickets, issues, setup, artifacts}` model, served as `/api/state` plus SSE.
- **Spawn:** `claude --bg --name "<title>" "<prompt with context pointers>"`, like the claude-handoff skill does. Worktrees are created for implementers. Sessions are tracked in `.matt-skills-ui/sessions.json` (gitignored).
- **Talk to main:** the UI POSTs to `/api/inbox`, the server appends a line to an outbox file, and the main session's Monitor surfaces it. Questions go the other way: the main session writes `.matt-skills-ui/questions.jsonl` and the UI renders the cards.
- No build step: a single HTML file plus vanilla JS, matching the prototype.

## Themes (all four ship; user picks)

Swiss, Terminal, Transit and Toybox all share the same features. Each theme is a set of CSS variables, a layout grid, and a node/edge drawer for the chart.

- **At install:** `plugin.json` declares a `userConfig.theme` option with `options: ["swiss","terminal","transit","toybox"]`. Claude Code asks for it when the plugin is enabled and stores it in `settings.json` under `pluginConfigs`. The skill reads it as `${user_config.theme}` and passes it to the server.
- **Change anytime:**
  - The in-app picker (◐ in the header) saves an override, which persists across updates.
  - `/matt-skills-ui theme <name>` does the same from the terminal.
  - `/config` changes the install default.
- **Precedence:** `/matt-skills-ui theme` argument or URL `?theme=`, then the saved override, then `userConfig`, then `swiss`. "Use default" clears the override.
- **Where the override lives:** Docs say `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) survives updates, but only document it for MCP, hook and LSP config. To verify while building: whether a skill body expands it. Otherwise the server resolves the path itself.
