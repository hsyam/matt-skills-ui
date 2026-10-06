// Sessions the board knows about:
//  - "main": the agent session that ran /matt-skills-ui. We can't type into it; messages go to an
//    outbox that a Claude Code Monitor (cli.mjs listen) streams in. Other hosts have no such tool,
//    so for them the board copies commands instead of sending. Claude's context is read
//    best-effort from its transcript (~/.claude/projects/<slug>/<id>.jsonl, an internal format).
//  - spawned: headless agent CLIs (Claude Code, OpenCode, Codex, Cursor, Gemini, Pi; see agents.mjs).
//    Claude stays alive and takes replies on stdin; the others run one process per turn and the
//    next turn resumes the session by id. Either way the board shows the log live.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, openSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, readJson, writeJson, exists } from './util.mjs';
import { AGENTS, agentBin } from './agents.mjs';

const HOSTS = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex', cursor: 'Cursor', pi: 'Pi', gemini: 'Gemini CLI', antigravity: 'Antigravity', amp: 'Amp', copilot: 'GitHub Copilot' };

export function preamble(repo, cliPath, { skills = false } = {}) {
  return [
    `You were started from Matt Skills UI, a local web board for the repo at ${repo}. The user reads your messages on the board, not in a terminal, so keep them short and plain.`,
    `When you need a decision from the user, end your turn with exactly these lines (OPTIONS is optional):`,
    `QUESTION: <one question>`,
    `RECOMMENDED: <your recommended answer, one sentence>`,
    `OPTIONS: <option a> | <option b>`,
    `Ask one question per turn; the user's reply arrives as your next message. When the work is finished, end with one line starting with "DONE:" that says what changed.`,
    ...(skills ? ['A task that starts with /<name> names an agent skill: load that skill (its SKILL.md) and follow it with the rest of the line as its arguments.'] : []),
  ].join('\n');
}

/** Parse a QUESTION/RECOMMENDED/OPTIONS block, or a trailing question, from a turn's final text. */
export function parseQuestion(text) {
  if (!text) return null;
  const q = text.match(/^\s*QUESTION:\s*(.+)$/im);
  if (q) {
    const rec = (text.match(/^\s*RECOMMENDED:\s*(.+)$/im) || [])[1] || '';
    const opts = ((text.match(/^\s*OPTIONS:\s*(.+)$/im) || [])[1] || '').split('|').map(s => s.trim()).filter(Boolean);
    return { q: q[1].trim(), rec: rec.trim(), opts };
  }
  const last = text.trim().split(/\n\s*\n/).pop().trim();
  if (/\?\s*$/.test(last) && !/^\s*DONE:/im.test(text)) return { q: last.length > 400 ? last.slice(-400) : last, rec: '', opts: [] };
  return null;
}

const ctxOf = u => u ? Math.round(((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) / 1000) : null;

/** Last assistant usage in a transcript, read from the tail only. */
export function transcriptContext(file) {
  try {
    const size = statSync(file).size, len = Math.min(size, 400_000), buf = Buffer.alloc(len);
    const fd = openSync(file, 'r'); readSync(fd, buf, 0, len, size - len); closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) { if (!l.includes('"usage"')) continue; try { const e = JSON.parse(l); if (e.type === 'assistant' && e.message?.usage) return { ctx: ctxOf(e.message.usage), at: e.timestamp }; } catch {} }
  } catch {}
  return null;
}
export const projectSlug = dir => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');

