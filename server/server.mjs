#!/usr/bin/env node
// Matt Skills UI server. Usually started by `cli.mjs start`, not directly.
//   node server.mjs --repo <dir> [--port 0] [--session <claude-session-id>]
// Binds 127.0.0.1 only. Every /api call needs the per-run token (header x-msu-token or ?token=),
// and cross-origin requests are refused, so other local pages can't drive your sessions.
import http from 'node:http';
import { promises as fs, watch } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel } from './lib/model.mjs';
import { Sessions } from './lib/sessions.mjs';
import { agentList } from './lib/agents.mjs';
import { repoDataDir, writeJson, readJson, dataDir, THEMES } from './lib/util.mjs';
import { readTheme, writeThemeOverride } from './lib/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const repo = path.resolve(arg('repo', process.cwd()));
const DATA = repoDataDir(repo);
const token = randomBytes(18).toString('base64url');
const pollMs = +arg('poll', 60000);

let model = null, building = null, rebuildAgain = false;
const remoteCache = { value: null, stale: true, at: 0 };
const clients = new Set();
const sessions = new Sessions({ repo, dataDir: DATA, cliPath: path.join(here, 'cli.mjs'), onChange: () => broadcast('sessions') });
await sessions.load();
sessions.setMain(arg('session', null));

async function rebuild() {
  if (building) { rebuildAgain = true; return building; }
  building = (async () => { try { model = await buildModel(repo, { remoteCache }); } catch (e) { model = { ...(model || {}), warnings: ['Failed to read the repo: ' + e.message] }; } })();
  await building; building = null;
  broadcast('state');
  if (rebuildAgain) { rebuildAgain = false; rebuild(); }
}
const statePayload = async () => ({ ...model, sessions: sessions.all(), questions: sessions.questions, theme: await readTheme(), themes: THEMES, agents: agentList(), remoteAt: remoteCache.at });
let bt = null;
function broadcast() { clearTimeout(bt); bt = setTimeout(async () => { const data = `event: state\ndata: ${JSON.stringify(await statePayload())}\n\n`; for (const c of clients) c.write(data); }, 120); }

// Watch the files the skills write. Recursive fs.watch works on macOS, Windows and Linux (Node ≥ 20).
const WATCHED = /^(\.scratch|docs|\.out-of-scope|GLOSSARY|CONTEXT|CLAUDE\.md|AGENTS\.md|CODING_STANDARDS\.md|\.git\/(HEAD|refs)|to-questionnaire-)/;
let wt = null;
try { watch(repo, { recursive: true }, (_e, f) => { if (!f || !WATCHED.test(String(f).split(path.sep).join('/'))) return; clearTimeout(wt); wt = setTimeout(rebuild, 250); }); } catch (e) { console.error('watch failed:', e.message); }
setInterval(() => { remoteCache.stale = true; rebuild(); }, pollMs).unref();
setInterval(() => broadcast(), 15000).unref(); // keeps main-session context + listener state fresh

const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (f.includes('..')) return json(res, 400, { error: 'bad path' });
    if (f === 'index.html' && url.searchParams.get('token') === token) {
      // Inline the first state so the board paints before the load event (fast first paint, deterministic screenshots).
      if (!model) await rebuild();
      const html = (await fs.readFile(path.join(WEB, f), 'utf8')).replace('<script type="module"', `<script>window.__STATE__=${JSON.stringify(await statePayload()).replace(/</g, '\\u003c')}</script>\n<script type="module"`);
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }); return res.end(html);
    }
    try { const buf = await fs.readFile(path.join(WEB, f)); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); return res.end(buf); }
    catch { return json(res, 404, { error: 'not found' }); }
  }
  const origin = req.headers.origin, host = req.headers.host;
  if (origin && origin !== `http://${host}`) return json(res, 403, { error: 'cross-origin request refused' });
  if ((req.headers['x-msu-token'] || url.searchParams.get('token')) !== token) return json(res, 401, { error: 'bad token' });
  const p = url.pathname, POST = req.method === 'POST';
  try {
    if (p === '/api/ping') return json(res, 200, { ok: true, repo, pid: process.pid });
    if (p === '/api/state') { if (!model) await rebuild(); return json(res, 200, await statePayload()); }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(await statePayload())}\n\n`);
      clients.add(res); const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); }); return;
    }
    if (p === '/api/refresh' && POST) { remoteCache.stale = true; await rebuild(); return json(res, 200, { ok: true }); }
    if (p === '/api/send' && POST) { const b = await body(req); if (!b.text) return json(res, 400, { error: 'text required' }); return json(res, 200, { ok: sessions.send(b.to || 'main', String(b.text)) }); }
    if (p === '/api/spawn' && POST) {
      const b = await body(req); if (!b.prompt) return json(res, 400, { error: 'prompt required' });
      const s = await sessions.spawn({ prompt: String(b.prompt), name: b.name, ticket: b.ticket || null, agent: b.agent, mode: b.mode, worktree: !!b.worktree, model: b.model || null });
      return json(res, 200, { ok: true, id: s.id });
    }
    if (p === '/api/answer' && POST) { const b = await body(req); return json(res, 200, { ok: sessions.answer(b.qid, String(b.answer || '')) }); }
    if (p === '/api/stop-session' && POST) { const b = await body(req); sessions.stop(b.id); return json(res, 200, { ok: true }); }
    if (p === '/api/questions' && POST) { const b = await body(req); if (!b.q) return json(res, 400, { error: 'q required' }); return json(res, 200, { ok: true, id: sessions.addQuestion({ from: 'main', q: String(b.q), rec: String(b.rec || ''), opts: [].concat(b.opts || []).map(String), ref: String(b.ref || '') }) }); }
    if (p === '/api/outbox') { const msgs = await sessions.waitOutbox(url.searchParams.get('wait') ? 25000 : 0); broadcast(); return json(res, 200, { messages: msgs }); }
    if (p === '/api/main' && POST) { const b = await body(req); sessions.setMain(b.session); return json(res, 200, { ok: true }); }
    if (p === '/api/theme' && POST) { const b = await body(req); await writeThemeOverride(b.theme || null); broadcast(); return json(res, 200, { ok: true, theme: await readTheme() }); }
    if (p === '/api/shutdown' && POST) { json(res, 200, { ok: true }); setTimeout(shutdown, 50); return; }
    return json(res, 404, { error: 'unknown endpoint' });
  } catch (e) { return json(res, 500, { error: e.message }); }
});

async function shutdown() {
  sessions.stopAll();
  for (const c of clients) { try { c.end(); } catch {} }
  const sj = await readJson(path.join(DATA, 'server.json')); if (sj?.pid === process.pid) await fs.rm(path.join(DATA, 'server.json'), { force: true });
  server.close(); setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

server.listen(+arg('port', 0), '127.0.0.1', async () => {
  const port = server.address().port;
  await writeJson(path.join(DATA, 'server.json'), { pid: process.pid, port, token, repo, startedAt: new Date().toISOString(), url: `http://127.0.0.1:${port}/?token=${token}` });
  console.log(JSON.stringify({ ready: true, port, url: `http://127.0.0.1:${port}/?token=${token}`, dataDir: dataDir() }));
  rebuild();
});
