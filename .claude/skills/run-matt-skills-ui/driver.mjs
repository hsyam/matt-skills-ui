#!/usr/bin/env node
// Driver for matt-skills-ui. Runs the real server against a throwaway copy of the fixture repo,
// with an isolated data dir, and exercises it over HTTP + the CLI. Paths are relative to the plugin root.
//   node .claude/skills/run-matt-skills-ui/driver.mjs smoke [--keep] [--shots]   API + CLI checks (free)
//   node .claude/skills/run-matt-skills-ui/driver.mjs spawn [--agent <id>]       + a real headless agent, read-only (claude: haiku, ~$0.10;
//                                                                                  or opencode | codex | cursor | gemini | pi)
//   node .claude/skills/run-matt-skills-ui/driver.mjs up [--repo <dir>]          start a board and print its URL
//   node .claude/skills/run-matt-skills-ui/driver.mjs shot <url> [out.png] [--theme swiss|terminal|transit|toybox] [--size 1440,900]
//   node .claude/skills/run-matt-skills-ui/driver.mjs down                       stop every board started by the driver
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'server/cli.mjs');
const HOME = process.env.MATT_SKILLS_UI_HOME || path.join(os.tmpdir(), 'matt-skills-ui-driver');
const SHOTS = path.join(os.tmpdir(), 'matt-skills-ui-shots');
const env = { ...process.env, MATT_SKILLS_UI_HOME: HOME };
const [cmd = 'smoke', ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf('--' + k); return i < 0 ? undefined : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true); };
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`); if (!cond) fails++; };
const cli = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fixtureCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'msu-fixture-'));
  cpSync(path.join(ROOT, 'test/fixtures/acme-local'), dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir }); spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=driver', 'commit', '-qam', 'fixture', '--allow-empty'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir }); spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=driver', 'commit', '-qm', 'fixture'], { cwd: dir });
  return dir;
}
function serverJson(repo) {
  const out = cli('url', '--repo', repo).trim(); const u = new URL(out);
  return { base: u.origin, token: u.searchParams.get('token'), url: out };
}
async function api(sj, p, body) {
  const r = await fetch(sj.base + p, { method: body ? 'POST' : 'GET', headers: { 'x-msu-token': sj.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
// Prefer Playwright's chrome-headless-shell (full Chrome --headless hangs inside some sandboxes).
function chrome() {
  if (process.env.MSU_CHROME) return process.env.MSU_CHROME;
  for (const cache of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    const dirs = existsSync(cache) ? readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
    for (const d of dirs) for (const sub of readdirSync(path.join(cache, d))) { const b = path.join(cache, d, sub, 'chrome-headless-shell'); if (existsSync(b)) return b; }
  }
  const c = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'google-chrome', 'chromium', 'chromium-browser'];
  return c.find(p => p.includes('/') ? existsSync(p) : spawnSync('which', [p]).status === 0);
}
function shot(url, out, { theme, size = '1440,900' } = {}) {
  const bin = chrome(); if (!bin) { console.log('SKIP  screenshot: no Chrome/Chromium found'); return null; }
  mkdirSync(path.dirname(out), { recursive: true });
  const u = new URL(url); if (theme) u.searchParams.set('theme', theme);
  const prof = mkdtempSync(path.join(os.tmpdir(), 'msu-chrome-'));
  spawnSync(bin, [...(bin.includes('headless-shell') ? [] : ['--headless=new']), '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${prof}`, `--window-size=${size}`, '--force-prefers-reduced-motion', '--timeout=12000', `--screenshot=${out}`, u.toString()], { stdio: 'ignore', timeout: 45000, killSignal: 'SIGKILL' });
  return existsSync(out) ? out : null;
}