export class Sessions {
  constructor({ repo, dataDir, cliPath, onChange }) {
    this.repo = repo; this.dataDir = dataDir; this.cliPath = cliPath; this.onChange = onChange;
    this.list = []; this.procs = new Map(); this.questions = []; this.outbox = []; this.seq = 0; this.delivered = 0; this.waiters = new Set();
    this.main = { id: 'main', name: 'Main session', kind: 'main', st: 'unknown', ctx: null, doing: '', sessionId: null, lastListen: 0, log: [] };
    this.file = path.join(dataDir, 'sessions.json');
  }
  async load() {
    const saved = await readJson(this.file, {});
    // Per-turn agents survive a board restart: their next turn just resumes the session by id.
    const live = s => ['running', 'waiting', 'starting'].includes(s.st), perTurn = s => !AGENTS[s.agent || 'claude']?.persistent && (s.sessionId || s.sessionFile);
    this.list = (saved.sessions || []).map(s => !live(s) ? s : perTurn(s) ? { ...s, st: 'waiting', doing: s.st === 'waiting' ? s.doing : 'The board restarted mid-turn; reply to continue', queue: [] } : { ...s, st: 'ended' });
    this.questions = (saved.questions || []).filter(q => q.from === 'main' || this.list.some(s => s.id === q.from && s.st === 'waiting'));
    this.outbox = saved.outbox || []; this.seq = saved.seq || 0; this.delivered = saved.delivered ?? this.seq;
    if (saved.mainSessionId) this.main.sessionId = saved.mainSessionId;
    if (saved.mainHost) this.main.host = saved.mainHost;
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => writeJson(this.file, { sessions: this.list.map(s => ({ ...s, log: s.log.slice(-200) })), questions: this.questions, outbox: this.outbox.slice(-100), seq: this.seq, delivered: this.delivered, mainSessionId: this.main.sessionId, mainHost: this.main.host }).catch(() => {}), 300);
  }
  changed() { this.save(); this.onChange?.(); }
  setMain(sessionId, host) {
    const real = v => v && typeof v === 'string' && !v.includes('$') && !v.includes('<');
    if (real(host)) this.main.host = host.toLowerCase();
    if (real(sessionId)) { this.main.sessionId = sessionId; if (!real(host)) this.main.host = 'claude'; }
    if (real(host) || real(sessionId)) this.changed();
  }
  refreshMain() {
    const dir = path.join(os.homedir(), '.claude/projects', projectSlug(this.repo));
    const f = this.main.sessionId ? path.join(dir, this.main.sessionId + '.jsonl') : null;
    const r = f ? transcriptContext(f) : null;
    if (r) this.main.ctx = r.ctx;
    const listening = Date.now() - this.main.lastListen < 90_000;
    const waitingQ = this.questions.some(q => q.from === 'main');
    // A Claude session can always be sent to: the outbox waits for its listener to reconnect.
    const host = this.main.host || (this.main.sessionId ? 'claude' : null);
    this.main.hostLabel = HOSTS[host] || host;
    this.main.canReceive = host === 'claude' || listening;
    if (this.main.canReceive) {
      this.main.st = waitingQ ? 'waiting' : listening ? 'listening' : 'offline';
      this.main.doing = listening ? 'Receiving board messages via Monitor' : 'Not listening: run /matt-skills-ui again to reconnect';
    } else {
      this.main.st = waitingQ ? 'waiting' : 'unknown';
      this.main.doing = `${host ? this.main.hostLabel : 'Opened from a terminal'}: can't receive board messages, so Send copies instead`;
    }
  }
  all() { this.refreshMain(); return [this.main, ...this.list]; }

  // ---------- outbox to the main session (consumed by `cli.mjs listen`) ----------
  pushOutbox(text) {
    const m = { seq: ++this.seq, at: new Date().toISOString(), text };
    this.outbox.push(m); this.main.log.push({ w: 'me', t: text });
    for (const w of this.waiters) w(); this.waiters.clear(); this.changed(); return m;
  }
  /** Long-poll for undelivered messages. Delivery is tracked server-side so a re-armed listener never repeats one. */
  async waitOutbox(ms = 25000) {
    this.main.lastListen = Date.now();
    const pending = () => this.outbox.filter(m => m.seq > (this.delivered || 0));
    if (!pending().length && ms) await new Promise(res => { const t = setTimeout(res, ms); this.waiters.add(() => { clearTimeout(t); res(); }); });
    this.main.lastListen = Date.now();
    const out = pending(); if (out.length) { this.delivered = out[out.length - 1].seq; this.save(); }
    return out;
  }

  // ---------- questions ----------
  addQuestion({ from = 'main', q, rec = '', opts = [], ref = '' }) {
    const id = 'q' + randomUUID().slice(0, 8);
    this.questions = this.questions.filter(x => !(x.from === from && from !== 'main'));
    this.questions.push({ id, from, skill: from === 'main' ? 'main session' : (this.list.find(s => s.id === from)?.skill || 'agent'), q, rec, opts, ref, at: new Date().toISOString() });
    this.changed(); return id;
  }
  answer(qid, answer) {
    const q = this.questions.find(x => x.id === qid); if (!q) return false;
    this.questions = this.questions.filter(x => x.id !== qid);
    const text = answer === '__rec' ? `Go with your recommendation: ${q.rec}` : answer;
    if (q.from === 'main') this.pushOutbox(`Answer to “${q.q}”: ${text}`);
    else this.send(q.from, text);
    this.changed(); return true;
  }

  // ---------- spawned headless sessions ----------
  async makeWorktree(slug) {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: this.repo })).stdout.trim();
    if (!top) return { cwd: this.repo, worktree: null };
    const dir = path.join(this.dataDir, 'worktrees', slug), branch = `msu/${slug}`;
    if (await exists(dir)) return { cwd: dir, worktree: dir, branch };
    const r = await run('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], { cwd: top });
    if (!r.ok) { const r2 = await run('git', ['worktree', 'add', dir, branch], { cwd: top }); if (!r2.ok) return { cwd: this.repo, worktree: null, error: r.stderr.trim() }; }
    return { cwd: dir, worktree: dir, branch };
  }

  async spawn({ prompt, name, ticket = null, agent = 'claude', mode, worktree = false, model = null, skill = '' }) {
    const a = AGENTS[agent] || AGENTS.claude;
    if (!a.modes.includes(mode)) mode = a.defaultMode;
    const id = (ticket ? 'agent-' + String(ticket).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') : 'agent') + '-' + randomUUID().slice(0, 4);
    let cwd = this.repo, wt = null, note = '';
    if (worktree) { const w = await this.makeWorktree(id); cwd = w.cwd; wt = w.worktree; if (w.error) note = `Worktree failed (${w.error}); running in the repo.`; }
    const s = { id, name: name || prompt.slice(0, 60), kind: 'bg', agent: a.id, st: 'starting', ctx: null, doing: prompt.slice(0, 120), ticket, sessionId: a.persistent ? randomUUID() : null, sessionFile: null, worktree: wt, cwd, mode, modelArg: model || null, skill: skill || (prompt.match(/^\/[\w-]+/) || [''])[0], startedAt: new Date().toISOString(), log: [{ w: 'sys', t: `Started with ${a.label}: ${prompt}` }] };
    if (note) s.log.push({ w: 'sys', t: note });
    if (a.id === 'pi') { const dir = path.join(this.dataDir, 'pi-sessions'); await fs.mkdir(dir, { recursive: true }); s.sessionFile = path.join(dir, id + '.jsonl'); }
    s.resume = s.sessionId || s.sessionFile ? a.resumeHint(s) : null;
    this.list.push(s);
    // The real path: agents resolve symlinks (macOS /var → /private/var) and treat other spellings as outside the project.
    const dir = await fs.realpath(cwd).catch(() => cwd);
    s.cwd = dir;
    if (a.persistent) {
      this.launch(s, a.args({ mode, model, sessionId: s.sessionId, system: preamble(dir, this.cliPath) }), { keepStdin: true });
      this.write(s, prompt);
    } else this.turn(s, `${preamble(dir, this.cliPath, { skills: true })}\n\n---\n\n${prompt}`);
    this.changed();
    return s;
  }
  /** Start the agent's process and feed its stdout through the adapter's parser. */
  launch(s, args, { stdinText = null, keepStdin = false } = {}) {
    const a = AGENTS[s.agent];
    // PWD too: the server inherited its own, and some CLIs (OpenCode) take the project root from it.
    const child = spawn(agentBin(a), args, { cwd: s.cwd, env: { ...process.env, PWD: s.cwd, MATT_SKILLS_UI_SESSION: s.id }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.procs.set(s.id, child);
    const parse = a.parser();
    let buf = '', errTail = '';
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); for (const ev of parse(line)) this.apply(s, ev); } });
    let ebuf = '';
    child.stderr.on('data', d => {
      errTail = (errTail + d).slice(-2000); if (!a.stderr) return;
      ebuf += d; let i; while ((i = ebuf.indexOf('\n')) >= 0) { const ev = a.stderr(ebuf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, '')); ebuf = ebuf.slice(i + 1); if (ev) this.apply(s, ev); }
    });
    child.stdin.on('error', () => {});
    child.on('error', err => { s.st = 'failed'; s.doing = `Could not start ${agentBin(a)}`; s.log.push({ w: 'sys', t: `Could not start ${agentBin(a)}: ${err.message}` }); this.changed(); });
    child.on('exit', code => {
      if (this.procs.get(s.id) === child) this.procs.delete(s.id);
      const tail = errTail.trim().split('\n').slice(-3).join(' ');
      if (a.persistent) {
        if (s.st !== 'failed') s.st = code === 0 ? 'ended' : 'failed';
        if (code) s.log.push({ w: 'sys', t: `Exited with code ${code}. ${tail}` });
        this.questions = this.questions.filter(q => q.from !== s.id);
      } else if (s.stopping) { s.stopping = false; s.st = 'ended'; s.doing = 'Stopped; reply to resume it'; this.questions = this.questions.filter(q => q.from !== s.id); }
      else if (s.st !== 'failed') {
        if (code) s.log.push({ w: 'sys', t: `Turn exited with code ${code}. ${tail}` });
        if (code && !s.sessionId && !s.sessionFile) { s.st = 'failed'; s.doing = 'Failed to start'; }
        else this.finishTurn(s, { ...(s._end || {}), isError: s._end?.isError || (code ? `exit code ${code}` : null) });
        if (s.queue?.length && s.st === 'waiting') { const next = s.queue.splice(0).join('\n\n'); this.questions = this.questions.filter(q => q.from !== s.id); this.turn(s, next); }
      }
      this.changed();
    });
    if (stdinText != null) child.stdin.end(stdinText); else if (!keepStdin) child.stdin.end();
    return child;
  }
  /** Per-turn agents: one process per turn, resuming the session the first turn created. */
  turn(s, text) {
    const a = AGENTS[s.agent];
    s.st = 'running'; s.lastText = ''; s._end = null; s.done = false; s.doing = 'Working…';
    this.launch(s, a.args({ mode: s.mode, model: s.modelArg, resume: s.sessionId, sessionFile: s.sessionFile, prompt: text }), { stdinText: a.stdinPrompt ? text : null });
  }
  write(s, text) {
    const child = this.procs.get(s.id); if (!child) return false;
    child.stdin.write(AGENTS.claude.message(text));
    s.st = 'running'; return true;
  }
  send(id, text) {
    if (id === 'main') { this.pushOutbox(text); return true; }
    const s = this.list.find(x => x.id === id); if (!s) return false;
    const a = AGENTS[s.agent || 'claude'];
    if (a.persistent && !this.procs.has(id)) { s.log.push({ w: 'sys', t: 'This session has ended. Resume it in a terminal: ' + a.resumeHint(s) }); this.changed(); return false; }
    if (!a.persistent && !s.sessionId && !s.sessionFile) { s.log.push({ w: 'sys', t: 'This session never started, so there is nothing to resume. Spawn a new one.' }); this.changed(); return false; }
    s.log.push({ w: 'me', t: text }); this.questions = this.questions.filter(q => q.from !== id);
    if (a.persistent) this.write(s, text);
    else if (this.procs.has(id)) { (s.queue ||= []).push(text); s.log.push({ w: 'sys', t: 'Queued: it goes in when the current turn ends.' }); }
    else this.turn(s, text);
    this.changed(); return true;
  }
  stop(id) {
    const s = this.list.find(x => x.id === id), c = this.procs.get(id);
    if (!s || AGENTS[s.agent || 'claude'].persistent) { if (c) { c.stdin.end(); setTimeout(() => c.kill('SIGTERM'), 3000); } return; }
    s.queue = [];
    if (c) { s.stopping = true; c.kill('SIGTERM'); }
    else { s.st = 'ended'; s.doing = 'Stopped; reply to resume it'; this.questions = this.questions.filter(q => q.from !== id); this.changed(); }
  }
  stopAll() { for (const c of this.procs.values()) { try { c.kill('SIGTERM'); } catch {} } }

  /** Apply one normalized adapter event (see agents.mjs) to a session. */
  apply(s, ev) {
    const a = AGENTS[s.agent];
    if (ev.k === 'init') {
      const fresh = (ev.model && ev.model !== s.model) || (ev.sessionId && ev.sessionId !== s.sessionId) || s.st === 'starting';
      if (!fresh) return;
      if (ev.model) s.model = ev.model;
      if (ev.sessionId && ev.sessionId !== s.sessionId) { s.sessionId = ev.sessionId; s.resume = a.resumeHint(s); }
      if (s.st === 'starting') s.st = 'running';
    } else if (ev.k === 'text') { s.log.push({ w: 'agent', t: ev.t }); s.lastText = ev.t; s.st = 'running'; }
    else if (ev.k === 'tool') { s.log.push({ w: 'tool', t: ev.t }); s.doing = ev.t; s.st = 'running'; }
    else if (ev.k === 'ctx') { if (ev.ctx) s.ctx = ev.ctx; if (ev.cost) s.cost = (s.cost || 0) + ev.cost; if (!ev.ctx) return; }
    else if (ev.k === 'error') s.log.push({ w: 'sys', t: 'Error: ' + ev.t });
    else if (ev.k === 'end') { if (!a.persistent) { s._end = ev; return; } this.finishTurn(s, ev); }
    else return;
    if (s.log.length > 400) s.log.splice(0, s.log.length - 400);
    this.changed();
  }
  finishTurn(s, ev) {
    const text = ev.text || s.lastText || '';
    if (AGENTS[s.agent].persistent) { s.cost = ev.cost ?? s.cost; s.turns = (s.turns || 0) + (ev.turns || 0); } else s.turns = (s.turns || 0) + 1;
    const q = parseQuestion(text);
    s.st = 'waiting';
    if (!text.trim()) { s.doing = 'Turn ended without a reply; see the log'; if (ev.isError) s.log.push({ w: 'sys', t: 'Turn ended with an error: ' + ev.isError }); return; }
    if (/^\s*DONE:/im.test(text)) { s.doing = (text.match(/^\s*DONE:\s*(.+)$/im) || [])[1] || 'Done'; s.done = true; }
    if (q) { this.addQuestion({ from: s.id, q: q.q, rec: q.rec, opts: q.opts, ref: s.ticket || '' }); s.doing = 'Waiting for your answer'; }
    else if (!s.done) s.doing = 'Turn finished; reply to continue';
    if (ev.isError) s.log.push({ w: 'sys', t: 'Turn ended with an error: ' + ev.isError });
  }
}
