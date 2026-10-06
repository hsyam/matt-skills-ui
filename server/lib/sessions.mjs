// Sessions the board knows about:
//  - "main": the interactive Claude session that ran /matt-skills-ui. We can't type into it;
//    messages go to an outbox that its Monitor (cli.mjs listen) streams in. Context is read
//    best-effort from its transcript (~/.claude/projects/<slug>/<id>.jsonl, an internal format).
//  - spawned: headless `claude -p` children using stream-json in/out, so the board shows their
//    log live and can reply to them on stdin.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, openSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, readJson, writeJson, exists } from './util.mjs';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];

export function preamble(repo, cliPath) {
  return [
    `You were started from Matt Skills UI, a local web board for the repo at ${repo}. The user reads your messages on the board, not in a terminal, so keep them short and plain.`,
    `When you need a decision from the user, end your turn with exactly these lines (OPTIONS is optional):`,
    `QUESTION: <one question>`,
    `RECOMMENDED: <your recommended answer, one sentence>`,
    `OPTIONS: <option a> | <option b>`,
    `Ask one question per turn; the user's reply arrives as your next message. When the work is finished, end with one line starting with "DONE:" that says what changed.`,
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

const summarizeTool = (name, input = {}) => {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.description || input.skill || input.prompt || '';
  return `${name}${v ? ': ' + String(v).replace(/\s+/g, ' ').slice(0, 140) : ''}`;
};
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
    this.list = (saved.sessions || []).map(s => ({ ...s, st: ['running', 'waiting', 'starting'].includes(s.st) ? 'ended' : s.st }));
    this.questions = (saved.questions || []).filter(q => q.from === 'main');
    this.outbox = saved.outbox || []; this.seq = saved.seq || 0; this.delivered = saved.delivered ?? this.seq;
    if (saved.mainSessionId) this.main.sessionId = saved.mainSessionId;
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => writeJson(this.file, { sessions: this.list.map(s => ({ ...s, log: s.log.slice(-200) })), questions: this.questions, outbox: this.outbox.slice(-100), seq: this.seq, delivered: this.delivered, mainSessionId: this.main.sessionId }).catch(() => {}), 300);
  }
  changed() { this.save(); this.onChange?.(); }
  setMain(sessionId) { if (sessionId && !sessionId.includes('$')) { this.main.sessionId = sessionId; this.changed(); } }
  refreshMain() {
    const dir = path.join(os.homedir(), '.claude/projects', projectSlug(this.repo));
    const f = this.main.sessionId ? path.join(dir, this.main.sessionId + '.jsonl') : null;
    const r = f ? transcriptContext(f) : null;
    if (r) this.main.ctx = r.ctx;
    const listening = Date.now() - this.main.lastListen < 90_000;
    const waitingQ = this.questions.some(q => q.from === 'main');
    this.main.st = waitingQ ? 'waiting' : listening ? 'listening' : 'offline';
    this.main.doing = listening ? 'Receiving board messages via Monitor' : 'Not listening: run /matt-skills-ui again to reconnect';
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

  async spawn({ prompt, name, ticket = null, mode = 'acceptEdits', worktree = false, model = null, skill = '' }) {
    if (!PERMISSION_MODES.includes(mode)) mode = 'acceptEdits';
    const id = (ticket ? 'agent-' + String(ticket).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') : 'agent') + '-' + randomUUID().slice(0, 4);
    const sessionId = randomUUID();
    let cwd = this.repo, wt = null, note = '';
    if (worktree) { const w = await this.makeWorktree(id); cwd = w.cwd; wt = w.worktree; if (w.error) note = `Worktree failed (${w.error}); running in the repo.`; }
    const s = { id, name: name || prompt.slice(0, 60), kind: 'bg', st: 'starting', ctx: null, doing: prompt.slice(0, 120), ticket, sessionId, worktree: wt, cwd, mode, skill: skill || (prompt.match(/^\/[\w-]+/) || [''])[0], startedAt: new Date().toISOString(), log: [{ w: 'sys', t: `Started: ${prompt}` }] };
    if (note) s.log.push({ w: 'sys', t: note });
    this.list.push(s);
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--permission-mode', mode, '--append-system-prompt', preamble(this.repo, this.cliPath)];
    if (model) args.push('--model', model);
    const child = spawn(process.env.MATT_SKILLS_UI_CLAUDE || 'claude', args, { cwd, env: { ...process.env, MATT_SKILLS_UI_SESSION: id }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.procs.set(id, child);
    let buf = '', errTail = '';
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); this.onEvent(s, line); } });
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.on('error', err => { s.st = 'failed'; s.log.push({ w: 'sys', t: 'Could not start claude: ' + err.message }); this.changed(); });
    child.on('exit', code => { this.procs.delete(id); if (s.st !== 'failed') s.st = code === 0 ? 'ended' : 'failed'; if (code) s.log.push({ w: 'sys', t: `Exited with code ${code}. ${errTail.trim().split('\n').slice(-3).join(' ')}` }); this.questions = this.questions.filter(q => q.from !== id); this.changed(); });
    this.write(s, prompt);
    this.changed();
    return s;
  }
  write(s, text) {
    const child = this.procs.get(s.id); if (!child) return false;
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    s.st = 'running'; return true;
  }
  send(id, text) {
    if (id === 'main') { this.pushOutbox(text); return true; }
    const s = this.list.find(x => x.id === id); if (!s) return false;
    if (!this.procs.has(id)) { s.log.push({ w: 'sys', t: 'This session has ended. Resume it in a terminal: claude --resume ' + s.sessionId }); this.changed(); return false; }
    s.log.push({ w: 'me', t: text }); this.questions = this.questions.filter(q => q.from !== id);
    this.write(s, text); this.changed(); return true;
  }
  stop(id) { const c = this.procs.get(id); if (c) { c.stdin.end(); setTimeout(() => c.kill('SIGTERM'), 3000); } }
  stopAll() { for (const c of this.procs.values()) { try { c.kill('SIGTERM'); } catch {} } }

  onEvent(s, line) {
    let e; try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'system' && e.subtype === 'init') { s.model = e.model; if (s.st === 'starting') s.st = 'running'; }
    else if (e.type === 'assistant') {
      const c = ctxOf(e.message?.usage); if (c) s.ctx = c;
      for (const part of e.message?.content || []) {
        if (part.type === 'text' && part.text.trim()) { s.log.push({ w: 'agent', t: part.text.trim() }); s.lastText = part.text.trim(); }
        else if (part.type === 'tool_use') { const t = summarizeTool(part.name, part.input); s.log.push({ w: 'tool', t }); s.doing = t; }
      }
      s.st = 'running';
    } else if (e.type === 'result') {
      const text = e.result || s.lastText || '';
      s.cost = e.total_cost_usd ?? s.cost; s.turns = (s.turns || 0) + (e.num_turns || 0);
      const q = parseQuestion(text);
      if (/^\s*DONE:/im.test(text)) { s.st = 'waiting'; s.doing = (text.match(/^\s*DONE:\s*(.+)$/im) || [])[1] || 'Done'; s.done = true; }
      else s.st = 'waiting';
      if (q) { this.addQuestion({ from: s.id, q: q.q, rec: q.rec, opts: q.opts, ref: s.ticket || '' }); s.doing = 'Waiting for your answer'; }
      else if (!s.done) s.doing = 'Turn finished; reply to continue';
      if (e.is_error) s.log.push({ w: 'sys', t: 'Turn ended with an error: ' + (e.result || e.subtype) });
    } else return;
    if (s.log.length > 400) s.log.splice(0, s.log.length - 400);
    this.changed();
  }
}
