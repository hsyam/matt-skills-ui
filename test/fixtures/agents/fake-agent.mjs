#!/usr/bin/env node
// Stands in for `opencode run --format json` in tests. Prints opencode-style events for one turn:
// echoes the prompt, asks a QUESTION when the prompt contains ASK, and exits 3 when it contains FAIL.
const argv = process.argv.slice(2), i = argv.indexOf('-s');
const sessionID = i >= 0 ? argv[i + 1] : 'ses_fake1';
const prompt = argv[argv.indexOf('--') + 1] || '';
const out = (type, part) => console.log(JSON.stringify({ type, sessionID, part }));
if (prompt.includes('FAIL')) { console.error('boom'); process.exit(3); }
out('step_start', {});
out('tool_use', { tool: 'bash', state: { input: { command: 'ls' } } });
out('text', { text: prompt.includes('ASK') ? 'Read it.\nQUESTION: Expire cards?\nRECOMMENDED: No.\nOPTIONS: Never | 12 months' : `${i >= 0 ? 'resumed' : 'fresh'}: ${prompt.split('\n').pop()}\nDONE: echoed` });
out('step_finish', { tokens: { input: 1500, cache: { read: 500, write: 0 } }, cost: 0.01 });
