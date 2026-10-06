// Scans what /setup-matt-pocock-skills wrote plus the knowledge the other skills leave behind.
import os from 'node:os';
import path from 'node:path';
import { exists, readText, listDir, readJson, run, firstHeading } from './util.mjs';

// From mattpocock/skills README (promoted buckets). User-invoked vs model-invoked.
export const MATT_USER = ['ask-matt', 'grill-with-docs', 'triage', 'improve-codebase-architecture', 'setup-matt-pocock-skills', 'to-spec', 'to-tickets', 'implement', 'implement-spec', 'wayfinder', 'retro', 'grill-me', 'handoff', 'teach', 'to-questionnaire', 'wait-what'];
export const MATT_MODEL = ['prototype', 'diagnosing-bugs', 'research', 'tdd', 'domain-modeling', 'codebase-design', 'code-review', 'pr', 'wizard', 'grilling', 'writing-for-agents'];

export async function detectTracker(repo) {
  const md = await readText(path.join(repo, 'docs/agents/issue-tracker.md'));
  if (md) {
    const h = (firstHeading(md) || '').toLowerCase();
    if (h.includes('github')) return { kind: 'github', configured: true };
    if (h.includes('gitlab')) return { kind: 'gitlab', configured: true };
    if (h.includes('local')) return { kind: 'local', configured: true };
    return { kind: 'other', configured: true, note: firstHeading(md) };
  }
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: repo });
  if (remote.ok && /github\.com/.test(remote.stdout)) return { kind: 'github', configured: false };
  if (remote.ok && /gitlab/.test(remote.stdout)) return { kind: 'gitlab', configured: false };
  return { kind: 'local', configured: false };
}

/** Parse the right-hand column of docs/agents/triage-labels.md into {role: label}. */
export async function readLabelMap(repo) {
  const md = await readText(path.join(repo, 'docs/agents/triage-labels.md'));
  const map = { 'needs-triage': 'needs-triage', 'needs-info': 'needs-info', 'ready-for-agent': 'ready-for-agent', 'ready-for-human': 'ready-for-human', wontfix: 'wontfix' };
  for (const m of (md || '').matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)) if (map[m[1]]) map[m[1]] = m[2];
  return map;
}

export async function readGlossary(repo) {
  const terms = {};
  const files = [];
  const mapMd = await readText(path.join(repo, 'GLOSSARY-MAP.md'));
  if (mapMd) for (const m of mapMd.matchAll(/\]\(\.?\/?([^)]+GLOSSARY\.md)\)/g)) files.push(m[1]);
  files.push('GLOSSARY.md', 'CONTEXT.md');
  for (const f of files) {
    const md = await readText(path.join(repo, f)); if (!md) continue;
    for (const m of md.matchAll(/^\*\*([^*\n]+?)\*\*:?\s*\n([^\n]+)(?:\n_Avoid_:\s*([^\n]+))?/gm)) {
      const k = m[1].replace(/:$/, '').trim(); if (!k || terms[k]) continue;
      terms[k] = m[2].trim() + (m[3] ? ` Avoid: ${m[3].trim()}` : '');
    }
  }
  return terms;
}

async function mdFiles(dir) { return (await listDir(dir)).filter(f => f.isFile() && f.name.endsWith('.md')).map(f => f.name).sort(); }

export async function readAdrs(repo) {
  const out = [];
  for (const f of await mdFiles(path.join(repo, 'docs/adr'))) out.push({ file: 'docs/adr/' + f, title: firstHeading(await readText(path.join(repo, 'docs/adr', f))) || f });
  return out;
}

