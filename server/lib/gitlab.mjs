// GitLab tracker via `glab`. Basic support: native blocking links are not read
// (Premium-only API); edges come from the skills' body conventions.
import { run } from './util.mjs';
import { classify } from './github.mjs';

export async function readGitLab(repo, { labelMap = {} } = {}) {
  const r = await run('glab', ['issue', 'list', '--all', '-F', 'json', '--per-page', '100'], { cwd: repo, timeout: 30000 });
  if (!r.ok) return { error: 'glab issue list failed: ' + r.stderr.split('\n')[0], efforts: [], issues: [] };
  let list; try { list = JSON.parse(r.stdout); } catch { return { error: 'bad glab response', efforts: [], issues: [] }; }
  const nodes = list.map(i => ({
    number: i.iid, title: i.title, body: i.description || '', state: i.state === 'opened' ? 'OPEN' : 'CLOSED',
    createdAt: i.created_at, updatedAt: i.updated_at, url: i.web_url, author: { login: i.author?.username },
    assignees: { nodes: (i.assignees || []).map(a => ({ login: a.username })) }, labels: { nodes: (i.labels || []).map(n => ({ name: n })) },
  }));
  const out = classify(nodes, { labelMap });
  for (const e of out.efforts) { e.source = 'gitlab'; e.tickets.forEach(t => t.source = 'gitlab'); }
  out.issues.forEach(i => i.source = 'gitlab');
  return out;
}
