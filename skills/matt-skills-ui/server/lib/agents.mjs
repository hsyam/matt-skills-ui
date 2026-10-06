// Agent CLIs the board can spawn. Each adapter knows how to start one turn, how to resume the
// session for the next turn, and how to read its JSON output. Parsers turn every CLI's own event
// stream into a few normalized events that Sessions understands:
//   { k: 'init', sessionId?, model? }   { k: 'text', t }   { k: 'tool', t }   { k: 'ctx', ctx }
//   { k: 'end', text?, cost?, turns?, isError? }
// Two styles:
//   persistent: one process for the whole conversation, replies go to its stdin (Claude).
//   per-turn:   one process per turn, the next turn resumes the session by id (everyone else).
// `tested: false` marks adapters written from the CLI's docs that haven't run against the real CLI.
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export const summarizeTool = (name, input = {}) => {
  const v = input.command || input.file_path || input.filePath || input.path || input.pattern || input.url || input.description || input.skill || input.prompt || '';
  return `${name}${v ? ': ' + String(Array.isArray(v) ? v.join(' ') : v).replace(/\s+/g, ' ').slice(0, 140) : ''}`;
};
const kTokens = n => n ? Math.round(n / 1000) : null;
const json = line => { try { return JSON.parse(line); } catch { return null; } };