export async function readSkills(repo) {
  const found = new Map();
  const dirs = [path.join(repo, '.claude/skills'), path.join(repo, '.agents/skills'), path.join(os.homedir(), '.claude/skills'), path.join(os.homedir(), '.agents/skills')];
  for (const d of dirs) for (const e of await listDir(d)) if (!found.has(e.name) && await exists(path.join(d, e.name, 'SKILL.md'))) found.set(e.name, d);
  let source = null;
  const lock = await readJson(path.join(os.homedir(), '.agents/.skill-lock.json'));
  const fromLock = Object.entries(lock?.skills || {}).filter(([, v]) => v.source === 'mattpocock/skills');
  if (fromLock.length) source = `skills.sh · updated ${fromLock.map(([, v]) => v.updatedAt).sort().pop().slice(0, 10)}`;
  const plugins = await readJson(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'));
  const pk = Object.keys(plugins?.plugins || {}).find(k => k.startsWith('mattpocock-skills@'));
  if (pk) {
    const inst = [].concat(plugins.plugins[pk])[0] || {};
    source = `plugin ${pk.split('@')[0]} ${inst.version || ''}`.trim();
    const pj = await readJson(path.join(inst.installPath || '', '.claude-plugin/plugin.json'));
    for (const s of pj?.skills || []) found.set(path.basename(s), 'plugin');
  }
  const mark = list => list.map(name => ({ name, installed: found.has(name) }));
  return { user: mark(MATT_USER), model: mark(MATT_MODEL), source };
}

export async function readSetup(repo, tracker) {
  const S = [];
  const add = (label, file, st, detail, fix) => S.push({ label, file, st, detail, fix });
  const itMd = await readText(path.join(repo, 'docs/agents/issue-tracker.md'));
  add('Issue tracker', 'docs/agents/issue-tracker.md', itMd ? 'ok' : 'missing', itMd ? `${firstHeading(itMd)?.replace(/^Issue tracker:\s*/i, '') || tracker.kind}` : `Not configured; guessed ${tracker.kind} from the repo`, itMd ? null : '/setup-matt-pocock-skills');
  if (itMd && tracker.kind !== 'other') add('Wayfinding operations', 'docs/agents/issue-tracker.md', /##\s*Wayfinding operations/i.test(itMd) ? 'ok' : 'warn', /##\s*Wayfinding operations/i.test(itMd) ? 'Section present' : 'Written by an older setup; /wayfinder will guess where maps live', /##\s*Wayfinding operations/i.test(itMd) ? null : '/setup-matt-pocock-skills');
  const tl = await readText(path.join(repo, 'docs/agents/triage-labels.md'));
  add('Triage labels', 'docs/agents/triage-labels.md', tl ? 'ok' : 'warn', tl ? 'Role to label mapping present' : 'Missing; /triage falls back to default label names', tl ? null : '/setup-matt-pocock-skills');
  const dm = await readText(path.join(repo, 'docs/agents/domain.md'));
  add('Domain docs', 'docs/agents/domain.md', dm ? 'ok' : 'warn', dm ? (/GLOSSARY-MAP/.test(dm) && await exists(path.join(repo, 'GLOSSARY-MAP.md')) ? 'multi-context' : 'single-context') : 'Missing', dm ? null : '/setup-matt-pocock-skills');
  let block = null;
  for (const f of ['CLAUDE.md', 'AGENTS.md']) { const t = await readText(path.join(repo, f)); if (t != null) { block = { f, ok: /^##\s+Agent skills/m.test(t) }; break; } }
  add('Agent skills block', block?.f || 'CLAUDE.md', block?.ok ? 'ok' : 'warn', block ? (block.ok ? '## Agent skills present' : `${block.f} has no ## Agent skills block`) : 'No CLAUDE.md or AGENTS.md', block?.ok ? null : '/setup-matt-pocock-skills');
  const terms = Object.keys(await readGlossary(repo)).length;
  add('Glossary', 'GLOSSARY.md', terms ? 'ok' : 'warn', terms ? `${terms} terms` : 'No glossary yet; /grill-with-docs builds it as terms get resolved', terms ? null : '/grill-with-docs');
  const adrs = await readAdrs(repo);
  add('ADRs', 'docs/adr/', adrs.length ? 'ok' : 'info', adrs.length ? `${adrs.length} decision${adrs.length > 1 ? 's' : ''}, latest ${path.basename(adrs[adrs.length - 1].file, '.md')}` : 'None yet (created lazily)');
  const oos = await mdFiles(path.join(repo, '.out-of-scope'));
  add('Out-of-scope', '.out-of-scope/', oos.length ? 'ok' : 'info', oos.length ? oos.map(f => f.replace(/\.md$/, '')).join(', ') : 'None yet (written by /triage on rejection)');
  const cs = await exists(path.join(repo, 'CODING_STANDARDS.md'));
  add('Coding standards', 'CODING_STANDARDS.md', cs ? 'ok' : 'info', cs ? 'Present; /code-review enforces it' : '/code-review falls back to its Fowler smell baseline', cs ? null : '/retro');
  const guard = (await exists(path.join(repo, '.husky'))) || (await listDir(path.join(repo, '.github/workflows'))).length > 0;
  add('Guardrail', '.husky · .github/workflows', guard ? 'ok' : 'warn', guard ? 'Pre-commit hook or CI present' : 'No pre-commit hook or CI job', guard ? null : '/setup-pre-commit');
  return S;
}

export async function readArtifacts(repo) {
  const A = [];
  const br = await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/prototype', 'refs/heads/research', 'refs/remotes/origin/prototype', 'refs/remotes/origin/research'], { cwd: repo });
  for (const b of [...new Set(br.stdout.split('\n').filter(Boolean).map(b => b.replace(/^origin\//, '')))]) A.push({ kind: b.startsWith('prototype') ? 'prototype' : 'research', g: b.startsWith('prototype') ? '◧' : '⌕', title: b.split('/').slice(1).join('/'), ref: 'branch ' + b });
  for (const f of (await listDir(repo)).filter(f => /^to-questionnaire-.*\.md$/.test(f.name))) A.push({ kind: 'questionnaire', g: '?', title: f.name.replace(/^to-questionnaire-|\.md$/g, ''), ref: f.name });
  for (const dir of ['docs/research', 'research']) for (const f of await mdFiles(path.join(repo, dir))) A.push({ kind: 'research', g: '⌕', title: firstHeading(await readText(path.join(repo, dir, f))) || f, ref: `${dir}/${f}` });
  const tmp = process.env.TMPDIR || os.tmpdir();
  for (const f of await listDir(tmp)) {
    if (/^architecture-review-.*\.html$/.test(f.name)) A.push({ kind: 'report', g: '▦', title: 'Architecture review', ref: path.join(tmp, f.name) });
    else if (/handoff.*\.md$/i.test(f.name)) A.push({ kind: 'handoff', g: '⇄', title: f.name.replace(/\.md$/, ''), ref: path.join(tmp, f.name) });
  }
  for (const a of await readAdrs(repo)) A.push({ kind: 'adr', g: '§', title: a.title, ref: a.file });
  return A;
}

export async function readProject(repo) {
  const branch = (await run('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim();
  const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd: repo })).stdout.trim();
  const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return { name: path.basename(repo), path: repo, branch: branch || '(no git)', repo: m ? m[1] : '' };
}
