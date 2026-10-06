import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTicketFile, parseMap, readLocal } from '../skills/matt-skills-ui/server/lib/local.mjs';
import { classify, parentFromBody, blockedFromBody } from '../skills/matt-skills-ui/server/lib/github.mjs';
import { parseQuestion } from '../skills/matt-skills-ui/server/lib/sessions.mjs';
import { buildModel, oosMatch } from '../skills/matt-skills-ui/server/lib/model.mjs';
import { field } from '../skills/matt-skills-ui/server/lib/util.mjs';
import * as E from '../skills/matt-skills-ui/web/engine.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acme-local');

test('field() reads **Key:** and Key: lines, and never spills onto the next line', () => {
  assert.equal(field('**Blocked by:** 01, 02', 'Blocked by'), '01, 02');
  assert.equal(field('Status: claimed', 'Status'), 'claimed');
  assert.equal(field('Status: \n\nPlease add a night theme.', 'Status'), null);
});

test('to-tickets local ticket file', () => {
  const t = parseTicketFile('# 03: Create intent\n\n**Blocked by:** 01, 2\n\n**Status:** ready-for-agent\n\n- [x] a\n- [ ] b\n', '03-create-intent.md');
  assert.deepEqual([t.num, t.title, t.blockedBy, t.status, t.role, t.ac], ['03', 'Create intent', ['01', '2'], 'open', 'ready-for-agent', [1, 0]]);
  assert.deepEqual(parseTicketFile('# 01: x\n\n**Blocked by:** None (can start immediately)\n', '01-x.md').blockedBy, []);
});

test('wayfinder local ticket: Type + Status claimed/resolved + Answer', () => {
  const t = parseTicketFile('# 01: Engines\n\nType: research\nStatus: resolved\n\n## Answer\n\nTypesense.', '01-engines.md');
  assert.deepEqual([t.type, t.status, t.answer], ['research', 'done', 'Typesense.']);
  assert.equal(parseTicketFile('Type: grilling\nStatus: claimed', '02-x.md').status, 'claimed');
});

test('wayfinder map body sections', () => {
  const m = parseMap('## Destination\n\nA spec.\n\n## Decisions so far\n\n<!-- index -->\n- [Pick engine](#41): Typesense\n\n## Not yet specified\n\n- Stemming\n\n## Out of scope\n\n- Voice: no surface');
  assert.equal(m.destination, 'A spec.');
  assert.deepEqual(m.decisions, [{ title: 'Pick engine', link: '#41', gist: 'Typesense' }]);
  assert.deepEqual(m.fog, ['Stemming']);
  assert.deepEqual(m.oos, [{ title: 'Voice', why: 'no surface' }]);
});

test('fixture: efforts, sibling blocked-by ids, inbox issues', async () => {
  const { efforts, issues } = await readLocal(FIX);
  assert.deepEqual(efforts.map(e => `${e.kind}:${e.id}:${e.tickets.length}`).sort(), ['map:search-rewrite:5', 'spec:checkout-v2:6', 'spec:gift-cards:0']);
  const co = efforts.find(e => e.id === 'checkout-v2');
  assert.deepEqual(co.tickets.find(t => t.label === '06').blockedBy, ['checkout-v2:03', 'checkout-v2:05']);
  assert.deepEqual(issues.map(i => i.state), [null, 'needs-triage', 'ready-for-agent']);
});

test('GitHub body conventions', () => {
  assert.equal(parentFromBody('## Parent\n\n#130\n\n## What to build'), 130);
  assert.equal(parentFromBody('Part of #140\n\n## Question'), 140);
  assert.deepEqual(blockedFromBody('## Blocked by\n\n- #131\n- #135'), [131, 135]);
  assert.deepEqual(blockedFromBody('Blocked by: #2, #3\n## Question'), [2, 3]);
  assert.deepEqual(blockedFromBody('## Blocked by\n\nNone (can start immediately)'), []);
});

