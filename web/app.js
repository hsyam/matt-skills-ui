// Matt Skills UI: browser app. Renders the server's state (GET /api/state + SSE /api/events)
// in one of four themes and turns clicks into API calls.
import { bind, STATE, GLY, findT, effById, isDone, HITL, openBlockers, dependents, acDone, stateOf, glyph, nextFor, effortNext, issueNext, stageOf, layout, lint } from './engine.mjs';

/* ---------------- token + api ---------------- */
const qs = new URLSearchParams(location.search);
let TOKEN = qs.get('token') || sessionStorage.getItem('msu.token') || '';
if (qs.get('token')) { sessionStorage.setItem('msu.token', TOKEN); qs.delete('token'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '')); }
async function api(p, body) {
  const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'x-msu-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j;
}

/* ---------------- state ---------------- */
let ST = null, P = {}, EFFORTS = [], ISSUES = [], SETUP = [], SESSIONS = [], QUESTIONS = [], ARTIFACTS = [], GLOSSARY = {};
const VIEWS = ['chart', 'board', 'ledger', 'setup', 'triage', 'artifacts', 'glossary'];
const S = { view: VIEWS.includes(qs.get('view')) ? qs.get('view') : 'chart', scope: qs.get('scope') === 'all' ? 'atlas' : 'effort', eff: null, t: null, sess: 'main', dtab: 'q', wide: false, pal: null, palI: 0, vb: null, boot: true, drawn: new Set(), themeOpen: false, spawn: null };
const THEMES = { A: ['Swiss', 'strict grid · one red · orthogonal graph'], B: ['Terminal', 'warm TUI panes · tmux status bar'], C: ['Transit', 'efforts as metro lines · tickets as stations'], D: ['Toybox', 'neo-brutalist · chunky · hard shadows'] };
const TK = Object.keys(THEMES), SLUG = { A: 'swiss', B: 'terminal', C: 'transit', D: 'toybox' }, FROM_SLUG = { swiss: 'A', terminal: 'B', transit: 'C', toybox: 'D' };
const urlTheme = FROM_SLUG[qs.get('theme')] || (THEMES[qs.get('variant')] ? qs.get('variant') : null);
let V = urlTheme || FROM_SLUG[localStorage.getItem('msu.lastTheme')] || 'A';

function ingest(state) {
  const first = !ST; ST = state; bind(state);
  P = state.project; EFFORTS = state.efforts; ISSUES = state.issues; SETUP = state.setup; SESSIONS = state.sessions; QUESTIONS = state.questions; ARTIFACTS = state.artifacts; GLOSSARY = state.glossary || {};
  GL_RE = Object.keys(GLOSSARY).length ? new RegExp('\\b(' + Object.keys(GLOSSARY).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'g') : null;
  if (!urlTheme) { const t = FROM_SLUG[state.theme?.current]; if (t && t !== V) { V = t; S.vb = null; S.drawn.clear(); } try { localStorage.setItem('msu.lastTheme', SLUG[V]); } catch {} }
  if (!S.eff || !effById(S.eff)) { const e = EFFORTS.find(e => e.tickets.some(t => !isDone(t))) || EFFORTS[0]; S.eff = e?.id || null; S.vb = null; }
  if (S.t && !findT(S.t)[0]) S.t = null;
  if (!S.t && S.eff) { const e = effById(S.eff); S.t = e.tickets.find(t => ['ready', 'you', 'progress'].includes(stateOf(t, e)))?.id || e.tickets[0]?.id || null; }
  if (!SESSIONS.find(s => s.id === S.sess)) S.sess = 'main';
  if (first) S.boot = true;
  if (!S.pal && !S.spawn && !document.activeElement?.closest?.('input,textarea,select')) render();
  else renderSoon = true;
}
let renderSoon = false;

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let GL_RE = null;
const gl = s => GL_RE ? esc(s).replace(GL_RE, k => `<span class="gl" title="${esc(k + ': ' + GLOSSARY[k])}">${k}</span>`) : esc(s);
const SV = { done: 'var(--s-done)', progress: 'var(--s-progress)', ready: 'var(--s-ready)', blocked: 'var(--s-blocked)', you: 'var(--s-you)' };
const WHO = { you: ['You', 'var(--s-you)'], agent: ['Agent', 'var(--s-ready)'], wait: ['Waiting', 'var(--fg3)'], done: ['Done', 'var(--s-done)'] };
const who = w => `<span class="who" style="--c:${WHO[w][1]}">${WHO[w][0]}</span>`;
const st = s => `<span class="st" style="--c:${SV[s]}">${STATE[s]}</span>`;
const fuelColor = c => c > 150 ? 'var(--s-blocked)' : c > 110 ? 'var(--s-progress)' : 'var(--s-done)';
const advise = s => s.ctx == null ? 'context unknown' : s.ctx > 150 ? 'compact at the next boundary' : s.ctx > 110 ? `${150 - s.ctx}k to smart-zone edge` : 'plenty of room';
const healthPct = () => SETUP.length ? Math.round(SETUP.filter(s => s.st === 'ok' || s.st === 'info').length / SETUP.length * 100) : 0;
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const ECOLS = ['var(--e1)', 'var(--e2)', 'var(--e3)', 'oklch(60% .14 160)', 'oklch(62% .15 60)', 'oklch(52% .12 200)'];
const ecol = e => ECOLS[Math.max(0, EFFORTS.indexOf(e)) % ECOLS.length];
const enumOf = e => String(EFFORTS.indexOf(e) + 1);
const sourceCmd = t => t.source === 'github' ? `gh issue view ${t.ref.slice(1)}` : t.source === 'gitlab' ? `glab issue view ${t.ref.slice(1)}` : t.ref;

