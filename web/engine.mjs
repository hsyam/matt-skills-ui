// Next-move engine. Pure functions over the server's state; shared by the browser and node tests.
// Encodes the flows from mattpocock/skills: to-spec → to-tickets → implement(-spec) → code-review → pr → retro,
// the wayfinder frontier (research is AFK; grilling/prototype/task need a human), and triage roles.

let M = { efforts: [], issues: [], sessions: [] };
export function bind(state) { M = state; }

export const STATE = { done: 'Done', progress: 'In progress', ready: 'Ready', blocked: 'Blocked', you: 'Your move' };
export const GLY = { research: '⌕', grilling: '❝', prototype: '◧', task: '⚑' };

export const findT = id => { for (const e of M.efforts) { const t = e.tickets.find(t => t.id === id); if (t) return [t, e]; } return [null, null]; };
export const effById = id => M.efforts.find(e => e.id === id);
export const isDone = t => !!t && t.status === 'done';
export const HITL = t => (!!t.type && t.type !== 'research') || t.role === 'ready-for-human';
export const openBlockers = (t, e) => t.blockedBy.map(b => e.tickets.find(x => x.id === b)).filter(b => b && !isDone(b));
export const dependents = (t, e) => e.tickets.filter(x => x.blockedBy.includes(t.id));
export const acDone = t => (t.ac || []).filter(Boolean).length;
const agentFor = t => (M.sessions || []).find(s => s.ticket === t.id && ['running', 'waiting', 'starting'].includes(s.st));

export function stateOf(t, e) {
  if (isDone(t)) return 'done';
  const ag = agentFor(t);
  if (ag) return ag.st === 'waiting' ? 'you' : 'progress';
  if (t.status === 'claimed') return HITL(t) ? 'you' : 'progress';
  if (openBlockers(t, e).length) return 'blocked';
  return HITL(t) ? 'you' : 'ready';
}
export const glyph = (t, s) => s === 'done' ? '✓' : t.type ? GLY[t.type] : s === 'progress' ? '◐' : s === 'blocked' ? '×' : '▲';

export function nextFor(t, e) {
  const s = stateOf(t, e), ob = openBlockers(t, e), ag = agentFor(t);
  if (s === 'done') return { who: 'done', text: t.answer ? `Resolved: ${t.answer}` : 'Closed.' };
  if (ag) return ag.st === 'waiting' ? { who: 'you', text: `${ag.name} is waiting for your answer in the dock.`, watch: ag.id } : { who: 'agent', text: `${ag.name} is working on it${ag.worktree ? ' in ' + ag.worktree : ''}.`, watch: ag.id };
  if (s === 'blocked') return { who: 'wait', text: `Waits on ${ob.map(b => `“${b.title}”`).join(' and ')}.` };
  if (t.status === 'claimed' && !HITL(t)) return { who: 'agent', text: `Claimed${t.assignees?.length ? ' by ' + t.assignees.join(', ') : ''}; work is underway outside the board.` };
  if (e.kind !== 'map') {
    if (t.role === 'ready-for-human') return { who: 'you', cmd: `/implement ${t.ref}`, text: 'Marked ready-for-human: it needs your judgement, so run it in your own session.' };
    return { who: 'agent', cmd: `/implement ${t.ref}`, text: 'Unblocked and agent-ready. Spawn an implementer in its own worktree, or run it here in a fresh context.', spawn: true };
  }
  if (t.type === 'research') return { who: 'agent', cmd: `/wayfinder ${e.ref} ${t.ref}`, text: 'Research needs no human. Spawn a background agent that runs /research and links its notes back.', spawn: true };
  if (t.status === 'claimed') return { who: 'you', cmd: `/wayfinder ${e.ref} ${t.ref}`, text: 'Claimed and in progress with you (grilling / prototype / task). Continue it where it was claimed.' };
  if (t.type === 'prototype') return { who: 'you', cmd: `/wayfinder ${e.ref} ${t.ref}`, text: 'Needs you: the agent builds a throwaway /prototype for you to react to.', spawn: true };
  if (t.type === 'task') return { who: 'you', cmd: `/wayfinder ${e.ref} ${t.ref}`, text: 'Needs your hands: the agent hands you a checklist or a /wizard.', spawn: true };
  return { who: 'you', cmd: `/wayfinder ${e.ref} ${t.ref}`, text: 'A live grilling with you; the decision lands on the map. Answer from the board or the terminal.', spawn: true };
}

