// Theme precedence: board/CLI override (~/.matt-skills-ui/settings.json) > plugin option
// chosen at install (pluginConfigs in ~/.claude/settings.json) > "swiss".
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson, dataDir, THEMES } from './util.mjs';

export async function installTheme() {
  const s = await readJson(path.join(os.homedir(), '.claude', 'settings.json'), {});
  for (const [k, v] of Object.entries(s?.pluginConfigs || {})) {
    if (!k.startsWith('matt-skills-ui')) continue;
    const t = v?.theme ?? v?.options?.theme;
    if (THEMES.includes(t)) return t;
  }
  return null;
}
export async function readTheme() {
  const o = (await readJson(path.join(dataDir(), 'settings.json'), {}))?.theme;
  const inst = await installTheme();
  return { current: THEMES.includes(o) ? o : inst || 'swiss', override: THEMES.includes(o) ? o : null, install: inst || 'swiss' };
}
export async function writeThemeOverride(theme) {
  const f = path.join(dataDir(), 'settings.json'), s = await readJson(f, {});
  if (theme && THEMES.includes(theme)) s.theme = theme; else delete s.theme;
  await writeJson(f, s);
}
