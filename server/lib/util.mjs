import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Run a command, resolve {ok, stdout, stderr}. Never throws. */
export function run(cmd, args, { cwd, timeout = 20000, input } = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
    if (input != null) { child.stdin.end(input); }
  });
}

export const exists = p => fs.access(p).then(() => true, () => false);
export const readText = p => fs.readFile(p, 'utf8').catch(() => null);
export async function listDir(p) { try { return await fs.readdir(p, { withFileTypes: true }); } catch { return []; } }
export async function readJson(p, fallback = null) { const t = await readText(p); if (t == null) return fallback; try { return JSON.parse(t); } catch { return fallback; } }
export async function writeJson(p, v) { await fs.mkdir(path.dirname(p), { recursive: true }); const tmp = p + '.' + process.pid + '.tmp'; await fs.writeFile(tmp, JSON.stringify(v, null, 2)); await fs.rename(tmp, p); }

export const repoHash = repo => createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 12);

/** Data dir: $MATT_SKILLS_UI_HOME, else ~/.matt-skills-ui. Per-repo state lives under repos/<hash>/. */
export function dataDir() { return process.env.MATT_SKILLS_UI_HOME || path.join(os.homedir(), '.matt-skills-ui'); }
export function repoDataDir(repo) { return path.join(dataDir(), 'repos', repoHash(repo)); }

export const THEMES = ['swiss', 'terminal', 'transit', 'toybox'];

/** Markdown helpers shared by the tracker adapters. */
export function sections(md) {
  const out = {}; let cur = null;
  for (const line of (md || '').split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) { cur = h[1].trim().toLowerCase(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  for (const k in out) out[k] = out[k].join('\n').trim();
  return out;
}
export function firstHeading(md) { const m = (md || '').match(/^#\s+(.+)$/m); return m ? m[1].trim() : null; }
export function listItems(text) {
  return (text || '').split('\n').map(l => l.match(/^\s*[-*]\s+(.*)$/)).filter(Boolean).map(m => m[1].trim()).filter(s => s && !s.startsWith('<!--'));
}
export function firstParagraph(text, max = 260) {
  const p = (text || '').split(/\n\s*\n/).map(s => s.replace(/<!--[\s\S]*?-->/g, '').trim()).find(Boolean) || '';
  const flat = p.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
export function checkboxes(md) {
  const all = [...(md || '').matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/gm)];
  return all.map(m => ({ done: m[1] !== ' ', text: m[2].trim() }));
}
/** Read a `Key: value` or `**Key:** value` line near the top of a markdown file. */
export function field(md, key) {
  const re = new RegExp(`^[ \\t]*(?:\\*\\*)?${key}[ \\t]*:?(?:\\*\\*)?[ \\t]*:?[ \\t]*(.+)$`, 'im');
  const m = (md || '').match(re); return m ? (m[1].replace(/\*\*/g, '').trim() || null) : null;
}
export const titleCase = slug => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
export const DONE_STATUSES = new Set(['done', 'closed', 'resolved', 'complete', 'completed', 'fixed', 'merged', 'wontfix', 'shipped']);
export const CLAIMED_STATUSES = new Set(['claimed', 'in-progress', 'in progress', 'wip', 'doing', 'started']);
