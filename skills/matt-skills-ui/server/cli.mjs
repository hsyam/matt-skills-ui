#!/usr/bin/env node
// matt-skills-ui CLI. One server per repo; state under ~/.matt-skills-ui/repos/<hash>/.
//   start [--no-open] [--session <id>] [--host <agent>]   start (or reuse) the board and print its URL.
//        --host names the agent that ran it (claude, opencode, codex…); only Claude Code can listen.
//   status | url | stop
//   theme <swiss|terminal|transit|toybox|default>
//   listen                               stream board messages for the main session (use with Monitor)
//   ask "<question>" [--rec "<answer>"] [--options "a|b"] [--ref <ticket>]
// Common: --repo <dir> (default: cwd)
import { spawn } from 'node:child_process';
import { promises as fs, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoDataDir, readJson, run, THEMES } from './lib/util.mjs';
import { readTheme, writeThemeOverride } from './lib/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = k => { const i = argv.indexOf('--' + k); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const repo = path.resolve(String(flag('repo') || process.cwd()));
const session = flag('session'), noOpen = flag('no-open'), port = flag('port'), host = flag('host');
const rec = flag('rec'), options = flag('options'), ref = flag('ref');
const COMMANDS = ['start', 'status', 'url', 'stop', 'theme', 'listen', 'ask', 'open'];
const pos = argv.filter(a => !a.startsWith('--') && !a.includes('${') && !/^\$\w+$/.test(a));
const cmd = COMMANDS.includes(pos[0]) ? pos.shift() : 'start';
const DATA = repoDataDir(repo);

async function current() {
  const sj = await readJson(path.join(DATA, 'server.json'));
  if (!sj) return null;
  try { process.kill(sj.pid, 0); } catch { return null; }
  const r = await api(sj, '/api/ping').catch(() => null);
  return r?.ok ? sj : null;
}
async function api(sj, p, { method = 'GET', body, timeout = 5000 } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(`http://127.0.0.1:${sj.port}${p}`, { method, signal: ac.signal, headers: { 'x-msu-token': sj.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return await r.json();
  } finally { clearTimeout(t); }
}
const openBrowser = url => { const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'; spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); };

async function start() {
  let sj = await current(), reused = !!sj;
  if (!sj) {
    await fs.mkdir(DATA, { recursive: true });
    const log = openSync(path.join(DATA, 'server.log'), 'a');
    const args = [path.join(here, 'server.mjs'), '--repo', repo];
    if (session && session !== true) args.push('--session', String(session));
    if (host && host !== true) args.push('--host', String(host));
    if (port) args.push('--port', String(port));
    spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], cwd: repo }).unref();
    for (let i = 0; i < 100 && !(sj = await current()); i++) await new Promise(r => setTimeout(r, 100));
    if (!sj) { console.error(`matt-skills-ui: server did not start. See ${path.join(DATA, 'server.log')}`); process.exit(1); }
  } else if ((session && session !== true) || (host && host !== true)) await api(sj, '/api/main', { method: 'POST', body: { session: session === true ? null : session, host: host === true ? null : host } });
  const theme = (await readTheme()).current;
  console.log(`Matt Skills UI ${reused ? 'is already running' : 'started'} for ${repo}`);
  console.log(`URL: ${sj.url}`);
  console.log(`Theme: ${theme} (change it on the board, or: /matt-skills-ui theme <${THEMES.join('|')}>)`);
  if (!noOpen) openBrowser(sj.url);
}

if (cmd === 'start' || cmd === 'open') await start();
else if (cmd === 'url' || cmd === 'status') {
  const sj = await current();
  if (!sj) { console.log(`Matt Skills UI is not running for ${repo}.`); process.exit(cmd === 'url' ? 1 : 0); }
  if (cmd === 'url') console.log(sj.url);
  else { const st = await api(sj, '/api/state', { timeout: 30000 }); console.log(`Running (pid ${sj.pid}) at ${sj.url}\nEfforts: ${st.efforts.length} · issues: ${st.issues.length} · sessions: ${st.sessions.length} · questions waiting: ${st.questions.length} · tracker: ${st.project.tracker}${st.warnings?.length ? '\nWarnings: ' + st.warnings.join(' | ') : ''}`); }
} else if (cmd === 'stop') {
  const sj = await current();
  if (!sj) console.log('Not running.'); else { await api(sj, '/api/shutdown', { method: 'POST' }).catch(() => {}); console.log('Stopped Matt Skills UI. Spawned board sessions were stopped too.'); }
} else if (cmd === 'theme') {
  const t = pos[0];
  if (!t) { const th = await readTheme(); console.log(`Theme: ${th.current} (install default: ${th.install}${th.override ? `, overridden on the board/CLI` : ''})`); }
  else if (t === 'default' || THEMES.includes(t)) {
    const sj = await current();
    if (sj) await api(sj, '/api/theme', { method: 'POST', body: { theme: t === 'default' ? null : t } }); else await writeThemeOverride(t === 'default' ? null : t);
    const th = await readTheme(); console.log(`Theme set to ${th.current}${t === 'default' ? ' (install default)' : ''}.`);
  } else { console.error(`Unknown theme "${t}". Choose one of: ${THEMES.join(', ')}, default.`); process.exit(1); }
} else if (cmd === 'ask') {
  const sj = await current(); if (!sj) { console.error('Matt Skills UI is not running.'); process.exit(1); }
  const q = pos.join(' ').trim(); if (!q) { console.error('Usage: ask "<question>" [--rec "..."] [--options "a|b"] [--ref <ticket>]'); process.exit(1); }
  const r = await api(sj, '/api/questions', { method: 'POST', body: { q, rec: rec === true ? '' : rec, opts: typeof options === 'string' ? options.split('|').map(s => s.trim()).filter(Boolean) : [], ref: ref === true ? '' : ref } });
  console.log(`Posted to the board as ${r.id}. The answer arrives through the board listener.`);
} else if (cmd === 'listen') {
  // One stdout line per board message. Exits when the server stops. Meant for the Monitor tool.
  let misses = 0;
  for (;;) {
    const sj = await current();
    if (!sj) { if (++misses > 3) { console.log('[matt-skills-ui] The board has stopped; no more messages.'); process.exit(0); } await new Promise(r => setTimeout(r, 2000)); continue; }
    misses = 0;
    try {
      const r = await api(sj, '/api/outbox?wait=1', { timeout: 40000 });
      for (const m of r.messages || []) console.log(`[matt-skills-ui] From the board: ${m.text.replace(/\s*\n\s*/g, ' ⏎ ')}`);
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}
