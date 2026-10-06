import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../skills/matt-skills-ui/server/lib/agents.mjs';
import { Sessions } from '../skills/matt-skills-ui/server/lib/sessions.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agents');
const feed = (agent, lines) => { const p = AGENTS[agent].parser(); return lines.flatMap(l => p(typeof l === 'string' ? l : JSON.stringify(l))); };
const kinds = evs => evs.filter(e => e.k !== 'init').map(e => e.k + (e.t ? ':' + e.t : ''));

test('opencode parser on real `opencode run --format json` output (1.18)', () => {
  const evs = feed('opencode', readFileSync(path.join(DIR, 'opencode-turn.jsonl'), 'utf8').split('\n'));
  assert.equal(evs.find(e => e.k === 'init').sessionId, 'ses_eeea9145fffelXtIeDLRnTfEJw');
  assert.deepEqual(kinds(evs).filter(k => !k.startsWith('ctx')), ['tool:bash: cat a.txt', 'text:hello']);
  assert.equal(evs.filter(e => e.k === 'ctx').pop().ctx, 25);
});

test('codex parser on real `codex exec --json` output (0.156)', () => {
  const evs = feed('codex', readFileSync(path.join(DIR, 'codex-turn.jsonl'), 'utf8').split('\n'));
  assert.equal(evs[0].sessionId, '01a11157-229f-7df1-97c0-3baf5b8fbc4e');
  assert.deepEqual(kinds(evs), ['text:I’ll read `a.txt` and return its exact output.', "tool:shell: 'cat a.txt'", 'text:hello']);
});

test('claude, cursor, gemini and pi parsers', () => {
  assert.deepEqual(kinds(feed('claude', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.md' } }] } }, { type: 'result', result: 'hi' }])), ['text:hi', 'tool:Read: a.md', 'end']);
  const cur = feed('cursor', [{ type: 'system', subtype: 'init', session_id: 'c1', model: 'auto' }, { type: 'tool_call', subtype: 'started', session_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' } } } }, { type: 'assistant', session_id: 'c1', message: { content: [{ type: 'text', text: 'done' }] } }, { type: 'result', session_id: 'c1', result: 'done' }]);
  assert.equal(cur[0].sessionId, 'c1'); assert.deepEqual(kinds(cur), ['tool:shell: ls', 'text:done', 'end']);
  const gem = feed('gemini', [{ type: 'init', session_id: 'g1', model: 'gemini-x' }, { type: 'message', role: 'assistant', content: 'Hel', delta: true }, { type: 'message', role: 'assistant', content: 'lo', delta: true }, { type: 'tool_use', tool_name: 'run_shell_command', parameters: { command: 'ls' } }, { type: 'result', status: 'success' }]);
  assert.equal(gem[0].sessionId, 'g1'); assert.deepEqual(kinds(gem), ['text:Hello', 'tool:run_shell_command: ls', 'end']);
  const pi = feed('pi', [{ type: 'message_end', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }], usage: { input: 2000, cacheRead: 1000 } } }]);
  assert.deepEqual(kinds(pi), ['text:ok', 'tool:bash: ls', 'ctx']);
});

test('per-turn args resume the session the first turn created', () => {
  assert.deepEqual(AGENTS.opencode.args({ mode: 'plan', resume: 'ses_1', prompt: '-x' }), ['run', '--format', 'json', '--agent', 'plan', '-s', 'ses_1', '--', '-x']);
  assert.deepEqual(AGENTS.codex.args({ mode: 'read-only', resume: 't1' }), ['exec', 'resume', 't1', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-']);
  assert.deepEqual(AGENTS.cursor.args({ mode: 'force', model: 'gpt-5', resume: 'c1' }), ['--print', '--output-format', 'stream-json', '--trust', '--force', '--model', 'gpt-5', '--resume', 'c1']);
});

test('per-turn session: question, answer resumes, queue, stop, failed turn', async () => {
  process.env.MATT_SKILLS_UI_OPENCODE_BIN = path.join(DIR, 'fake-agent.mjs');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'msu-agents-'));
  const ss = new Sessions({ repo: tmp, dataDir: tmp, cliPath: 'cli.mjs' });
  const until = async f => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 30)); assert.ok(f()); };
  const s = await ss.spawn({ prompt: 'ASK me', agent: 'opencode', mode: 'nonsense' });
  assert.equal(s.mode, 'build');
  await until(() => s.st === 'waiting');
  assert.equal(s.sessionId, 'ses_fake1'); assert.equal(s.resume, 'opencode -s ses_fake1'); assert.equal(s.ctx, 2);
  const q = ss.questions.find(x => x.from === s.id); assert.equal(q.q, 'Expire cards?');
  ss.answer(q.id, '__rec');
  ss.send(s.id, 'second');
  assert.match(s.log.at(-1).t, /^Queued/);
  await until(() => s.st === 'waiting' && s.log.filter(l => l.w === 'agent').length === 3);
  assert.deepEqual(s.log.filter(l => l.w === 'agent').slice(1).map(l => l.t.split('\n')[0]), ['resumed: Go with your recommendation: No.', 'resumed: second']);
  assert.equal(s.done, true); assert.equal(s.turns, 3);
  ss.send(s.id, 'FAIL');
  await until(() => s.st === 'waiting' && s.log.some(l => /code 3/.test(l.t)));
  ss.stop(s.id); assert.equal(s.st, 'ended');
  ss.send(s.id, 'back again');
  await until(() => s.st === 'waiting' && s.log.at(-1).t.startsWith('resumed: back again'));
});
