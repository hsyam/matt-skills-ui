// Local-markdown tracker: .scratch/<feature>/{spec.md|map.md} + issues/NN-slug.md
// Conventions come from setup-matt-pocock-skills/issue-tracker-local.md, to-tickets and wayfinder.
import path from 'node:path';
import { listDir, readText, sections, firstHeading, listItems, firstParagraph, checkboxes, field, titleCase, DONE_STATUSES, CLAIMED_STATUSES } from './util.mjs';

const TRIAGE_ROLES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

export function parseTicketFile(md, file) {
  const base = path.basename(file, '.md');
  const num = (base.match(/^(\d+)/) || [])[1] || base;
  const h = firstHeading(md) || '';
  const title = h.replace(/^\d+\s*[:.)-]\s*/, '').trim() || titleCase(base.replace(/^\d+-?/, ''));
  const blockedRaw = field(md, 'Blocked by') || '';
  const blockedBy = /^none\b/i.test(blockedRaw) ? [] : [...blockedRaw.matchAll(/\b(\d{1,4})\b/g)].map(m => m[1]);
  const statusRaw = (field(md, 'Status') || '').toLowerCase().replace(/[`*_]/g, '').trim();
  const status = DONE_STATUSES.has(statusRaw) ? 'done' : CLAIMED_STATUSES.has(statusRaw) ? 'claimed' : 'open';
  const typeRaw = (field(md, 'Type') || '').toLowerCase().replace(/[`*_]/g, '').trim();
  const type = ['research', 'prototype', 'grilling', 'task'].includes(typeRaw) ? typeRaw : null;
  const cb = checkboxes(md);
  const sec = sections(md);
  const answer = sec['answer'] ? firstParagraph(sec['answer'], 160) : null;
  return { num, title, blockedBy, status, role: TRIAGE_ROLES.includes(statusRaw) ? statusRaw : null, statusRaw, type, ac: cb.length ? cb.map(c => c.done ? 1 : 0) : null, acText: cb.map(c => c.text), answer };
}

export function parseMap(md) {
  const s = sections(md);
  const get = k => s[k] ?? s[k.replace(/ /g, '-')] ?? '';
  const decisions = listItems(get('decisions so far')).map(it => {
    const m = it.match(/^\[([^\]]+)\]\(([^)]*)\)\s*[:\-–]?\s*(.*)$/);
    return m ? { title: m[1], link: m[2], gist: m[3] } : { title: it, link: '', gist: '' };
  });
  const fogItems = listItems(get('not yet specified'));
  const fog = fogItems.length ? fogItems : get('not yet specified').split(/\n\s*\n/).map(p => p.replace(/<!--[\s\S]*?-->/g, '').trim()).filter(Boolean).map(p => firstParagraph(p, 90));
  const oos = listItems(get('out of scope')).map(it => { const [t, ...why] = it.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/:\s+/); return { title: t, why: why.join(': ') }; });
  return { destination: firstParagraph(get('destination'), 240), notes: firstParagraph(get('notes'), 300), decisions, fog, oos };
}

export function parseSpec(md, slug) {
  const s = sections(md);
  const stories = (s['user stories'] || '').split('\n').filter(l => /^\s*\d+\.\s+/.test(l)).length;
  return { title: firstHeading(md) || titleCase(slug), summary: firstParagraph(s['problem statement'] || s['solution'] || md, 240), stories };
}

/** Read every .scratch/<feature>/ folder. Returns {efforts, issues}. */
export async function readLocal(repo) {
  const root = path.join(repo, '.scratch');
  const efforts = [], issues = [];
  for (const d of await listDir(root)) {
    if (!d.isDirectory()) continue;
    const slug = d.name, dir = path.join(root, slug);
    const specMd = await readText(path.join(dir, 'spec.md'));
    const mapMd = await readText(path.join(dir, 'map.md'));
    const tickets = [];
    for (const f of (await listDir(path.join(dir, 'issues'))).filter(f => f.isFile() && f.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join('.scratch', slug, 'issues', f.name);
      const md = await readText(path.join(repo, rel));
      if (md == null) continue;
      tickets.push({ ...parseTicketFile(md, f.name), ref: rel, file: rel });
    }
    // resolve "Blocked by: 01, 02" numbers to sibling ids (tolerate 1 vs 01)
    const byNum = new Map(tickets.map(t => [String(+t.num), t]));
    const idOf = t => `${slug}:${t.num}`;
    for (const t of tickets) t.blockedBy = t.blockedBy.map(n => byNum.get(String(+n))).filter(Boolean).map(idOf);
    const mkTickets = () => tickets.map(t => ({ id: idOf(t), label: t.num, ref: t.ref, title: t.title, status: t.status, role: t.role, type: t.type, blockedBy: t.blockedBy, ac: t.ac, acText: t.acText, answer: t.answer, source: 'local' }));
    if (mapMd != null) {
      efforts.push({ id: slug, label: slug, ref: path.join('.scratch', slug, 'map.md'), kind: 'map', title: firstHeading(mapMd) || titleCase(slug), sub: '', source: 'local', ...parseMap(mapMd), tickets: mkTickets() });
    } else if (specMd != null) {
      const sp = parseSpec(specMd, slug);
      efforts.push({ id: slug, label: slug, ref: path.join('.scratch', slug, 'spec.md'), kind: 'spec', title: sp.title, sub: '', summary: sp.summary, stories: sp.stories, source: 'local', tickets: mkTickets() });
    } else {
      // A folder with issues but no spec/map: incoming work for /triage.
      for (const t of tickets) issues.push({ id: idOf(t), label: t.num, ref: t.ref, title: t.title, cat: null, state: t.role, age: '', author: '', source: 'local', closed: t.status === 'done' });
    }
  }
  return { efforts, issues: issues.filter(i => !i.closed) };
}