export function effortNext(e) {
  if (e.kind !== 'map') {
    if (!e.tickets.length) return { who: 'you', cmd: `/to-tickets ${e.ref}`, text: 'The spec has no tickets yet. Break it into tracer-bullet tickets with blocking edges.' };
    if (e.tickets.every(isDone)) return { who: 'agent', cmd: '/code-review main', text: 'Every ticket is closed. Review both axes, then /pr, then /retro.' };
    const ready = e.tickets.filter(t => stateOf(t, e) === 'ready');
    if (ready.length >= 2) return { who: 'agent', cmd: `/implement-spec ${e.ref}`, text: `${ready.length} tickets are ready. Run implementers across them in parallel on one integration branch.`, spawn: true };
    if (ready.length === 1) return { who: 'agent', cmd: `/implement ${ready[0].ref}`, text: `One ticket is ready: “${ready[0].title}”.`, spawn: true, t: ready[0].id };
    return { who: 'wait', text: 'Nothing is unblocked yet. Waiting on work in progress.' };
  }
  const open = e.tickets.filter(t => !isDone(t));
  if (!open.length && !(e.fog || []).length) return { who: 'you', cmd: `/to-spec ${e.ref}`, text: 'The way is clear. Collapse the map’s decisions into a spec.' };
  const f = open.filter(t => ['ready', 'you'].includes(stateOf(t, e))).length;
  return { who: 'you', cmd: `/wayfinder ${e.ref}`, text: `${f} decision${f === 1 ? '' : 's'} on the frontier, ${(e.fog || []).length} not yet specified. Work the next one.` };
}

export function issueNext(i) {
  if (!i.state) return { who: 'you', cmd: `/triage ${i.ref}`, text: i.oos ? `Never triaged. Resembles .out-of-scope/${i.oos}: likely a wontfix pointing at the earlier decision.` : 'Never triaged.' };
  if (i.state === 'needs-triage') return { who: 'you', cmd: `/triage ${i.ref}`, text: 'Reproduce it, then recommend a category and state.' };
  if (i.state === 'needs-info') return { who: 'wait', cmd: `/triage ${i.ref}`, text: `Waiting on the reporter${i.updated ? `; last activity ${i.updated} ago` : ''}. Re-run /triage once they reply.` };
  if (i.state === 'ready-for-agent') return { who: 'agent', cmd: `/implement ${i.ref}`, text: 'Has an agent brief. Spawn an agent for it.', spawn: true };
  if (i.state === 'ready-for-human') return { who: 'you', cmd: `/implement ${i.ref}`, text: 'Needs a human: see the brief for why it can’t be delegated.' };
  return { who: 'done', text: 'wontfix' };
}

export function stageOf(e) {
  if (e.kind === 'map') return e.tickets.every(isDone) && !(e.fog || []).length ? 'collapse' : e.tickets.length ? 'resolve' : 'chart';
  if (!e.tickets.length) return 'tickets';
  return e.tickets.every(isDone) ? 'review' : 'implement';
}

/** Layer = longest blocker chain; crit = edges on the longest chain of open tickets. */
export function layout(e) {
  const by = Object.fromEntries(e.tickets.map(t => [t.id, t])); const layer = {}, seen = new Set();
  const L = id => { if (layer[id] != null) return layer[id]; if (seen.has(id)) return 0; seen.add(id); return layer[id] = by[id].blockedBy.filter(b => by[b]).reduce((m, b) => Math.max(m, L(b) + 1), 0); };
  e.tickets.forEach(t => L(t.id));
  const cols = []; e.tickets.forEach(t => (cols[layer[t.id]] ||= []).push(t));
  const dist = {}, prev = {}, seen2 = new Set();
  const D = id => { if (dist[id] != null) return dist[id]; if (seen2.has(id)) return 0; seen2.add(id); let best = 0, bp = null; by[id].blockedBy.forEach(b => { if (by[b] && D(b) > best) { best = D(b); bp = b; } }); prev[id] = bp; return dist[id] = best + (isDone(by[id]) ? 0 : 1); };
  e.tickets.forEach(t => D(t.id));
  let end = e.tickets.length ? e.tickets.reduce((a, t) => D(t.id) > D(a.id) ? t : a, e.tickets[0]).id : null; const crit = new Set(), guard = new Set();
  while (end && prev[end] && !guard.has(end)) { guard.add(end); crit.add(prev[end] + '>' + end); end = prev[end]; }
  return { cols: cols.filter(Boolean), crit };
}

/** Problems worth flagging: cycles and dangling blocked-by references. */
export function lint(e) {
  const out = [], ids = new Set(e.tickets.map(t => t.id));
  const state = {}; const visit = (id, stack) => { if (state[id] === 1) { out.push(`Blocked-by cycle: ${[...stack, id].join(' → ')}`); return; } if (state[id] === 2) return; state[id] = 1; const t = e.tickets.find(x => x.id === id); (t?.blockedBy || []).filter(b => ids.has(b)).forEach(b => visit(b, [...stack, id])); state[id] = 2; };
  e.tickets.forEach(t => visit(t.id, []));
  return [...new Set(out)];
}
