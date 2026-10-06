import path from 'node:path';
import { listDir } from './util.mjs';
import { readLocal } from './local.mjs';
import { readGitHub } from './github.mjs';
import { readGitLab } from './gitlab.mjs';
import { detectTracker, readLabelMap, readGlossary, readSetup, readSkills, readArtifacts, readProject } from './setup.mjs';

/** Match an issue title against .out-of-scope/<concept>.md names (all concept words present). */
export function oosMatch(title, concepts) {
  const t = title.toLowerCase();
  return concepts.find(c => c.split('-').filter(w => w.length > 2).every(w => t.includes(w))) || null;
}

export async function buildModel(repo, { remoteCache } = {}) {
  const tracker = await detectTracker(repo);
  const labelMap = await readLabelMap(repo);
  const [project, local, setup, skills, glossary, artifacts] = await Promise.all([
    readProject(repo), readLocal(repo), readSetup(repo, tracker), readSkills(repo), readGlossary(repo), readArtifacts(repo),
  ]);
  const warnings = [];
  let remote = { efforts: [], issues: [] };
  if (tracker.kind === 'github' || tracker.kind === 'gitlab') {
    remote = remoteCache?.value ?? remote;
    if (!remoteCache || remoteCache.stale) {
      const r = tracker.kind === 'github' ? await readGitHub(repo, { labelMap }) : await readGitLab(repo, { labelMap });
      if (r.error) warnings.push(r.error); else remote = r;
      if (remoteCache) { remoteCache.value = remote; remoteCache.stale = false; remoteCache.at = Date.now(); }
    }
    if (tracker.kind === 'github' && remote.native === false) warnings.push('GitHub sub-issues/dependencies API unavailable; edges come from issue bodies.');
  } else if (tracker.kind === 'other') warnings.push(`Issue tracker "${tracker.note}" isn't supported yet; only .scratch/ is shown.`);
  const concepts = (await listDir(path.join(repo, '.out-of-scope'))).filter(f => f.name.endsWith('.md')).map(f => f.name.replace(/\.md$/, ''));
  const issues = [...remote.issues, ...local.issues].map(i => ({ ...i, oos: i.state ? null : oosMatch(i.title, concepts) }));
  const efforts = [...local.efforts, ...remote.efforts];
  return { project: { ...project, tracker: tracker.kind, trackerConfigured: tracker.configured }, efforts, issues, setup, skills, glossary, artifacts, warnings, labelMap, generatedAt: new Date().toISOString() };
}