const claude = {
  id: 'claude', label: 'Claude Code', bin: 'claude', persistent: true, tested: true,
  modes: ['default', 'acceptEdits', 'auto', 'plan'], defaultMode: 'acceptEdits',
  modeHelp: '<b>acceptEdits</b> lets it edit files; <b>auto</b> lets Claude decide; <b>plan</b> is read-only.',
  args: ({ mode, model, sessionId, system }) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--permission-mode', mode, '--append-system-prompt', system, ...(model ? ['--model', model] : [])],
  message: text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n',
  resumeHint: s => `claude --resume ${s.sessionId}`,
  parser: () => line => {
    const e = json(line); if (!e) return [];
    if (e.type === 'system' && e.subtype === 'init') return [{ k: 'init', model: e.model }];
    if (e.type === 'assistant') {
      const u = e.message?.usage, out = u ? [{ k: 'ctx', ctx: kTokens((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) }] : [];
      for (const p of e.message?.content || []) {
        if (p.type === 'text' && p.text.trim()) out.push({ k: 'text', t: p.text.trim() });
        else if (p.type === 'tool_use') out.push({ k: 'tool', t: summarizeTool(p.name, p.input) });
      }
      return out;
    }
    if (e.type === 'result') return [{ k: 'end', text: e.result, cost: e.total_cost_usd, turns: e.num_turns, isError: e.is_error ? (e.result || e.subtype) : null }];
    return [];
  },
};

// opencode run --format json: step_start / text / tool_use / step_finish lines, all carrying sessionID.
const opencode = {
  id: 'opencode', label: 'OpenCode', bin: 'opencode', tested: true,
  modes: ['build', 'auto', 'plan'], defaultMode: 'build',
  modeHelp: '<b>build</b> follows your OpenCode permission config; <b>auto</b> approves anything not explicitly denied; <b>plan</b> uses the read-only plan agent.',
  args: ({ mode, model, resume, prompt }) => ['run', '--format', 'json', ...(mode === 'auto' ? ['--auto'] : mode === 'plan' ? ['--agent', 'plan'] : []), ...(model ? ['-m', model] : []), ...(resume ? ['-s', resume] : []), '--', prompt],
  resumeHint: s => `opencode -s ${s.sessionId}`,
  // Headless runs auto-reject anything the config says to "ask" about, and only say so on stderr.
  stderr: line => { const m = line.match(/permission requested: (.+?); auto-rejecting/); return m ? { k: 'error', t: `OpenCode denied ${m[1]}. Use the auto mode, or allow it in your OpenCode permission config.` } : null; },
  parser: () => line => {
    const e = json(line); if (!e) return [];
    const out = e.sessionID ? [{ k: 'init', sessionId: e.sessionID }] : [], p = e.part || {};
    if (e.type === 'text' && p.text?.trim()) out.push({ k: 'text', t: p.text.trim() });
    else if (e.type === 'tool_use') out.push({ k: 'tool', t: summarizeTool(p.tool || 'tool', p.state?.input) });
    else if (e.type === 'step_finish' && p.tokens) out.push({ k: 'ctx', ctx: kTokens((p.tokens.input || 0) + (p.tokens.cache?.read || 0) + (p.tokens.cache?.write || 0)), cost: p.cost });
    else if (e.type === 'error') out.push({ k: 'error', t: e.error?.data?.message || e.error?.message || JSON.stringify(e.error || e).slice(0, 300) });
    return out;
  },
};

// codex exec --json: thread.started / item.started|completed / turn.completed. The prompt rides stdin ("-").
// Codex's usage is summed over the turn's model calls, so it isn't a context size; the gauge stays empty.
const codex = {
  id: 'codex', label: 'Codex', bin: 'codex', tested: true, stdinPrompt: true,
  modes: ['workspace-write', 'read-only', 'full-access'], defaultMode: 'workspace-write',
  modeHelp: '<b>workspace-write</b> edits files in the repo (no network); <b>read-only</b> can only look; <b>full-access</b> drops the sandbox.',
  args: ({ mode, model, resume }) => ['exec', ...(resume ? ['resume', resume] : []), '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${mode === 'full-access' ? 'danger-full-access' : mode === 'read-only' ? 'read-only' : 'workspace-write'}"`, ...(model ? ['-m', model] : []), '-'],
  resumeHint: s => `codex resume ${s.sessionId}`,
  parser: () => line => {
    const e = json(line); if (!e) return [];
    if (e.type === 'thread.started') return [{ k: 'init', sessionId: e.thread_id }];
    const it = e.item || {};
    if (e.type === 'item.completed' && it.type === 'agent_message' && it.text?.trim()) return [{ k: 'text', t: it.text.trim() }];
    if (e.type === 'item.started' && it.type === 'command_execution') return [{ k: 'tool', t: summarizeTool('shell', { command: String(it.command || '').replace(/^\S*sh -lc /, '') }) }];
    if (e.type === 'item.completed' && it.type === 'file_change') return [{ k: 'tool', t: summarizeTool('edit', { path: (it.changes || []).map(c => c.path).join(', ') }) }];
    if (e.type === 'item.started' && it.type === 'mcp_tool_call') return [{ k: 'tool', t: `${it.server || 'mcp'}.${it.tool || ''}` }];
    if (e.type === 'turn.failed' || e.type === 'error') return [{ k: 'error', t: e.error?.message || e.message || 'error' }];
    return [];
  },
};

// cursor-agent --print --output-format stream-json: Claude-like system/assistant/tool_call/result events.
const cursor = {
  id: 'cursor', label: 'Cursor', bin: 'cursor-agent', tested: false, stdinPrompt: true,
  modes: ['default', 'force', 'plan'], defaultMode: 'force',
  modeHelp: '<b>force</b> runs commands without asking; <b>default</b> follows your Cursor allowlist; <b>plan</b> is read-only.',
  args: ({ mode, model, resume }) => ['--print', '--output-format', 'stream-json', '--trust', ...(mode === 'plan' ? ['--mode', 'plan'] : mode === 'force' ? ['--force'] : []), ...(model ? ['--model', model] : []), ...(resume ? ['--resume', resume] : [])],
  resumeHint: s => `cursor-agent --resume ${s.sessionId}`,
  parser: () => line => {
    const e = json(line); if (!e) return [];
    const out = e.session_id ? [{ k: 'init', sessionId: e.session_id, model: e.type === 'system' ? e.model : undefined }] : [];
    if (e.type === 'assistant') for (const p of e.message?.content || []) { if (p.type === 'text' && p.text.trim()) out.push({ k: 'text', t: p.text.trim() }); }
    else if (e.type === 'tool_call' && e.subtype === 'started') {
      const [name, call] = Object.entries(e.tool_call || {})[0] || ['tool', {}];
      out.push({ k: 'tool', t: summarizeTool(name.replace(/ToolCall$/, ''), call?.args) });
    } else if (e.type === 'result') out.push({ k: 'end', text: e.result, isError: e.is_error ? (e.result || 'error') : null });
    return out;
  },
};

// gemini -p --output-format stream-json: init / message (assistant deltas) / tool_use / result.
const gemini = {
  id: 'gemini', label: 'Gemini CLI', bin: 'gemini', tested: false,
  modes: ['auto_edit', 'default', 'yolo'], defaultMode: 'auto_edit',
  modeHelp: '<b>auto_edit</b> approves file edits; <b>default</b> denies anything that needs approval; <b>yolo</b> approves everything.',
  args: ({ mode, model, resume, prompt }) => ['--output-format', 'stream-json', '--approval-mode', mode, ...(model ? ['-m', model] : []), ...(resume ? ['--resume', resume] : []), '-p', prompt],
  resumeHint: s => `gemini --resume ${s.sessionId}`,
  parser: () => {
    let buf = '';
    const flush = () => { const t = buf.trim(); buf = ''; return t ? [{ k: 'text', t }] : []; };
    return line => {
      const e = json(line); if (!e) return [];
      if (e.type === 'init') return [{ k: 'init', sessionId: e.session_id, model: e.model }];
      if (e.type === 'message' && e.role === 'assistant') { buf += e.content || ''; if (!e.delta) return flush(); return []; }
      if (e.type === 'tool_use') return [...flush(), { k: 'tool', t: summarizeTool(e.tool_name || 'tool', e.parameters) }];
      if (e.type === 'error') return [...flush(), { k: 'error', t: e.message || 'error' }];
      if (e.type === 'result') return [...flush(), { k: 'end', isError: e.status && e.status !== 'success' ? (e.error?.message || e.status) : null }];
      return [];
    };
  },
};

// pi -p --mode json: agent events; message_end carries each finished assistant message. Pi has no
// permission system, so there is one mode. The session is a file we choose, which makes resuming trivial.
const pi = {
  id: 'pi', label: 'Pi', bin: 'pi', tested: false,
  modes: ['full'], defaultMode: 'full',
  modeHelp: 'Pi has no permission prompts: it can run any command and edit any file.',
  args: ({ model, sessionFile, prompt }) => ['-p', '--mode', 'json', '--session', sessionFile, ...(model ? ['--model', model] : []), prompt],
  resumeHint: s => `pi --session ${s.sessionFile}`,
  parser: () => line => {
    const e = json(line); if (!e) return [];
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      const m = e.message, u = m.usage, out = [];
      for (const p of m.content || []) {
        if (p.type === 'text' && p.text?.trim()) out.push({ k: 'text', t: p.text.trim() });
        else if (p.type === 'toolCall') out.push({ k: 'tool', t: summarizeTool(p.name, p.arguments) });
      }
      if (u) out.push({ k: 'ctx', ctx: kTokens((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)), cost: u.cost?.total });
      if (m.model) out.unshift({ k: 'init', model: m.model });
      if (m.stopReason === 'error') out.push({ k: 'error', t: m.errorMessage || 'error' });
      return out;
    }
    return [];
  },
};

export const AGENTS = { claude, opencode, codex, cursor, gemini, pi };

/** The binary for an agent: $MATT_SKILLS_UI_<ID>_BIN overrides it ($MATT_SKILLS_UI_CLAUDE still works). */
export function agentBin(a) {
  const env = process.env[`MATT_SKILLS_UI_${a.id.toUpperCase()}_BIN`] || (a.id === 'claude' ? process.env.MATT_SKILLS_UI_CLAUDE : null);
  return env || a.bin;
}

/** Find a command on PATH (or accept an absolute path) without running it. */
export function which(cmd) {
  if (path.isAbsolute(cmd)) { try { accessSync(cmd, constants.X_OK); return cmd; } catch { return null; } }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const ext of exts) {
    const p = path.join(dir, cmd + ext);
    try { accessSync(p, constants.X_OK); return p; } catch {}
  }
  return null;
}

let cache = null;
/** What the spawn dialog offers: every adapter, and whether its CLI is on PATH. Re-checked every minute. */
export function agentList() {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const list = Object.values(AGENTS).map(a => ({ id: a.id, label: a.label, bin: agentBin(a), installed: !!which(agentBin(a)), tested: a.tested, modes: a.modes, defaultMode: a.defaultMode, modeHelp: a.modeHelp }));
  cache = { at: Date.now(), list }; return list;
}