test('GitHub classify: map via label + sub-issues, spec via Parent bodies, rest is triage', () => {
  const now = new Date().toISOString(), n = (number, title, body = '', extra = {}) => ({ number, title, body, state: 'OPEN', createdAt: now, updatedAt: now, url: '', author: { login: 'a' }, assignees: { nodes: [] }, labels: { nodes: [] }, ...extra });
  const nodes = [
    n(140, 'Search', '## Destination\n\nA spec', { labels: { nodes: [{ name: 'wayfinder:map' }] }, subIssues: { nodes: [{ number: 141 }, { number: 142 }] } }),
    n(141, 'Engine', '', { state: 'CLOSED', labels: { nodes: [{ name: 'wayfinder:research' }] } }),
    n(142, 'Ranking', '', { labels: { nodes: [{ name: 'wayfinder:grilling' }] }, assignees: { nodes: [{ login: 'me' }] }, blockedBy: { nodes: [{ number: 141, state: 'CLOSED' }] } }),
    n(130, 'Checkout', '## Problem Statement\n\nx\n\n## User Stories\n\n1. a\n2. b'),
    n(131, 'Slice A', '## Parent\n\n#130\n\n- [x] one'),
    n(132, 'Slice B', '## Parent\n\n#130\n\n## Blocked by\n\n- #131'),
    n(99, 'Bug', 'broken', { labels: { nodes: [{ name: 'bug' }, { name: 'needs-triage' }] } }),
  ];
  const { efforts, issues } = classify(nodes, { labelMap: { 'needs-triage': 'needs-triage' } });
  const map = efforts.find(e => e.id === '#140'), spec = efforts.find(e => e.id === '#130');
  assert.equal(map.kind, 'map'); assert.deepEqual(map.tickets.map(t => `${t.id}:${t.status}:${t.type}`), ['#141:done:research', '#142:claimed:grilling']);
  assert.equal(spec.kind, 'spec'); assert.equal(spec.stories, 2); assert.deepEqual(spec.tickets.find(t => t.id === '#132').blockedBy, ['#131']);
  assert.deepEqual(issues.map(i => `${i.id}:${i.cat}:${i.state}`), ['#99:bug:needs-triage']);
});

test('next-move engine on the fixture', async () => {
  const m = await buildModel(FIX); E.bind({ ...m, sessions: [] });
  const co = E.effById('checkout-v2'), sr = E.effById('search-rewrite'), gc = E.effById('gift-cards');
  const t = l => co.tickets.find(x => x.label === l);
  assert.equal(E.stateOf(t('03'), co), 'ready');
  assert.equal(E.stateOf(t('06'), co), 'blocked');
  assert.match(E.nextFor(t('03'), co).cmd, /^\/implement \.scratch\/checkout-v2\/issues\/03-/);
  assert.match(E.effortNext(co).cmd, /^\/implement-spec \.scratch\/checkout-v2\/spec\.md$/);
  assert.match(E.effortNext(gc).cmd, /^\/to-tickets /);
  assert.equal(E.stageOf(co), 'implement'); assert.equal(E.stageOf(gc), 'tickets');
  const r = l => sr.tickets.find(x => x.label === l);
  assert.equal(E.stateOf(r('04'), sr), 'ready');              // research is AFK
  assert.equal(E.stateOf(r('03'), sr), 'you');                // task needs a human
  assert.equal(E.stateOf(r('05'), sr), 'blocked');
  assert.match(E.nextFor(r('04'), sr).cmd, /^\/wayfinder \.scratch\/search-rewrite\/map\.md \.scratch\/search-rewrite\/issues\/04-/);
  assert.equal(E.issueNext(m.issues.find(i => i.oos)).cmd.startsWith('/triage'), true);
  E.bind({ ...m, sessions: [{ id: 'agent-x', name: 'x', ticket: t('03').id, st: 'waiting' }] });
  assert.equal(E.stateOf(t('03'), co), 'you');                // a spawned agent waiting on you
});

test('engine: map with nothing open and no fog collapses to /to-spec; lint finds cycles', () => {
  const e = { id: 'm', ref: 'map.md', kind: 'map', fog: [], tickets: [{ id: 'a', ref: 'a', blockedBy: [], status: 'done' }] };
  E.bind({ efforts: [e], sessions: [] });
  assert.equal(E.effortNext(e).cmd, '/to-spec map.md');
  const c = { id: 'c', kind: 'spec', tickets: [{ id: 'x', blockedBy: ['y'], status: 'open' }, { id: 'y', blockedBy: ['x'], status: 'open' }] };
  assert.equal(E.lint(c).length, 1);
  assert.doesNotThrow(() => E.layout(c));
});

test('question parsing from an agent turn', () => {
  assert.deepEqual(parseQuestion('Read it.\nQUESTION: Expire cards?\nRECOMMENDED: No.\nOPTIONS: Never | 12 months'), { q: 'Expire cards?', rec: 'No.', opts: ['Never', '12 months'] });
  assert.equal(parseQuestion('All set.\nDONE: added tests'), null);
  assert.equal(parseQuestion('Should I continue with the migration?').q, 'Should I continue with the migration?');
});

test('out-of-scope matching by concept words', () => {
  assert.equal(oosMatch('Dark mode for the storefront', ['dark-mode', 'graphql-api']), 'dark-mode');
  assert.equal(oosMatch('Coupon applies twice', ['dark-mode']), null);
});
