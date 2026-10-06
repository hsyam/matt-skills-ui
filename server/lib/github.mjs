// GitHub tracker via `gh`. Uses native sub-issues / blocked-by links when the
// GraphQL schema has them, and the skills' body conventions as fallback:
//   to-tickets: "## Parent\n#N", "## Blocked by\n- #N"; wayfinder: "Part of #N", "Blocked by: #N".
import { run, sections, listItems, firstParagraph, checkboxes } from './util.mjs';
import { parseMap } from './local.mjs';

const FULL = `number title body state createdAt updatedAt url author{login} assignees(first:5){nodes{login}} labels(first:20){nodes{name}} parent{number} subIssues(first:50){nodes{number}} blockedBy(first:20){nodes{number state}}`;
const LITE = `number title body state createdAt updatedAt url author{login} assignees(first:5){nodes{login}} labels(first:20){nodes{name}}`;

async function gql(cwd, owner, name, fields, after) {
  const q = `query($o:String!,$n:String!,$a:String){repository(owner:$o,name:$n){issues(first:100,after:$a,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{${fields}}}}}`;
  const args = ['api', 'graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `n=${name}`];
  if (after) args.push('-f', `a=${after}`);
  const r = await run('gh', args, { cwd, timeout: 30000 });
  if (!r.ok) return { error: r.stderr.trim() || 'gh api failed' };
  try { return { data: JSON.parse(r.stdout).data.repository.issues }; } catch (e) { return { error: 'bad gh response' }; }
}

export function parentFromBody(body) {
  const s = sections(body);
  const p = (s['parent'] || '').match(/#(\d+)/) || (body || '').match(/^\s*Part of\s+#(\d+)/im);
  return p ? +p[1] : null;
}
export function blockedFromBody(body) {
  const s = sections(body);
  const txt = s['blocked by'] ?? ((body || '').match(/^\s*\**Blocked by:?\**:?\s*(.+)$/im) || [])[1] ?? '';
  if (/none/i.test(txt) && !/#\d/.test(txt)) return [];
  return [...String(txt).matchAll(/#(\d+)/g)].map(m => +m[1]);
}
const age = iso => { const d = (Date.now() - Date.parse(iso)) / 864e5; return d < 1 ? Math.max(1, Math.round(d * 24)) + 'h' : Math.round(d) + 'd'; };

/** labelMap: {canonicalRole: actualLabel} from docs/agents/triage-labels.md */
export async function readGitHub(repo, { labelMap = {}, max = 300 } = {}) {
  const view = await run('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: repo });
  if (!view.ok) return { error: 'gh repo view failed: ' + view.stderr.split('\n')[0], efforts: [], issues: [] };
  const nwo = JSON.parse(view.stdout).nameWithOwner; const [owner, name] = nwo.split('/');
  let fields = FULL, nodes = [], after = null, native = true;
  while (nodes.length < max) {
    let r = await gql(repo, owner, name, fields, after);
    if (r.error && fields === FULL) { native = false; fields = LITE; r = await gql(repo, owner, name, fields, after); }
    if (r.error) return { error: r.error, efforts: [], issues: [], repo: nwo };
    nodes.push(...r.data.nodes);
    if (!r.data.pageInfo.hasNextPage) break; after = r.data.pageInfo.endCursor;
  }
  return { repo: nwo, native, ...classify(nodes, { labelMap, nwo }) };
}

export function classify(nodes, { labelMap = {}, nwo = '' } = {}) {
  const roleOf = Object.fromEntries(Object.entries(labelMap).map(([role, label]) => [label.toLowerCase(), role]));
  const by = new Map(nodes.map(n => [n.number, n]));
  const labels = n => (n.labels?.nodes || []).map(l => l.name);
  const parentOf = n => n.parent?.number ?? parentFromBody(n.body);
  const children = new Map();
  for (const n of nodes) { const p = parentOf(n); if (p && by.has(p)) (children.get(p) || children.set(p, []).get(p)).push(n); }
  for (const n of nodes) for (const c of n.subIssues?.nodes || []) { const cn = by.get(c.number); if (cn && !(children.get(n.number) || []).includes(cn)) (children.get(n.number) || children.set(n.number, []).get(n.number)).push(cn); }
  const isMap = n => labels(n).includes('wayfinder:map');
  const looksLikeSpec = n => /##\s*Problem Statement/i.test(n.body || '') && /##\s*User Stories/i.test(n.body || '');
  const recent = n => n.state === 'OPEN' || Date.now() - Date.parse(n.updatedAt) < 14 * 864e5;
  const used = new Set(), efforts = [];
  const ticketOf = (n) => {
    const nb = n.blockedBy?.nodes ? n.blockedBy.nodes.map(b => b.number) : [];
    const blocked = [...new Set([...nb, ...blockedFromBody(n.body)])];
    const lab = labels(n), type = (lab.find(l => l.startsWith('wayfinder:') && l !== 'wayfinder:map') || '').split(':')[1] || null;
    const cb = checkboxes(n.body);
    const role = lab.map(l => roleOf[l.toLowerCase()]).find(Boolean) || null;
    const status = n.state === 'CLOSED' ? 'done' : (n.assignees?.nodes?.length ? 'claimed' : 'open');
    return { id: '#' + n.number, label: '#' + n.number, ref: '#' + n.number, url: n.url, title: n.title, status, role, type, blockedBy: blocked.map(b => '#' + b), ac: cb.length ? cb.map(c => c.done ? 1 : 0) : null, acText: cb.map(c => c.text), assignees: (n.assignees?.nodes || []).map(a => a.login), source: 'github' };
  };
  for (const n of nodes) {
    const kids = children.get(n.number) || [];
    if (!(isMap(n) || kids.length || looksLikeSpec(n)) || !recent(n)) continue;
    used.add(n.number); kids.forEach(k => used.add(k.number));
    const tickets = kids.sort((a, b) => a.number - b.number).map(ticketOf);
    const ids = new Set(tickets.map(t => t.id)); tickets.forEach(t => t.blockedBy = t.blockedBy.filter(b => ids.has(b)));
    if (isMap(n)) efforts.push({ id: '#' + n.number, label: '#' + n.number, ref: '#' + n.number, url: n.url, kind: 'map', title: n.title, sub: '', source: 'github', closed: n.state === 'CLOSED', ...parseMap(n.body), tickets });
    else { const s = sections(n.body); efforts.push({ id: '#' + n.number, label: '#' + n.number, ref: '#' + n.number, url: n.url, kind: 'spec', title: n.title, sub: '', source: 'github', closed: n.state === 'CLOSED', summary: firstParagraph(s['problem statement'] || n.body, 240), stories: (s['user stories'] || '').split('\n').filter(l => /^\s*\d+\.\s+/.test(l)).length, tickets }); }
  }
  const issues = nodes.filter(n => n.state === 'OPEN' && !used.has(n.number)).map(n => {
    const lab = labels(n).map(l => l.toLowerCase());
    return { id: '#' + n.number, label: '#' + n.number, ref: '#' + n.number, url: n.url, title: n.title, cat: lab.includes('bug') ? 'bug' : lab.includes('enhancement') ? 'enhancement' : null,
      state: lab.map(l => roleOf[l]).find(Boolean) || null, age: age(n.createdAt), updated: age(n.updatedAt), author: n.author?.login || '', source: 'github' };
  });
  return { efforts, issues };
}