/* ======================= CHART (themed renderers) ======================= */
const G = { A: { cw: 214, rh: 104, hw: 10 }, B: { cw: 222, rh: 68, hw: 86 }, C: { cw: 176, rh: 96, hw: 10 }, D: { cw: 214, rh: 84, hw: 84 } };
function wrap2(s, n = 24) { if (s.length <= n) return [s, '']; let i = s.lastIndexOf(' ', n); if (i < 6) { const j = s.indexOf(' ', n); i = j > 0 && j <= n + 6 ? j : n; } return [s.slice(0, i), trunc(s.slice(i).trim(), n)]; }
function edgePath(x1, y1, x2, y2) {
  const g = G[V];
  if (V === 'A' || V === 'B') { const mx = V === 'A' ? (x1 + x2) / 2 : x2 - 24; return Math.abs(y1 - y2) < 1 ? `M${x1},${y1} H${x2}` : `M${x1},${y1} H${mx} V${y2} H${x2}`; }
  if (V === 'C') { const adx = Math.abs(y2 - y1); if (adx < 1) return `M${x1},${y1} H${x2}`; const xs = Math.max(x1 + 14, x2 - 14 - adx); return `M${x1},${y1} H${xs} L${x2 - 14},${y2} H${x2}`; }
  const dx = Math.max(18, (x2 - x1) * .5); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
function road(cls, d, e) {
  if (V !== 'C') return `<path class="road ${cls}" d="${d}"/>`;
  const c = ecol(e);
  if (cls.includes('live')) return `<path class="road live" d="${d}" stroke="${c}"/><path class="road hollow dashed" d="${d}"/>`;
  return `<path class="road ${cls}" d="${d}" stroke="${c}"/>`;
}
function node(t, e, x, y, i) {
  const s = stateOf(t, e), c = SV[s], on = S.t === t.id, live = ['ready', 'you'].includes(s);
  const head = `<g class="wp s-${s} ${on ? 'on' : ''}" data-t="${esc(t.id)}" transform="translate(${x},${y})" style="--i:${i}"><title>${esc(t.title)} · ${STATE[s]}</title>`;
  if (V === 'A') { const [l1, l2] = wrap2(t.title, 24);
    return head + `${on ? '<rect class="sel" x="-15" y="-15" width="30" height="30"/>' : ''}${live ? `<rect class="pulse" x="-9" y="-9" width="18" height="18" stroke="${c}"/>` : ''}<rect class="mk" x="-9" y="-9" width="18" height="18" fill="${c}"/><text class="lid" y="30">${esc(t.label)} — ${STATE[s]}</text><text class="ln" y="47">${esc(l1)}</text>${l2 ? `<text class="ln" y="63">${esc(l2)}</text>` : ''}</g>`; }
  if (V === 'B') return head + `<rect class="box" x="-86" y="-22" width="172" height="44" stroke="${c}"/>${on ? '<text class="caret" x="-100" y="5">▶</text>' : ''}<text class="lid" x="-78" y="-5" style="fill:${c}">${glyph(t, s)} ${esc(t.label)} ${STATE[s].toLowerCase()}</text><text class="ln" x="-78" y="13">${esc(trunc(t.title, 23))}</text>${live ? `<rect class="cursor" x="72" y="3" width="7" height="13" fill="${c}"/>` : ''}</g>`;
  if (V === 'C') { const ec = ecol(e), [l1, l2] = wrap2(t.title, 20);
    return head + `${live ? `<circle class="pulse" r="11" stroke="${c}"/>` : ''}${on ? '<circle class="sel" r="17"/>' : ''}<circle class="stn" r="9" fill="${s === 'done' ? ec : 'var(--bg)'}" stroke="${ec}"/>${s !== 'done' ? `<circle r="3.8" fill="${c}"/>` : ''}<text class="ln" y="31">${esc(l1)}</text>${l2 ? `<text class="ln" y="47">${esc(l2)}</text>` : ''}<text class="lid" y="${l2 ? 62 : 46}">${esc(t.label)} · ${STATE[s]}</text></g>`; }
  return head + `<rect class="shadow" x="-80" y="-21" width="168" height="50" rx="11"/><rect class="card" x="-84" y="-25" width="168" height="50" rx="11" fill="${c}"/>${live ? `<g class="sticker" transform="translate(78,-24)"><circle r="14"/><text y="3.5">${s === 'you' ? 'YOU' : 'GO!'}</text></g>` : ''}<text class="ln" x="-72" y="-3">${esc(trunc(t.title, 21))}</text><text class="lid" x="-72" y="14">${glyph(t, s)} ${esc(t.label)} · ${STATE[s]}</text></g>`;
}
function endMarker(x, y, title, sub) {
  sub = sub || '';
  if (V === 'A') return `<g transform="translate(${x},${y})"><rect x="-10" y="-10" width="20" height="20" fill="var(--fg)"/><text x="20" y="5" style="font-weight:900;font-size:18px;letter-spacing:-.03em;fill:var(--fg)">${title} →</text><text x="20" y="23" style="font-size:11.5px;fill:var(--fg2)">${esc(trunc(sub, 46))}</text></g>`;
  if (V === 'B') return `<g transform="translate(${x},${y})"><rect x="-6" y="-22" width="230" height="44" fill="var(--bg2)" stroke="var(--accent)" stroke-dasharray="4 3"/><text x="4" y="-4" style="font-size:11.5px;fill:var(--accent)">◎ ${title.toLowerCase()}</text><text x="4" y="13" style="font-size:10.5px;fill:var(--fg2)">${esc(trunc(sub, 34))}</text></g>`;
  if (V === 'C') return `<g transform="translate(${x},${y})"><circle r="15" fill="var(--bg)" stroke="var(--fg)" stroke-width="5"/><circle r="6" fill="var(--fg)"/><text y="38" text-anchor="middle" style="font-family:'Barlow Condensed';font-weight:700;font-size:17px;text-transform:uppercase;fill:var(--fg)">${title}</text><text y="54" text-anchor="middle" style="font-size:11px;fill:var(--fg2)">${esc(trunc(sub, 40))}</text></g>`;
  const pts = Array.from({ length: 20 }, (_, k) => { const a = k / 20 * Math.PI * 2, r = k % 2 ? 26 : 40; return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`; }).join(' ');
  return `<g transform="translate(${x + 30},${y})"><polygon points="${pts}" transform="translate(4,4)" fill="var(--fg)"/><polygon points="${pts}" fill="var(--s-progress)" stroke="var(--fg)" stroke-width="2.5"/><text text-anchor="middle" y="5" style="font-weight:800;font-size:13px;fill:var(--fg)">${title.toUpperCase()}</text><text x="50" y="5" style="font-size:12px;font-weight:600;fill:var(--fg2)">${esc(trunc(sub, 36))}</text></g>`;
}
function fogBlock(fog, x, y) {
  if (V === 'A') return `<g transform="translate(${x},${y})"><rect class="fogA" width="230" height="${30 + fog.length * 20}"/><text x="12" y="22" style="font-weight:800;font-size:12px;letter-spacing:.06em;text-transform:uppercase;fill:var(--fg)">Not yet specified</text>${fog.map((f, k) => `<text x="12" y="${44 + k * 20}" style="font-size:12px;fill:var(--fg2);paint-order:stroke;stroke:var(--bg);stroke-width:4px">— ${esc(trunc(f, 32))}</text>`).join('')}</g>`;
  if (V === 'B') return `<g transform="translate(${x},${y})"><text style="font-size:11px;fill:var(--fg3)">-- not yet specified --</text>${fog.map((f, k) => `<text y="${20 + k * 18}" style="font-size:11.5px;fill:var(--fg2)">░ ${esc(trunc(f, 30))}</text>`).join('')}</g>`;
  return `<g transform="translate(${x},${y})">${fog.map((f, k) => `<g transform="translate(${k % 2 * 24},${k * 54}) rotate(${k % 2 ? 2 : -2})"><rect width="210" height="40" rx="10" fill="var(--bg)" stroke="var(--fg)" stroke-width="2" stroke-dasharray="6 5"/><text x="12" y="25" style="font-size:12.5px;font-weight:600;fill:var(--fg2)">??? ${esc(trunc(f, 26))}</text></g>`).join('')}</g>`;
}
function drawEffort(e, ox, oy) {
  const g = G[V], { cols, crit } = layout(e), pos = {}, maxRows = Math.max(1, ...cols.map(c => c.length));
  cols.forEach((c, i) => { const off = (maxRows - c.length) * g.rh / 2; c.forEach((t, j) => pos[t.id] = { x: ox + i * g.cw, y: oy + off + j * g.rh }); });
  let roads = '', marks = '', extra = '', k = 0;
  const w = Math.max(0, cols.length - 1) * g.cw, h = (maxRows - 1) * g.rh, cy = oy + h / 2, fog = e.fog || [];
  e.tickets.forEach(t => t.blockedBy.forEach(b => { const a = pos[b], z = pos[t.id]; if (!a || !z) return;
    const cls = isDone(findT(b)[0]) ? (isDone(t) ? 'solid' : 'open') : 'live';
    roads += road(`${cls} ${crit.has(b + '>' + t.id) && cls !== 'solid' ? 'crit' : ''}`, edgePath(a.x + g.hw, a.y, z.x - g.hw, z.y), e); }));
  e.tickets.forEach(t => marks += node(t, e, pos[t.id].x, pos[t.id].y, k++));
  let x1 = ox + w + g.hw, y0 = oy - 40, y1 = oy + h + 80;
  const last = cols[cols.length - 1] || [];
  if (e.kind === 'map') {
    if (V === 'C') {
      let px = ox + w + g.cw;
      last.forEach(t => roads += `<path class="road planned dashed" d="${edgePath(pos[t.id].x + g.hw, pos[t.id].y, px - 10, cy)}"/>`);
      fog.forEach((f, j) => { const [l1, l2] = wrap2(f, 18); extra += `<g transform="translate(${px},${cy})"><circle r="8" fill="var(--bg)" stroke="var(--line2)" stroke-width="3.5" stroke-dasharray="3 3"/><text y="${j % 2 ? -46 : 30}" text-anchor="middle" style="font-style:italic;font-size:12.5px;fill:var(--fg3)">${esc(l1)}</text>${l2 ? `<text y="${j % 2 ? -31 : 45}" text-anchor="middle" style="font-style:italic;font-size:12.5px;fill:var(--fg3)">${esc(l2)}</text>` : ''}</g>`;
        roads += `<path class="road planned dashed" d="M${px + 10},${cy} H${px + g.cw - 10}"/>`; px += g.cw; });
      if (fog.length) extra += `<text x="${ox + w + g.cw - 10}" y="${cy - 70}" style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;fill:var(--fg3)">Planned extension · not yet specified</text>`;
      extra += endMarker(px + 10, cy, 'Destination', e.destination); x1 = px + 160;
    } else {
      const fx = ox + w + g.cw * .75, fh = V === 'D' ? fog.length * 54 : 30 + fog.length * 20;
      if (fog.length) { last.forEach(t => roads += `<path class="road open dashed" style="stroke-dasharray:2 6" d="${edgePath(pos[t.id].x + g.hw, pos[t.id].y, fx - 8, cy)}"/>`); extra += fogBlock(fog, fx, cy - fh / 2); }
      const dx = fog.length ? fx + (V === 'D' ? 300 : 280) : fx + 40;
      roads += fog.length ? `<path class="road open dashed" style="stroke-dasharray:2 6" d="M${fx + (V === 'D' ? 236 : 240)},${cy} H${dx - 14}"/>` : last.map(t => `<path class="road open dashed" style="stroke-dasharray:2 6" d="${edgePath(pos[t.id].x + g.hw, pos[t.id].y, dx - 14, cy)}"/>`).join('');
      extra += endMarker(dx, cy, 'Destination', e.destination); x1 = dx + 260;
    }
    if ((e.oos || []).length) extra += `<text x="${ox - 12}" y="${oy + h + 88}" style="font-size:12px;fill:var(--fg3);font-style:italic">Out of scope: ${esc(e.oos.map(o => o.title + (o.why ? ' (' + o.why + ')' : '')).join('; '))}</text>`;
    y1 = oy + h + 100;
  } else if (e.tickets.length) {
    const dx = ox + w + g.cw * (V === 'B' ? 1 : .85);
    last.forEach(t => roads += V === 'C' ? `<path class="road planned dashed" d="${edgePath(pos[t.id].x + g.hw, pos[t.id].y, dx - 15, cy)}"/>` : `<path class="road open dashed" style="stroke-dasharray:2 6" d="${edgePath(pos[t.id].x + g.hw, pos[t.id].y, dx - (V === 'B' ? 8 : 14), cy)}"/>`);
    extra += endMarker(dx, cy, 'Ship', '/code-review, then /pr, then /retro'); x1 = dx + 250;
  }
  return { svg: extra + roads + marks, box: { x0: ox - g.hw - 70, y0, x1: x1 + 30, y1 } };
}
function frame(e, box, title, sub, idx) {
  const { x0, y0, x1, y1 } = box, de = e ? `data-eff="${esc(e.id)}"` : '';
  if (V === 'A') return `<line x1="${x0}" x2="${x1}" y1="${y0 - 56}" y2="${y0 - 56}" stroke="var(--fg)" stroke-width="2"/><text class="rgt" x="${x0}" y="${y0 - 22}" ${de} style="cursor:pointer">${esc(title)}</text><text class="rgs" x="${x1}" y="${y0 - 26}" text-anchor="end">${esc(sub)}</text>`;
  if (V === 'B') return `<rect x="${x0}" y="${y0 - 40}" width="${x1 - x0}" height="${y1 - y0 + 50}" fill="none" stroke="var(--line2)"/><rect x="${x0 + 14}" y="${y0 - 50}" width="${(title.length + sub.length + 8) * 7.4}" height="20" fill="var(--bg)"/><text x="${x0 + 20}" y="${y0 - 36}" style="font-size:12px;fill:var(--accent);cursor:pointer" ${de}>┤ ${esc(title.toLowerCase())} <tspan style="fill:var(--fg3)">${esc(sub)}</tspan> ├</text>`;
  if (V === 'C') return `<g transform="translate(${x0 + 14},${y0 - 30})" ${de} style="cursor:pointer"><circle r="16" fill="${e ? ecol(e) : 'var(--e4)'}"/><text y="6" text-anchor="middle" style="font-family:'Barlow Condensed';font-weight:700;font-size:17px;fill:#fff">${idx}</text><text x="26" y="7" style="font-family:'Barlow Condensed';font-weight:700;font-size:22px;text-transform:uppercase;fill:var(--fg)">${esc(title)}</text><text x="28" y="24" class="rgs">${esc(sub)}</text></g>`;
  return `<rect x="${x0 + 5}" y="${y0 - 51}" width="${x1 - x0}" height="${y1 - y0 + 60}" rx="22" fill="var(--fg)"/><rect x="${x0}" y="${y0 - 56}" width="${x1 - x0}" height="${y1 - y0 + 60}" rx="22" fill="${e ? `color-mix(in oklch,${ecol(e)} 35%,var(--bg))` : 'var(--bg2)'}" stroke="var(--fg)" stroke-width="2.5"/><text x="${x0 + 22}" y="${y0 - 20}" style="font-weight:800;font-size:24px;fill:var(--fg);letter-spacing:-.02em;cursor:pointer" ${de}>${esc(title)}</text><text x="${x0 + 24}" y="${y0 - 4}" class="rgs">${esc(sub)}</text>`;
}
const effSub = e => `${e.label} · ${e.kind === 'map' ? 'wayfinder map' : 'spec'} · ${e.tickets.filter(isDone).length} of ${e.tickets.length} ${e.kind === 'map' ? 'resolved' : 'done'}`;
function chartView() {
  let body = '', box;
  if (S.scope === 'effort') {
    const e = effById(S.eff);
    if (!e.tickets.length) {
      body = `<text class="rgt" text-anchor="middle" y="-10">${esc(e.title)}: no tickets yet</text><text text-anchor="middle" y="18" style="font-size:14px;fill:var(--fg2)">${e.kind === 'map' ? 'The map has no decision tickets yet.' : 'The spec is published. Cut it into tracer-bullet tickets to see its graph here.'}</text><text text-anchor="middle" y="48" style="font-family:'JetBrains Mono';font-size:13px;fill:var(--s-you)">${esc(effortNext(e).cmd || '')}</text>`;
      box = { x0: -360, y0: -140, x1: 360, y1: 140 };
    } else { const r = drawEffort(e, 0, 0); body = r.svg; box = r.box; }
  } else {
    let y = 0, x0 = Infinity, x1 = -Infinity, ytop = null;
    for (const e of EFFORTS.filter(e => e.tickets.length)) {
      const r = drawEffort(e, 0, y); if (ytop == null) ytop = r.box.y0;
      body += frame(e, { x0: r.box.x0 + 40, y0: r.box.y0, x1: r.box.x1, y1: r.box.y1 }, e.title, effSub(e), enumOf(e)) + r.svg;
      x0 = Math.min(x0, r.box.x0); x1 = Math.max(x1, r.box.x1); y = r.box.y1 + 150;
    }
    if (ytop == null) { ytop = 0; x0 = -80; x1 = 900; }
    let gx = x0 + 60;
    for (const e of EFFORTS.filter(e => !e.tickets.length)) {
      const gbox = { x0: gx, y0: y, x1: gx + 380, y1: y + 70 };
      body += frame(e, gbox, e.title, `${e.label} · ${e.kind} · no tickets`, enumOf(e)) + `<text x="${gx + (V === 'C' ? 40 : 24)}" y="${y + 40}" style="font-size:13px;fill:var(--fg2)">Published, waiting to be cut.</text><text x="${gx + (V === 'C' ? 40 : 24)}" y="${y + 62}" data-eff="${esc(e.id)}" style="cursor:pointer;font-family:'JetBrains Mono';font-size:12.5px;fill:var(--s-you)">${esc(effortNext(e).cmd || '')}</text>`;
      gx += 470;
    }
    if (ISSUES.length) {
      const tbox = { x0: gx, y0: y, x1: gx + Math.max(430, 60 + ISSUES.length * 78), y1: y + 70 };
      body += frame(null, tbox, 'Incoming issues', 'triage · ' + ISSUES.length + ' open', 'T') + ISSUES.map((i, k) => { const n = issueNext(i), c = i.state === 'ready-for-agent' ? 'var(--s-ready)' : n.who === 'you' ? 'var(--s-you)' : 'var(--fg3)';
        return `<g data-view="triage" style="cursor:pointer" transform="translate(${tbox.x0 + 34 + k * 78},${y + 40})"><title>${esc(i.label + ' ' + i.title)}</title><circle r="8" fill="${c}" stroke="var(--fg)" stroke-width="${V === 'D' ? 2 : 0}"/><text y="26" text-anchor="middle" style="font-family:'JetBrains Mono';font-size:10.5px;fill:var(--fg2)">${esc(i.label)}</text></g>`; }).join('');
      gx = tbox.x1 + 90;
    }
    box = { x0: x0 - 10, y0: ytop - 80, x1: Math.max(x1, gx) + 20, y1: y + 120 };
  }
  const key = V + S.scope + S.eff;
  if (!S.vb || S.vbKey !== key) { S.vb = { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 }; S.vbKey = key; S.vbFresh = true; }
  const draw = !S.drawn.has(key); S.drawn.add(key);
  return `<div class="chart"><svg id="chartsvg" viewBox="${S.vb.x} ${S.vb.y} ${S.vb.w} ${S.vb.h}" preserveAspectRatio="xMidYMid meet">
      <defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="var(--bg)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--line)" stroke-width="3"/></pattern></defs>
      <g class="${draw ? 'draw' : ''}">${body}</g></svg>
    <div class="legend">${Object.keys(STATE).map(s => `<span><i style="background:${SV[s]};${V === 'A' ? 'border-radius:0' : ''}"></i>${STATE[s]}</span>`).join('')}<span class="faint">· dashed = live block · thick = critical path · drag to pan, scroll to zoom</span></div>
    <div class="zoom"><button data-z=".8" title="Zoom in">＋</button><button data-z="1.25" title="Zoom out">−</button><button data-z="fit" title="Fit">⌂</button></div></div>`;
}

/* ======================= BOARD ======================= */
const BCOLS = [['unshaped', 'Not yet specified', 'var(--fg3)'], ['blocked', 'Blocked', 'var(--s-blocked)'], ['ready', 'Ready', 'var(--s-ready)'], ['progress', 'In progress', 'var(--s-progress)'], ['you', 'Your move', 'var(--s-you)'], ['done', 'Done', 'var(--s-done)']];
const agentOf = t => SESSIONS.find(s => s.ticket === t.id && ['running', 'waiting', 'starting'].includes(s.st));
function tagHTML(t, e) {
  const s = stateOf(t, e), ag = agentOf(t);
  if (s === 'done') return `<div class="tag mini" data-t="${esc(t.id)}"><div class="nm">${esc(t.title)}</div></div>`;
  return `<div class="tag ${S.t === t.id ? 'sel' : ''}" data-t="${esc(t.id)}" style="--c:${SV[s]}">${V === 'C' ? `<span class="ln-badge" style="background:${ecol(e)}"></span>` : ''}<div class="i">${t.type ? GLY[t.type] + ' ' : ''}${esc(t.label)}${ag ? `<span class="a">◐ ${esc(ag.id)}</span>` : t.status === 'claimed' ? `<span class="a" style="color:var(--s-you)">◆ claimed</span>` : ''}</div>
    <div class="nm">${gl(t.title)}</div><div class="bl">${t.blockedBy.map(b => { const bt = findT(b)[0]; return bt ? `<span class="chip ${isDone(bt) ? 'closed' : 'open'}" title="${esc(bt.title)}">${esc(bt.label)}</span>` : ''; }).join('')}${t.ac ? `<span class="faint mono" style="font-size:10px;margin-left:auto">${acDone(t)}/${t.ac.length}</span>` : ''}</div></div>`;
}
function boardView() {
  const lanes = [...(S.scope === 'effort' && S.eff ? [effById(S.eff)] : EFFORTS), ...(ISSUES.length ? ['issues'] : [])];
  const cell = (lane, col) => {
    if (lane === 'issues') {
      const f = { unshaped: i => !i.state || i.state === 'needs-triage' || i.state === 'needs-info', ready: i => i.state === 'ready-for-agent', you: i => i.state === 'ready-for-human' }[col];
      return f ? ISSUES.filter(f).map(i => `<div class="tag" data-iss="${esc(i.id)}" style="--c:var(--bg)"><div class="i">${esc(i.label)}<span class="a" style="color:var(--fg3)">${i.cat || 'unlabeled'}</span></div><div class="nm">${gl(i.title)}</div><div class="bl">${i.oos ? '<span class="chip open">out of scope?</span>' : ''}<span class="chip">${i.state || 'new'}</span></div></div>`).join('') : '';
    }
    const e = lane;
    if (col === 'unshaped') return e.kind === 'map' ? (e.fog || []).map(f => `<div class="tag fog">${esc(f)}</div>`).join('') : (!e.tickets.length ? `<div class="tag fog">No tickets yet. Waiting to be cut into slices.</div>` : '');
    return e.tickets.filter(t => stateOf(t, e) === col).map(t => tagHTML(t, e)).join('');
  };
  const count = col => lanes.reduce((n, l) => n + (cell(l, col).match(/class="tag/g) || []).length, 0);
  return `<div class="board"><div class="bgrid" id="bgrid">
    <div class="bh" style="left:0;position:sticky;z-index:5;background:var(--bg2)"><span class="lbl">Effort</span></div>
    ${BCOLS.map(([k, l, c]) => `<div class="bh"><span class="sw" style="background:${c}"></span>${l}<span class="n">${count(k)}</span></div>`).join('')}
    ${lanes.map(l => `<div class="lane">${l === 'issues' ? `<span class="lbl">triage</span><span class="n">${V === 'C' ? '<span class="roundel" style="background:var(--e4)">T</span>' : ''}Incoming issues</span><span class="mono">${esc(P.tracker)} · /triage</span>`
      : `<span class="lbl">${l.kind === 'map' ? 'wayfinder' : 'spec'}</span><span class="n" data-eff="${esc(l.id)}" style="cursor:pointer">${V === 'C' ? `<span class="roundel" style="background:${ecol(l)}">${enumOf(l)}</span>` : ''}${esc(l.title)}</span><span class="mono">${esc(l.label)}</span><br>${effortNext(l).cmd ? `<span class="c" data-act="copy" data-cmd="${esc(effortNext(l).cmd)}">${esc(trunc(effortNext(l).cmd, 30))}</span>` : ''}`}</div>
      ${BCOLS.map(([k]) => `<div class="cell">${cell(l, k)}</div>`).join('')}`).join('')}
    <svg class="threads" id="threads"></svg></div></div>`;
}

/* ======================= LEDGER + SUB-VIEWS ======================= */
function ledgerView() {
  const e = effById(S.eff);
  if (!e.tickets.length) return `<div class="pane"><p class="empty">Nothing to list yet. <span class="cmd">${esc(effortNext(e).cmd || '')}</span></p></div>`;
  const problems = lint(e);
  return `<div class="pane">${problems.length ? `<div class="banner" style="margin:0 0 12px">${problems.map(esc).join('<br>')}</div>` : ''}<table class="ledger"><thead><tr><th class="lbl">Ticket</th><th class="lbl">State</th><th class="lbl">Blocked by</th><th class="lbl">${e.kind === 'map' ? 'Type' : 'Criteria'}</th><th class="lbl">Next</th></tr></thead><tbody>
    ${e.tickets.map(t => { const s = stateOf(t, e), n = nextFor(t, e); return `<tr data-t="${esc(t.id)}" class="${S.t === t.id ? 'sel' : ''}"><td><span class="id">${esc(t.label)}</span> ${gl(t.title)}</td><td>${st(s)}</td>
      <td>${openBlockers(t, e).map(b => `<span class="chip open" title="${esc(b.title)}">${esc(b.label)}</span>`).join(' ') || '<span class="faint">nothing</span>'}</td>
      <td>${e.kind === 'map' ? (t.type ? `${GLY[t.type]} ${t.type} <span class="faint">· ${HITL(t) ? 'needs you' : 'agent'}</span>` : '<span class="faint">no type</span>') : t.ac ? `<span class="mono" style="font-size:11.5px">${acDone(t)} / ${t.ac.length}</span>` : '<span class="faint">—</span>'}</td>
      <td>${n.cmd ? `<span class="cmd">${esc(trunc(n.cmd, 48))}</span>` : who(n.who)}</td></tr>`; }).join('')}</tbody></table>
    ${e.kind === 'map' ? `<h3 class="lbl">Decisions so far</h3>${(e.decisions || []).map(d => `<p style="margin:4px 0"><b>${esc(d.title)}</b> ${esc(d.gist)}</p>`).join('') || '<p class="faint">None yet.</p>'}<h3 class="lbl">Notes</h3><p class="muted" style="margin:0">${esc(e.notes || '—')}</p>` : ''}</div>`;
}
function setupView() {
  const sk = ST.skills || { user: [], model: [] };
  return `<div class="pane"><h2>Skills setup</h2><p class="lede">What <span class="cmd">/setup-matt-pocock-skills</span> wrote in ${esc(P.name)}, and what the other skills will find when they look.</p>
    <div class="manifest">${SETUP.map(s => `<div style="color:${s.st === 'ok' ? 'var(--s-done)' : s.st === 'warn' ? 'var(--s-progress)' : s.st === 'missing' ? 'var(--s-blocked)' : 'var(--fg3)'}">${s.st === 'ok' ? '●' : s.st === 'warn' ? '▲' : s.st === 'missing' ? '○' : '·'}</div>
      <div><b>${esc(s.label)}</b><div class="mono faint" style="font-size:11px">${esc(s.file)}</div></div><div class="muted">${esc(s.detail)}</div><div>${s.fix ? `<button class="btn" data-act="send" data-cmd="${esc(s.fix)}">Send ${esc(s.fix)}</button>` : ''}</div>`).join('')}</div>
    <h3 class="lbl">mattpocock/skills ${sk.source ? '· ' + esc(sk.source) : '· not detected'}</h3>
    <p class="faint" style="margin:0 0 6px;font-size:12px">You type these ${sk.user.some(s => !s.installed) ? '(struck through = not installed)' : ''}</p><div class="skills">${sk.user.map(s => `<span class="u" style="${s.installed ? '' : 'text-decoration:line-through;opacity:.5'}">/${s.name}</span>`).join('')}</div>
    <p class="faint" style="margin:12px 0 6px;font-size:12px">Agents use these on their own</p><div class="skills">${sk.model.map(s => `<span style="${s.installed ? '' : 'text-decoration:line-through;opacity:.5'}">${s.name}</span>`).join('')}</div></div>`;
}
function triageView() {
  const b = [['Never triaged', ISSUES.filter(i => !i.state)], ['needs-triage', ISSUES.filter(i => i.state === 'needs-triage')], ['needs-info', ISSUES.filter(i => i.state === 'needs-info')], ['Triaged', ISSUES.filter(i => ['ready-for-agent', 'ready-for-human'].includes(i.state))]];
  return `<div class="pane"><h2>Triage</h2><p class="lede">Issues you didn’t write. Tickets from /to-tickets are already agent-ready and never land here.</p>
    ${ISSUES.length ? '' : '<p class="empty">No incoming issues.</p>'}
    ${b.map(([h, l]) => l.length ? `<h3 class="lbl">${h} · ${l.length}</h3><table class="ledger"><tbody>${l.map(i => { const n = issueNext(i); return `<tr><td style="width:64px" class="id">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener" class="extlink">${esc(i.label)}</a>` : esc(i.label)}</td><td>${gl(i.title)}<div class="faint" style="font-size:11.5px">${i.author ? '@' + esc(i.author) + ' · ' : ''}${esc(i.age || '')}${i.cat ? ' · ' + i.cat : ''} · ${esc(n.text)}</div></td><td style="width:220px;text-align:right">${n.cmd ? `<button class="btn ${n.spawn ? 'go' : ''}" data-act="${n.spawn ? 'spawn' : 'send'}" data-cmd="${esc(n.cmd)}" data-ref="${esc(i.id)}">${n.spawn ? 'Spawn ' : 'Send '}${esc(trunc(n.cmd, 26))}</button>` : who(n.who)}</td></tr>`; }).join('')}</tbody></table>` : '').join('')}</div>`;
}
function artifactsView() {
  return `<div class="pane"><h2>Artifacts</h2><p class="lede">What the skills left behind: prototype and research branches, reports and handoffs in the temp folder, decisions in ADRs.</p>
    ${ARTIFACTS.length ? `<table class="ledger"><tbody>${ARTIFACTS.map(a => `<tr><td style="width:30px;font-size:16px;color:var(--fg2)">${a.g}</td><td><b>${esc(a.title)}</b><div class="mono faint" style="font-size:11px">${esc(a.ref)}</div></td><td class="lbl" style="width:110px">${a.kind}</td><td style="width:70px"><button class="btn quiet" data-act="copy" data-cmd="${esc(a.ref.replace(/^branch /, ''))}">Copy</button></td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nothing yet. /prototype, /research, /improve-codebase-architecture, /handoff and /to-questionnaire leave their output here.</p>'}</div>`;
}
function glossaryView() {
  const adrs = ARTIFACTS.filter(a => a.kind === 'adr');
  return `<div class="pane"><h2>Glossary</h2><p class="lede">From <span class="mono">GLOSSARY.md</span>. These terms are underlined wherever they appear; hover to read the definition.</p>
    ${Object.keys(GLOSSARY).length ? `<div class="lexicon">${Object.entries(GLOSSARY).map(([k, v]) => `<dl><dt>${esc(k)}</dt><dd>${esc(v)}</dd></dl>`).join('')}</div>` : '<p class="empty">No glossary yet. /grill-with-docs builds it as terms get resolved.</p>'}
    <h3 class="lbl">Decision records · ${adrs.length}</h3>${adrs.map(a => `<p style="margin:3px 0"><span class="mono faint" style="font-size:11px">${esc(a.ref)}</span> ${esc(a.title)}</p>`).join('') || '<p class="faint">None yet.</p>'}</div>`;
}

/* ======================= SHELL ======================= */
function routeLine(e) {
  const F = e.kind === 'map' ? [['chart', '/wayfinder'], ['resolve', '/wayfinder ' + e.ref], ['collapse', '/to-spec'], ['tickets', '/to-tickets'], ['implement', '/implement-spec']]
    : [['grill', '/grill-with-docs'], ['prototype', '/prototype'], ['spec', '/to-spec'], ['tickets', '/to-tickets'], ['implement', '/implement-spec'], ['review', '/code-review'], ['pr', '/pr'], ['retro', '/retro']];
  const cur = F.findIndex(s => s[0] === stageOf(e));
  return `<div class="route">${F.map((s, i) => `<div class="stn ${i < cur ? 'past' : i === cur ? 'cur' : 'fut'}" title="${esc(s[1])}"><span class="dot"></span><b>${s[0]}</b></div>`).join('')}</div>`;
}
function nextBlock(n, t) {
  return `<div class="next"><div class="t"><span class="lbl" style="color:var(--accent)">Next</span>${who(n.who)}</div><p>${esc(n.text)}</p>
    ${n.cmd ? `<span class="cmd" title="${esc(n.cmd)}">${esc(trunc(n.cmd, 44))}</span>` : ''}
    ${(n.cmd || n.watch) ? `<div class="acts">${n.spawn ? `<button class="btn go" data-act="spawn" data-cmd="${esc(n.cmd)}" data-ref="${esc(t ? t.id : n.t || '')}">Spawn agent</button>` : ''}${n.cmd ? `<button class="btn" data-act="send" data-cmd="${esc(n.cmd)}">Send to main</button><button class="btn quiet" data-act="copy" data-cmd="${esc(n.cmd)}">Copy</button>` : ''}${n.watch ? `<button class="btn" data-act="watch" data-s="${esc(n.watch)}">Follow ${esc(n.watch)}</button>` : ''}</div>` : ''}</div>`;
}
function notesHTML() {
  const [t, e] = findT(S.t);
  if (!t) return `<p class="empty">Select a ticket on the chart, board or ledger.</p>`;
  const s = stateOf(t, e), n = nextFor(t, e), deps = dependents(t, e);
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="ref">${esc(t.label)} · ${e.kind === 'map' ? 'decision ticket' : 'ticket'}</span><span class="stamp" style="--c:${SV[s]}">${STATE[s]}</span></div>
    <h2>${gl(t.title)}</h2>
    <div class="faint" style="font-size:12px">in <a data-eff="${esc(e.id)}" style="cursor:pointer;color:var(--fg2);text-decoration:underline">${esc(e.title)}</a>${t.type ? ` · ${GLY[t.type]} ${t.type}, ${HITL(t) ? 'needs you' : 'agent alone'}` : ''}${t.role ? ` · ${esc(t.role)}` : ''}</div>
    ${nextBlock(n, t)}
    <dl class="facts"><dt>Blocked by</dt><dd>${t.blockedBy.map(b => { const bt = findT(b)[0]; return bt ? `<span class="chip ${isDone(bt) ? 'closed' : 'open'}" data-t="${esc(b)}" title="${esc(bt.title)}">${esc(bt.label)}</span>` : ''; }).join('') || '<span class="faint">nothing, it’s ready</span>'}</dd>
      <dt>Unblocks</dt><dd>${deps.map(d => `<span class="chip" data-t="${esc(d.id)}" title="${esc(d.title)}">${esc(d.label)}</span>`).join('') || '<span class="faint">nothing further</span>'}</dd>
      <dt>Source</dt><dd class="mono" style="font-size:11px;word-break:break-all">${t.url ? `<a class="extlink" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(sourceCmd(t))}</a>` : esc(sourceCmd(t))}</dd>
      ${agentOf(t)?.worktree ? `<dt>Worktree</dt><dd class="mono" style="font-size:11px;word-break:break-all">${esc(agentOf(t).worktree)}</dd>` : ''}
      ${t.assignees?.length ? `<dt>Assigned</dt><dd>${esc(t.assignees.join(', '))}</dd>` : ''}</dl>
    ${t.ac ? `<h6 class="lbl">Acceptance · ${acDone(t)} of ${t.ac.length}</h6>${t.ac.map((a, i) => `<div class="crit ${a ? 'y' : ''}"><span class="bx">${a ? '✓' : ''}</span><span>${esc(t.acText?.[i] || 'Criterion ' + (i + 1))}</span></div>`).join('')}` : ''}
    ${t.answer ? `<h6 class="lbl">Answer</h6><p class="muted" style="margin:0">${esc(t.answer)}</p>` : ''}
    <h6 class="lbl">Other options</h6><div class="alt">
      <button class="btn quiet" data-act="send" data-cmd="/handoff ${esc(t.ref)}">⇄ Hand off to another session</button>
      <button class="btn quiet" data-act="send" data-cmd="/to-questionnaire ${esc(t.ref)}">? Ask someone via questionnaire</button>
      <button class="btn quiet" data-act="send" data-cmd="/diagnosing-bugs ${esc(t.ref)}">⚕ Diagnose a bug here</button></div>`;
}
function healthDial() {
  const p = healthPct(), r = 17, C = 2 * Math.PI * r;
  return `<svg width="44" height="44" viewBox="-22 -22 44 44"><circle r="${r}" fill="none" stroke="var(--line)" stroke-width="5"/><circle r="${r}" fill="none" stroke="var(--s-done)" stroke-width="5" stroke-dasharray="${C * p / 100} ${C}" transform="rotate(-90)" ${V === 'A' || V === 'B' ? '' : 'stroke-linecap="round"'}/><text y="4" text-anchor="middle" style="font-size:11px;font-weight:700;fill:var(--fg);font-family:var(--font)">${p}</text></svg>`;
}
function navHTML() {
  const ports = [['triage', '⚑', 'Triage', ISSUES.filter(i => issueNext(i).who === 'you').length, true], ['artifacts', '◧', 'Artifacts', ARTIFACTS.length], ['glossary', '§', 'Glossary', Object.keys(GLOSSARY).length]];
  const sep = V === 'C' ? '<span class="sep"></span>' : '';
  const warn = SETUP.filter(s => s.st === 'warn').length, miss = SETUP.filter(s => s.st === 'missing').length;
  return `<div class="setup" data-view="setup">${healthDial()}<div><b>Skills setup</b><small>${warn || miss ? `${warn} warning · ${miss} missing` : 'all good'}</small></div></div>
    <h6 class="lbl">Efforts</h6>
    ${EFFORTS.length ? `<button class="link ${S.scope === 'atlas' && ['chart', 'board'].includes(S.view) ? 'on' : ''}" data-act="atlas"><span class="g">✦</span>All efforts</button>` : '<p class="faint" style="font-size:12px;margin:4px 8px">No specs or maps yet.</p>'}
    ${EFFORTS.map(e => { const d = e.tickets.filter(isDone).length, n = e.tickets.length, f = e.tickets.filter(t => ['ready', 'you'].includes(stateOf(t, e))).length;
      return `<button class="place ${S.scope === 'effort' && S.eff === e.id && ['chart', 'board', 'ledger'].includes(S.view) ? 'on' : ''}" data-eff="${esc(e.id)}"><span class="n">${V === 'C' ? `<span class="roundel" style="background:${ecol(e)}">${enumOf(e)}</span>` : ''}${esc(trunc(e.title, 34))}</span>
      <span class="k"><span class="lbl" style="font-size:10px">${e.kind === 'map' ? 'map' : 'spec'}</span>${n ? `<span class="prog"><i style="width:${d / n * 100}%"></i></span><span class="mono">${d}/${n}</span>${f ? `<span style="color:var(--s-ready)" title="ready to take">▲${f}</span>` : ''}` : '<span style="color:var(--s-you)">no tickets</span>'}</span></button>`; }).join('')}
    ${sep}<h6 class="lbl">Inbox &amp; knowledge</h6>
    ${ports.map(([k, g, l, c, hot]) => `<button class="link ${S.view === k ? 'on' : ''}" data-view="${k}"><span class="g">${g}</span>${l}<span class="c ${hot && c ? 'hot' : ''}">${c}</span></button>`).join('')}
    ${sep}<h6 class="lbl">Ask</h6>
    <button class="link" data-act="send" data-cmd="/ask-matt"><span class="g">✧</span>Which flow fits?</button>
    <button class="link" data-act="send" data-cmd="/improve-codebase-architecture"><span class="g">▦</span>Architecture survey</button>
    <button class="link" data-act="send" data-cmd="/wayfinder"><span class="g">⚑</span>Start a wayfinder map</button>`;
}
function topMove() {
  if (QUESTIONS.length) return { who: 'you', text: `${QUESTIONS.length} question${QUESTIONS.length > 1 ? 's are' : ' is'} waiting for you in the dock. Agents are paused on them.` };
  for (const e of EFFORTS) for (const t of e.tickets) if (stateOf(t, e) === 'you' && t.status !== 'claimed') return { ...nextFor(t, e), text: `“${t.title}” needs you. ` + nextFor(t, e).text };
  for (const e of EFFORTS) { const n = effortNext(e); if (n.cmd) return { ...n, text: `${e.title}: ${n.text}` }; }
  return { who: 'wait', text: 'Nothing needs you right now.' };
}
function welcome() {
  const setupMissing = SETUP.find(s => s.label === 'Issue tracker' && s.st !== 'ok');
  return `<div class="pane"><div class="welcome"><h2>Nothing charted yet in ${esc(P.name)}</h2><p class="muted">Matt Skills UI shows the specs, tickets and wayfinder maps that mattpocock/skills write. Get started:</p><ol>
    ${setupMissing ? '<li><span class="cmd">/setup-matt-pocock-skills</span> to choose an issue tracker (GitHub, GitLab or local .scratch/).</li>' : ''}
    <li><span class="cmd">/grill-with-docs</span> to sharpen an idea, then <span class="cmd">/to-spec</span> and <span class="cmd">/to-tickets</span>.</li>
    <li>Or <span class="cmd">/wayfinder</span> for a big, foggy effort.</li></ol>
    <p class="faint">The board updates by itself as those files and issues appear.</p>
    <div class="acts">${setupMissing ? '<button class="btn go" data-act="send" data-cmd="/setup-matt-pocock-skills">Send /setup-matt-pocock-skills</button>' : ''}<button class="btn" data-act="send" data-cmd="/ask-matt">Ask which flow fits</button></div></div></div>`;
}
function mainHTML() {
  const warn = (ST.warnings || []).length ? `<div class="banner">${ST.warnings.map(esc).join('<br>')}</div>` : '';
  if (['setup', 'triage', 'artifacts', 'glossary'].includes(S.view)) return `${warn}<div class="stage">${{ setup: setupView, triage: triageView, artifacts: artifactsView, glossary: glossaryView }[S.view]()}</div>`;
  if (!EFFORTS.length) return `${warn}<div class="stage">${welcome()}</div>`;
  const all = S.scope === 'atlas', e = effById(S.eff), n = effortNext(e);
  const head = all
    ? `<div class="head"><div><div class="crumb"><span>${esc(P.name)}</span>${P.repo ? `·<span class="mono">${esc(P.repo)}</span>` : ''}</div><h1>All efforts <em>${esc(P.name)}</em></h1>
        <p class="gist">${EFFORTS.length} effort${EFFORTS.length > 1 ? 's' : ''} and ${ISSUES.length} incoming issue${ISSUES.length === 1 ? '' : 's'}. Pulsing items are ready to take; dashed lines are live blocks.</p></div>${nextBlock(topMove(), null)}</div>`
    : `<div class="head"><div><div class="crumb"><a data-act="atlas" style="cursor:pointer">All efforts</a>›<span class="mono">${esc(e.label)} · ${e.kind === 'map' ? 'wayfinder map' : 'spec'}</span>${e.url ? ` · <a class="extlink" href="${esc(e.url)}" target="_blank" rel="noopener">open</a>` : ''}</div>
        <h1>${esc(e.title)} <em>${esc(e.sub)}</em></h1><p class="gist">${e.kind === 'map' ? `<b>Destination:</b> ${esc(e.destination || '—')}` : `${esc(e.summary || '')} ${e.stories ? `<span class="faint">${e.stories} user stories.</span>` : ''}`}</p></div>
        ${nextBlock(n, null)}${routeLine(e)}</div>`;
  const tabs = [['chart', 'Chart', '1'], ['board', 'Board', '2'], ['ledger', 'Ledger', '3']].filter(v => !(all && v[0] === 'ledger'));
  const body = S.view === 'board' ? boardView() : S.view === 'ledger' && !all ? ledgerView() : chartView();
  return `${warn}${head}<div class="views">${tabs.map(([k, l, key]) => `<button class="${S.view === k || (k === 'chart' && S.view === 'ledger' && all) ? 'on' : ''}" data-v="${k}" data-n="${key}">${l}<span class="kbd">${key}</span></button>`).join('')}
    <div class="right"><button class="btn quiet" data-act="refresh" title="Re-read files and the tracker">↻</button><span class="faint" style="font-size:11.5px">Scope</span><div class="seg"><button class="${!all ? 'on' : ''}" data-scope="effort">This effort</button><button class="${all ? 'on' : ''}" data-scope="atlas">All efforts</button></div></div></div>
    <div class="stage">${body}</div>`;
}
const stLabel = s => ({ running: 'running', waiting: 'waiting on you', starting: 'starting', ended: 'ended', failed: 'failed', listening: 'listening', offline: 'not listening', unknown: '' }[s] ?? s);
function dockHTML() {
  const s = SESSIONS.find(x => x.id === S.sess) || SESSIONS[0];
  const tab = S.dtab === 'q' && QUESTIONS.length ? 'q' : 't';
  const live = SESSIONS.filter(x => x.kind !== 'main' && ['running', 'starting'].includes(x.st)).length;
  return `<div class="exp"><div class="hd"><b>Sessions</b><span class="faint" style="font-size:12px">${live} running · ${QUESTIONS.length} question${QUESTIONS.length === 1 ? '' : 's'} for you · tick = ~150k smart zone</span></div>
    <div class="row">${SESSIONS.map(x => `<div class="ship ${x.id === s.id ? 'on' : ''}" data-sess="${esc(x.id)}"><div class="t"><span class="sd ${x.st}"></span>${esc(x.name)}</div><div class="d" title="${esc(x.doing || '')}">${esc(x.doing || stLabel(x.st))}</div>
      <div class="fuel"><i style="width:${x.ctx == null ? 0 : Math.min(100, x.ctx / 2)}%;background:${fuelColor(x.ctx || 0)}"></i><b></b></div>
      <div class="k"><span>${x.ctx == null ? '—' : x.ctx + 'k'} context</span><span>${x.kind === 'main' ? advise(x) : stLabel(x.st)}</span></div></div>`).join('')}
      <button class="ship add" data-act="spawn" data-cmd="">＋ New session</button></div></div>
    <div class="disp"><div class="tabs"><button class="${tab === 'q' ? 'on' : ''}" data-dtab="q">Questions for you <span class="mono" style="color:var(--s-you)">${QUESTIONS.length}</span></button><button class="${tab === 't' ? 'on' : ''}" data-dtab="t">Log · ${esc(s.id)}</button>${s.kind !== 'main' && ['running', 'waiting', 'starting'].includes(s.st) ? `<button data-act="stopsess" data-s="${esc(s.id)}" style="margin-left:auto" title="Stop this session">■ stop</button>` : ''}</div>
      <div class="body" id="dispbody">${tab === 'q' ? QUESTIONS.map(qHTML).join('') || '<p class="empty">No one is waiting on you.</p>' : logHTML(s)}</div>
      <div class="compose"><select id="tgt">${SESSIONS.map(x => `<option value="${esc(x.id)}" ${x.id === s.id ? 'selected' : ''}>to ${esc(x.id)}</option>`).join('')}</select><input id="msgIn" placeholder="${s.kind === 'main' ? 'Message the main session (arrives via its board listener)' : 'Reply, steer, or type a /command'}"><button class="btn go" data-act="msg">Send</button></div></div>`;
}
function logHTML(s) {
  if (s.kind === 'main' && !s.log.length) return `<p class="empty">${s.st === 'offline' ? 'The main session isn’t listening. Run /matt-skills-ui in it to reconnect.' : 'Messages you send to the main session appear here.'}</p>`;
  return s.log.slice(-120).map(m => `<div class="msg ${m.w === 'me' ? 'me' : m.w === 'tool' ? 'tool' : m.w === 'sys' ? 'sys' : ''}">${m.w === 'agent' || m.w === 'me' ? `<div class="w">${m.w === 'me' ? 'you' : esc(s.id)}</div>` : ''}${esc(m.t)}</div>`).join('') + (s.sessionId && s.kind !== 'main' ? `<div class="msg sys">Resume in a terminal: claude --resume ${esc(s.sessionId)}</div>` : '');
}
function qHTML(q) {
  return `<div class="q"><div class="from"><span class="who" style="--c:var(--s-you)">${esc(q.skill || 'question')}</span>${esc(q.from)} is waiting${q.ref ? ` · <span class="chip" data-t="${esc(q.ref)}">${esc(findT(q.ref)[0]?.label || q.ref)}</span>` : ''}</div>
    <div class="qq">${esc(q.q)}</div>${q.rec ? `<div class="rec">${esc(q.rec)}</div>` : ''}
    <div class="acts">${q.rec ? `<button class="btn go" data-act="answer" data-q="${q.id}" data-a="__rec">Accept recommendation</button>` : ''}${(q.opts || []).map(o => `<button class="btn" data-act="answer" data-q="${q.id}" data-a="${esc(o)}">${esc(o)}</button>`).join('')}<button class="btn quiet" data-act="reply" data-q="${q.id}" data-s="${esc(q.from)}">Reply…</button></div></div>`;
}
function paletteItems() {
  const out = [];
  EFFORTS.forEach(e => { out.push({ ty: e.kind, label: e.title, r: e.label, go: () => selectEff(e.id) }); e.tickets.forEach(t => out.push({ ty: 'ticket', label: t.title, r: t.label, go: () => { S.t = t.id; S.eff = e.id; S.scope = 'effort'; if (!['chart', 'board', 'ledger'].includes(S.view)) S.view = 'chart'; } })); });
  ISSUES.forEach(i => out.push({ ty: 'issue', label: i.title, r: i.label, go: () => { S.view = 'triage'; } }));
  (ST.skills?.user || []).filter(s => s.installed).forEach(s => out.push({ ty: 'skill', label: '/' + s.name, r: 'send to main', go: () => send('/' + s.name) }));
  [['setup', 'Skills setup'], ['triage', 'Triage'], ['artifacts', 'Artifacts'], ['glossary', 'Glossary']].forEach(([k, l]) => out.push({ ty: 'view', label: l, r: '', go: () => { S.view = k; } }));
  return out;
}
function paletteHTML() {
  const q = S.pal.toLowerCase(), items = paletteItems().filter(i => (i.label + ' ' + i.r).toLowerCase().includes(q)).slice(0, 12);
  S.palItems = items; S.palI = Math.min(S.palI, Math.max(0, items.length - 1));
  return `<div class="scrim" data-act="palclose"><div class="palette"><input id="palIn" value="${esc(S.pal)}" placeholder="Go to a ticket or effort, or send a skill…" autocomplete="off">
    <div class="list">${items.map((it, k) => `<div class="it ${k === S.palI ? 'on' : ''}" data-pi="${k}"><span class="lbl ty">${it.ty}</span><span>${esc(it.label)}</span><span class="r">${esc(it.r)}</span></div>`).join('') || '<p class="empty">No matches.</p>'}</div></div></div>`;
}
function pickerHTML() {
  const th = ST.theme || {}, over = th.override, inst = FROM_SLUG[th.install] || 'A';
  const mini = k => { const n = [['s-done', 18, 52], ['s-done', 78, 30], ['s-progress', 138, 52], ['s-ready', 198, 30], ['s-blocked', 198, 74]];
    const shape = (v, x, y) => k === 'A' ? `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="var(--${v})"/>` : k === 'B' ? `<rect x="${x - 22}" y="${y - 8}" width="44" height="16" fill="var(--bg2)" stroke="var(--${v})"/>` : k === 'C' ? `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg)" stroke="var(--e1)" stroke-width="3"/><circle cx="${x}" cy="${y}" r="2.5" fill="var(--${v})"/>` : `<rect x="${x - 20}" y="${y - 9}" width="44" height="20" rx="5" fill="var(--fg)"/><rect x="${x - 22}" y="${y - 11}" width="44" height="20" rx="5" fill="var(--${v})" stroke="var(--fg)" stroke-width="2"/>`;
    const line = (x1, y1, x2, y2) => k === 'C' ? `<path d="M${x1},${y1} H${Math.max(x1, x2 - 14 - Math.abs(y2 - y1))} L${x2 - 14},${y2} H${x2}" stroke="var(--e1)" stroke-width="5" fill="none" stroke-linejoin="round"/>` : k === 'D' ? `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}" stroke="var(--fg)" stroke-width="2.5" fill="none"/>` : `<path d="M${x1},${y1} H${(x1 + x2) / 2} V${y2} H${x2}" stroke="var(--fg3)" stroke-width="1.3" fill="none" ${k === 'B' ? 'stroke-dasharray="2 3"' : ''}/>`;
    return `<svg width="230" height="86" viewBox="0 0 230 86">${line(18, 52, 78, 30)}${line(18, 52, 138, 52)}${line(78, 30, 198, 30)}${line(138, 52, 198, 74)}${n.map(([v, x, y]) => shape(v, x, y)).join('')}</svg>`; };
  return `<div class="tpick"><h4>Theme</h4><p class="sub">Same features in every theme. Changes apply instantly and are remembered for every repo.</p>
    <div class="grid">${TK.map(k => `<button class="tcard ${k === V ? 'on' : ''}" data-pick="${k}"><div class="tprev" data-theme="${k}"><div class="hb"><b>Matt Skills UI${k === 'A' ? '<span style="color:var(--accent)">.</span>' : ''}</b><span class="who" style="--c:var(--s-you)">you</span></div>${mini(k)}<span class="btn go">${k === 'B' ? 'spawn' : 'Spawn'}</span></div>
      <div class="cap"><b>${THEMES[k][0]}</b><span>${k === inst ? 'install default' : THEMES[k][1].split(' · ')[0]}</span></div></button>`).join('')}</div>
    <div class="foot"><span>Install default: <b>${THEMES[inst][0]}</b> (<code>/config</code> → plugin options). ${over ? `Overridden here with <b>${THEMES[FROM_SLUG[over]][0]}</b>.` : 'No override.'} Also <code>/matt-skills-ui theme transit</code>.</span>${over ? '<button class="btn" data-act="themereset">Use default</button>' : ''}</div></div>`;
}
function spawnHTML() {
  const sp = S.spawn, modes = ST.permissionModes || ['default', 'acceptEdits', 'auto', 'plan'];
  let mode = 'acceptEdits'; try { mode = localStorage.getItem('msu.mode') || mode; } catch {}
  return `<div class="dlg" data-act="spawnclose"><div class="box"><h4>Spawn a background session</h4>
    <p class="faint" style="margin:0;font-size:12px">Runs <span class="mono">claude -p</span> headless from this board. Its log, questions and replies show in the dock; you can resume it in a terminal later.</p>
    <textarea id="spPrompt" placeholder="/implement … or any prompt">${esc(sp.cmd)}</textarea>
    <div class="row"><label>Permission mode <select id="spMode">${modes.map(m => `<option ${m === mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="spWt" ${sp.worktree ? 'checked' : ''}> Own git worktree</label></div>
    <p class="warn">Headless sessions can’t ask for permission: anything your settings don’t allow is denied. <b>acceptEdits</b> lets it edit files; <b>auto</b> lets Claude decide; <b>plan</b> is read-only.</p>
    <div class="acts"><button class="btn go" data-act="spawngo">Spawn</button><button class="btn quiet" data-act="spawnclose">Cancel</button></div></div></div>`;
}
function render() {
  if (!ST) return;
  renderSoon = false;
  document.documentElement.dataset.theme = V;
  document.title = `${P.name} · Matt Skills UI`;
  const keepScroll = document.getElementById('dispbody')?.scrollTop, boardScroll = [document.querySelector('.board')?.scrollLeft, document.querySelector('.board')?.scrollTop];
  document.getElementById('root').innerHTML = `<div class="app ${S.wide ? 'wide' : ''} ${S.boot ? 'boot' : ''}">
    <header class="mast"><div class="brand"><b>Matt Skills UI</b><i>${esc(P.name)}</i></div>
      <div class="meta"><span class="mono">⎇ ${esc(P.branch)}</span><span>${esc(P.tracker)}${P.repo ? ` · <span class="mono">${esc(P.repo)}</span>` : ''}</span></div><span class="sp"></span>
      ${QUESTIONS.length ? `<button class="await" data-act="awaits">${QUESTIONS.length} question${QUESTIONS.length > 1 ? 's' : ''} waiting on you</button>` : ''}
      <button class="seek" data-act="pal">⌕ <span>Search or send a skill</span><span class="kbd">⌘K</span></button>
      <span class="live" title="Updates live from files and the tracker"><i></i>live</span>
      <button class="iconbtn" data-act="theme" title="Theme" style="width:auto;padding:0 8px;gap:6px;display:flex">◐ <span style="font-size:12px">${THEMES[V][0]}</span></button>
      <button class="iconbtn" data-act="wide" title="Toggle details (])">${S.wide ? '⇤' : '⇥'}</button></header>
    <nav class="nav">${navHTML()}</nav>
    <main class="main">${mainHTML()}</main>
    <aside class="notes">${notesHTML()}</aside>
    <footer class="dock">${dockHTML()}</footer></div>${S.pal != null ? paletteHTML() : ''}${S.themeOpen ? pickerHTML() : ''}${S.spawn ? spawnHTML() : ''}`;
  S.boot = false;
  const db = document.getElementById('dispbody'); if (db) db.scrollTop = S.dtab === 't' ? db.scrollHeight : (keepScroll || 0);
  const bd = document.querySelector('.board'); if (bd && boardScroll[0] != null) { bd.scrollLeft = boardScroll[0]; bd.scrollTop = boardScroll[1]; }
  if (document.getElementById('chartsvg')) wireChart();
  if (S.pal != null) { const i = document.getElementById('palIn'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

/* ======================= ACTIONS ======================= */
function toast(h) { const d = document.createElement('div'); d.innerHTML = h; document.getElementById('toast').appendChild(d); setTimeout(() => d.remove(), 3200); }
const fail = e => toast(`Failed: <b>${esc(e.message)}</b>`);
function send(cmd) { return api('/api/send', { to: 'main', text: cmd }).then(() => toast(`Sent <b>${esc(cmd)}</b> to the main session`), fail); }
function selectEff(id) { const e = effById(id); S.eff = id; S.scope = 'effort'; if (!['chart', 'board', 'ledger'].includes(S.view)) S.view = 'chart'; if (!findT(S.t)[1] || findT(S.t)[1].id !== id) S.t = e.tickets.find(t => ['ready', 'you', 'progress'].includes(stateOf(t, e)))?.id || e.tickets[0]?.id || null; }
function goTheme(k, save) { V = k; S.vb = null; S.boot = true; S.drawn.clear(); if (save) api('/api/theme', { theme: SLUG[k] }).catch(fail); try { localStorage.setItem('msu.lastTheme', SLUG[k]); } catch {} render(); }
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-pick],[data-act],[data-v],[data-scope],[data-eff],[data-t],[data-view],[data-sess],[data-dtab],[data-z],[data-pi],[data-iss]');
  if (S.themeOpen && !ev.target.closest('.tpick') && !el?.dataset.act?.startsWith('theme')) { S.themeOpen = false; if (!el) return render(); }
  if (!el) return;
  const d = el.dataset, a = d.act;
  if (d.pick) return goTheme(d.pick, true);
  if (d.pi != null) { S.palItems[+d.pi].go(); S.pal = null; return render(); }
  if (d.z) { if (d.z === 'fit') S.vb = null; else { const f = +d.z, cx = S.vb.x + S.vb.w / 2, cy = S.vb.y + S.vb.h / 2; S.vb.w *= f; S.vb.h *= f; S.vb.x = cx - S.vb.w / 2; S.vb.y = cy - S.vb.h / 2; } return render(); }
  if (a === 'theme') { S.themeOpen = !S.themeOpen; return render(); }
  if (a === 'themereset') { api('/api/theme', { theme: null }).then(r => { S.themeOpen = false; goTheme(FROM_SLUG[r.theme.current] || 'A'); }, fail); return; }
  if (a === 'pal') { S.pal = ''; S.palI = 0; return render(); }
  if (a === 'palclose') { if (ev.target === el) { S.pal = null; render(); } return; }
  if (a === 'spawnclose') { if (ev.target === el) { S.spawn = null; render(); } return; }
  if (a === 'wide') { S.wide = !S.wide; return render(); }
  if (a === 'refresh') { toast('Re-reading files and the tracker…'); api('/api/refresh', {}).catch(fail); return; }
  if (a === 'atlas') { S.scope = 'atlas'; if (!['chart', 'board'].includes(S.view)) S.view = 'chart'; return render(); }
  if (a === 'awaits') { S.dtab = 'q'; return render(); }
  if (a === 'copy') { navigator.clipboard?.writeText(d.cmd).then(() => toast(`Copied <b>${esc(d.cmd)}</b>`), () => toast(`Copy: <b>${esc(d.cmd)}</b>`)); return; }
  if (a === 'send') { send(d.cmd); return; }
  if (a === 'spawn') { S.spawn = { cmd: d.cmd || '', ref: d.ref || null, worktree: /^\/implement\b/.test(d.cmd || '') }; render(); document.getElementById('spPrompt')?.focus(); return; }
  if (a === 'spawngo') {
    const prompt = document.getElementById('spPrompt').value.trim(), mode = document.getElementById('spMode').value, worktree = document.getElementById('spWt').checked;
    if (!prompt) return toast('Write a prompt first');
    try { localStorage.setItem('msu.mode', mode); } catch {}
    const ref = S.spawn.ref, t = ref ? findT(ref)[0] : null; S.spawn = null; render();
    api('/api/spawn', { prompt, ticket: ref, mode, worktree, name: t ? t.title : prompt.slice(0, 50) }).then(r => { S.sess = r.id; S.dtab = 't'; toast(`Spawned <b>${esc(r.id)}</b>`); }, fail); return; }
  if (a === 'answer') { api('/api/answer', { qid: d.q, answer: d.a }).then(() => toast('Answer sent'), fail); return; }
  if (a === 'reply') { S.sess = d.s; S.dtab = 't'; S.replyTo = d.q; render(); const i = document.getElementById('msgIn'); if (i) { i.placeholder = 'Your answer…'; i.focus(); } return; }
  if (a === 'stopsess') { api('/api/stop-session', { id: d.s }).then(() => toast(`Stopping <b>${esc(d.s)}</b>`), fail); return; }
  if (a === 'msg') {
    const inp = document.getElementById('msgIn'), txt = inp?.value.trim(); if (!txt) return; const to = document.getElementById('tgt').value;
    const q = S.replyTo && QUESTIONS.find(x => x.id === S.replyTo && x.from === to); S.replyTo = null; inp.value = '';
    (q ? api('/api/answer', { qid: q.id, answer: txt }) : api('/api/send', { to, text: txt })).then(() => toast(`Sent to <b>${esc(to)}</b>`), fail); return; }
  if (a === 'watch') { S.sess = d.s; S.dtab = 't'; return render(); }
  if (d.v) { S.view = d.v; return render(); }
  if (d.scope) { S.scope = d.scope; if (S.scope === 'atlas' && S.view === 'ledger') S.view = 'chart'; return render(); }
  if (d.dtab) { S.dtab = d.dtab; return render(); }
  if (d.sess) { S.sess = d.sess; S.dtab = 't'; return render(); }
  if (d.view) { S.view = d.view; return render(); }
  if (d.iss) { S.view = 'triage'; return render(); }
  if (d.eff) { selectEff(d.eff); return render(); }
  if (d.t) { const [t, e] = findT(d.t); if (!t) return; S.t = d.t; if (S.scope === 'effort') S.eff = e.id; if (!['chart', 'board', 'ledger'].includes(S.view)) { S.view = 'chart'; S.eff = e.id; S.scope = 'effort'; } S.wide = false; return render(); }
});
document.addEventListener('input', ev => { if (ev.target.id === 'palIn') { S.pal = ev.target.value; S.palI = 0; render(); } });
document.addEventListener('focusout', () => { if (renderSoon) setTimeout(() => { if (!document.activeElement?.closest?.('input,textarea,select') && !S.pal && !S.spawn) render(); }, 200); });
document.addEventListener('keydown', ev => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); S.pal = S.pal == null ? '' : null; S.palI = 0; return render(); }
  if (S.pal != null) {
    if (ev.key === 'Escape') { S.pal = null; return render(); }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); S.palI = Math.max(0, Math.min((S.palItems || []).length - 1, S.palI + (ev.key === 'ArrowDown' ? 1 : -1))); return render(); }
    if (ev.key === 'Enter' && S.palItems?.[S.palI]) { S.palItems[S.palI].go(); S.pal = null; return render(); }
    return;
  }
  if (S.spawn && ev.key === 'Escape') { S.spawn = null; return render(); }
  if (ev.target.closest('input,textarea,select')) { if (ev.key === 'Enter' && ev.target.id === 'msgIn') { ev.preventDefault(); document.querySelector('[data-act="msg"]').click(); } return; }
  if (ev.altKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) return goTheme(TK[(TK.indexOf(V) + (ev.key === 'ArrowRight' ? 1 : TK.length - 1)) % TK.length], true);
  if (ev.key === 'Escape' && S.themeOpen) { S.themeOpen = false; return render(); }
  if (ev.key === '1') { S.view = 'chart'; render(); } if (ev.key === '2') { S.view = 'board'; render(); } if (ev.key === '3' && S.scope === 'effort') { S.view = 'ledger'; render(); }
  if (ev.key === ']') { S.wide = !S.wide; render(); }
});
/* board: hover draws threads from blockers (red) and to dependents (blue) */
document.addEventListener('mouseover', ev => {
  const grid = document.getElementById('bgrid'); if (!grid) return;
  const tag = ev.target.closest('.tag[data-t]'), id = tag?.dataset.t || null;
  if (id === (grid.dataset.hl || null)) return; grid.dataset.hl = id || '';
  const svg = document.getElementById('threads'); svg.innerHTML = ''; grid.classList.toggle('hl', !!id);
  grid.querySelectorAll('.tag').forEach(x => x.classList.remove('h0', 'h1', 'h2')); if (!id) return;
  const [t, e] = findT(id); if (!t) return; const g = grid.getBoundingClientRect(); svg.setAttribute('width', grid.scrollWidth); svg.setAttribute('height', grid.scrollHeight);
  const box = x => { const r = x.getBoundingClientRect(); return { l: r.left - g.left, r: r.right - g.left, y: r.top - g.top + r.height / 2 }; };
  const me = box(tag); tag.classList.add('h0'); let p = '';
  grid.querySelectorAll('.tag[data-t]').forEach(x => { const k = x.dataset.t, isB = t.blockedBy.includes(k), isD = dependents(t, e).some(z => z.id === k); if (!isB && !isD) return;
    x.classList.add(isB ? 'h1' : 'h2'); const o = box(x);
    const [a, b] = isB ? [o, me] : [me, o], fwd = (a.l + a.r) <= (b.l + b.r), x1 = fwd ? a.r : a.l, x2 = fwd ? b.l : b.r, sg = fwd ? 1 : -1, dx = Math.max(40, Math.abs(x2 - x1) / 2), c = isB ? 'var(--s-blocked)' : 'var(--s-ready)';
    p += `<path stroke="${c}" d="M${x1},${a.y} C${x1 + sg * dx},${a.y} ${x2 - sg * dx},${b.y} ${x2},${b.y}"/><circle cx="${x2}" cy="${b.y}" r="3.5" fill="${c}"/>`; });
  svg.innerHTML = p;
});
function wireChart() {
  const s = document.getElementById('chartsvg'); let drag = null;
  const set = () => s.setAttribute('viewBox', `${S.vb.x} ${S.vb.y} ${S.vb.w} ${S.vb.h}`);
  if (S.vbFresh) { S.vbFresh = false; const r = s.getBoundingClientRect(); if (r.width > 0) { const kk = Math.max(S.vb.w / r.width, S.vb.h / r.height), cap = S.scope === 'atlas' ? 99 : 1.35;
    if (kk > cap) { const cy = S.vb.y + S.vb.h / 2; S.vb.w = r.width * cap; S.vb.h = r.height * cap; S.vb.y = cy - S.vb.h / 2; S.vb.x -= 10; }
    else if (kk < .85) { const cx = S.vb.x + S.vb.w / 2, cy = S.vb.y + S.vb.h / 2; S.vb.w = r.width * .85; S.vb.h = r.height * .85; S.vb.x = cx - S.vb.w / 2; S.vb.y = cy - S.vb.h / 2; }
    set(); } }
  const k = () => { const r = s.getBoundingClientRect(); return Math.max(S.vb.w / r.width, S.vb.h / r.height); };
  s.addEventListener('pointerdown', e => { if (e.target.closest('[data-t],[data-eff],[data-view]')) return; drag = { x: e.clientX, y: e.clientY, vx: S.vb.x, vy: S.vb.y, k: k() }; s.setPointerCapture(e.pointerId); });
  s.addEventListener('pointermove', e => { if (!drag) return; S.vb.x = drag.vx - (e.clientX - drag.x) * drag.k; S.vb.y = drag.vy - (e.clientY - drag.y) * drag.k; set(); });
  s.addEventListener('pointerup', () => drag = null);
  s.addEventListener('wheel', e => { e.preventDefault(); const f = e.deltaY > 0 ? 1.08 : .926, r = s.getBoundingClientRect(), kk = k();
    const mx = S.vb.x + S.vb.w / 2 + (e.clientX - r.left - r.width / 2) * kk, my = S.vb.y + S.vb.h / 2 + (e.clientY - r.top - r.height / 2) * kk;
    S.vb.x = mx - (mx - S.vb.x) * f; S.vb.y = my - (my - S.vb.y) * f; S.vb.w *= f; S.vb.h *= f; set(); }, { passive: false });
}

/* ======================= BOOT ======================= */
function connect() {
  const es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
  es.addEventListener('state', ev => ingest(JSON.parse(ev.data)));
  es.onerror = () => { document.querySelector('.live i')?.style.setProperty('background', 'var(--s-blocked)'); };
  es.onopen = () => { document.querySelector('.live i')?.style.removeProperty('background'); };
}
if (!TOKEN) document.getElementById('root').innerHTML = '<div style="padding:40px;font-family:system-ui">Missing access token. Open the URL printed by <code>/matt-skills-ui</code>.</div>';
else if (window.__STATE__) { ingest(window.__STATE__); connect(); }
else api('/api/state').then(ingest, e => { document.getElementById('root').innerHTML = `<div style="padding:40px;font-family:system-ui">Can’t reach the board server: ${esc(e.message)}. Run <code>/matt-skills-ui</code> again.</div>`; }).then(connect);