async function smoke({ keep, shots, withSpawn } = {}) {
  const repo = fixtureCopy();
  console.log(`repo ${repo}\nhome ${HOME}`);
  const startOut = cli('start', '--repo', repo, '--no-open');
  ok('cli start prints a URL', /URL: http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(startOut));
  const sj = serverJson(repo);
  const st = await api(sj, '/api/state');
  ok('state: 3 efforts (spec, map, empty spec)', st.efforts?.length === 3, st.efforts?.map(e => e.id).join(','));
  ok('state: 3 inbox issues, dark-mode matched to .out-of-scope', st.issues?.length === 3 && st.issues.some(i => i.oos === 'dark-mode'));
  ok('state: setup scan', st.setup?.find(s => s.label === 'Issue tracker')?.st === 'ok');
  ok('state: glossary terms', Object.keys(st.glossary || {}).length === 3);
  ok('security: missing token refused', (await (await fetch(sj.base + '/api/state')).json()).error === 'bad token');
  ok('security: cross-origin refused', (await (await fetch(sj.base + '/api/state', { headers: { 'x-msu-token': sj.token, origin: 'https://evil.example' } })).json()).error === 'cross-origin request refused');
  ok('static: index.html served', (await (await fetch(sj.base + '/')).text()).includes('/app.js'));

  const listener = spawn(process.execPath, [CLI, 'listen', '--repo', repo], { env });
  let heard = ''; listener.stdout.on('data', d => heard += d);
  await sleep(500);
  await api(sj, '/api/send', { to: 'main', text: '/to-tickets .scratch/gift-cards/spec.md' });
  cli('ask', '--repo', repo, 'Should gift cards expire?', '--rec', 'No', '--options', 'Never|12 months');
  const q = (await api(sj, '/api/state')).questions[0];
  ok('ask: question shows on the board', q?.q === 'Should gift cards expire?' && q.opts.length === 2);
  await api(sj, '/api/answer', { qid: q.id, answer: '__rec' });
  await sleep(1500);
  ok('listen: board message reaches the main session', heard.includes('From the board: /to-tickets'));
  ok('listen: answer reaches the main session', heard.includes('Answer to “Should gift cards expire?”'));
  listener.kill();

  const f = path.join(repo, '.scratch/checkout-v2/issues/05-address-validation.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('**Status:** ready-for-agent', '**Status:** done'));
  await sleep(1500);
  const t05 = (await api(sj, '/api/state')).efforts.find(e => e.id === 'checkout-v2').tickets.find(t => t.label === '05');
  ok('live: file edit re-reads the ticket', t05.status === 'done');

  cli('theme', 'transit', '--repo', repo);
  ok('theme: override persisted', (await api(sj, '/api/state')).theme.current === 'transit');
  cli('theme', 'default', '--repo', repo);

  if (withSpawn) {
    const agent = typeof opt('agent') === 'string' ? opt('agent') : 'claude', READ_ONLY = { claude: 'plan', opencode: 'plan', codex: 'read-only', cursor: 'plan', gemini: 'default', pi: 'full' };
    const r = await api(sj, '/api/spawn', { prompt: 'Read .scratch/gift-cards/spec.md, then ask me one question about it using the QUESTION/RECOMMENDED/OPTIONS format. Do not edit files.', agent, mode: READ_ONLY[agent], model: agent === 'claude' ? 'haiku' : null, name: 'driver probe' });
    let s, qq;
    for (let i = 0; i < 40 && !qq; i++) { await sleep(3000); const x = await api(sj, '/api/state'); s = x.sessions.find(y => y.id === r.id); qq = x.questions.find(y => y.from === r.id); if (s?.st === 'failed') break; }
    ok(`spawn (${agent}): agent asks a parsed question`, !!qq, qq ? qq.q : s?.log?.slice(-2).map(l => l.t).join(' | '));
    if (qq) {
      await api(sj, '/api/answer', { qid: qq.id, answer: '__rec' });
      for (let i = 0; i < 40; i++) { await sleep(3000); s = (await api(sj, '/api/state')).sessions.find(y => y.id === r.id); if (s.st === 'waiting' && !s.doing.startsWith('Waiting')) break; }
      ok(`spawn (${agent}): agent continues after the answer`, s.log.filter(l => l.w === 'agent').length >= 2, `cost $${(s.cost || 0).toFixed(3)}, resume: ${s.resume}`);
    }
  }
  if (shots) for (const th of ['swiss', 'terminal', 'transit', 'toybox']) { const p = shot(sj.url, path.join(SHOTS, `board-${th}.png`), { theme: th }); if (p) console.log(`SHOT  ${p}`); }
  if (keep) console.log(`KEEP  ${sj.url}\n      stop with: node .claude/skills/run-matt-skills-ui/driver.mjs down`);
  else { cli('stop', '--repo', repo); }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
}

if (cmd === 'smoke') await smoke({ keep: opt('keep'), shots: opt('shots') });
else if (cmd === 'spawn') await smoke({ withSpawn: true, keep: opt('keep') });
else if (cmd === 'up') { const repo = opt('repo') ? path.resolve(String(opt('repo'))) : fixtureCopy(); process.stdout.write(cli('start', '--repo', repo, '--no-open')); }
else if (cmd === 'shot') { const out = shot(rest[0], rest[1] && !rest[1].startsWith('--') ? path.resolve(rest[1]) : path.join(SHOTS, 'board.png'), { theme: opt('theme'), size: opt('size') }); console.log(out ? `SHOT  ${out}` : 'screenshot failed'); }
else if (cmd === 'down') {
  for (const h of existsSync(path.join(HOME, 'repos')) ? readdirSync(path.join(HOME, 'repos')) : []) {
    try { const sj = JSON.parse(readFileSync(path.join(HOME, 'repos', h, 'server.json'), 'utf8')); process.kill(sj.pid, 'SIGTERM'); console.log(`stopped ${sj.repo}`); } catch {}
  }
} else { console.error('usage: driver.mjs smoke|spawn|up|shot|down'); process.exit(2); }
