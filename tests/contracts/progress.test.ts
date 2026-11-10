import test from 'node:test';
import assert from 'node:assert/strict';
import { commandLabel, formatProgressLine, parseProgressLine, progressFromLine, ProgressThrottle, type ProgressUpdate } from '@autos/contracts';

const claude = (name: string, input: Record<string, unknown>, text = 'I will now look around the codebase') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name, input }] } });

test('stream lines become narrative-free progress actions for each provider', () => {
  const seen = new Set<string>();
  assert.deepEqual(progressFromLine(claude('Bash', { command: 'cd /workspace && rg -n "assocType" src/main --glob "*.js"' }), seen), [{ kind: 'command', label: 'rg -n "assocType"' }]);
  assert.deepEqual(progressFromLine(claude('Edit', { file_path: '/workspace/src/a.js', old_string: 'secret body', new_string: 'x' }), seen), [{ kind: 'edit', label: 'src/a.js' }]);
  assert.deepEqual(progressFromLine(claude('Read', { file_path: '/home/worker/.claude/notes.md' }), seen), [{ kind: 'read', label: 'notes.md' }]);
  assert.deepEqual(progressFromLine(claude('Grep', { pattern: 'TODO' }), seen), [{ kind: 'search', label: 'Grep TODO' }]);
  assert.deepEqual(progressFromLine(claude('TodoWrite', { todos: [] }), seen), [{ kind: 'other', label: 'TodoWrite' }]);
  // Codex: started/completed pairs are reported once; file changes one per path.
  const started = JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "bash -lc 'mvn -q -o test-compile -DskipTests'" } });
  const completed = JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "bash -lc 'mvn -q -o test-compile -DskipTests'", aggregated_output: 'BUILD SUCCESS secret' } });
  assert.deepEqual(progressFromLine(started, seen), [{ kind: 'command', label: 'mvn -q -o' }]);
  assert.deepEqual(progressFromLine(completed, seen), []);
  assert.deepEqual(progressFromLine(JSON.stringify({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: '/workspace/a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] } }), seen), [{ kind: 'edit', label: 'a.ts' }, { kind: 'edit', label: 'b.ts' }]);
  // Cursor tool calls.
  assert.deepEqual(progressFromLine(JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: '/usr/bin/git status --short' } } } }), seen), [{ kind: 'command', label: 'git status --short' }]);
  // Narrative, reasoning, results and junk produce nothing.
  for (const line of [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Thinking hard' }] } }), JSON.stringify({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'plan' } }), JSON.stringify({ type: 'result', result: 'done' }), 'not json', '']) {
    assert.deepEqual(progressFromLine(line, seen), []);
  }
});

test('command labels keep the executable and two arguments, scrubbed of secrets', () => {
  assert.equal(commandLabel('npm test -- tests/a.test.ts'), 'npm test --');
  const curl = commandLabel('sh -c "curl -H \'Authorization: Bearer abc.def\' https://x.example/api"');
  assert.match(curl, /^curl -H /); assert.doesNotMatch(curl, /abc\.def|example/);
  assert.equal(commandLabel('TOKEN=abcd1234 ./run.sh'), 'TOKEN=[redacted] ./run.sh');
  assert.equal(commandLabel(''), 'command');
  assert.doesNotMatch(commandLabel(`echo ${'a'.repeat(40)}`), /aaaa/);
});

test('progress lines round-trip and reject anything else', () => {
  const update: ProgressUpdate = { kind: 'edit', label: 'src/a.js', skipped: 2 };
  assert.deepEqual(parseProgressLine(formatProgressLine(update)), update);
  for (const bad of ['{"autos_progress":{"kind":"edit","label":"x\\ny","skipped":0}}', '{"autos_progress":{"kind":"edit","label":"x","skipped":0,"extra":1}}', '{"autos_progress":{"kind":"hack","label":"x","skipped":0}}', '{"other":1}', `{"autos_progress":{"kind":"edit","label":"${'x'.repeat(2000)}","skipped":0}}`, 'plain stderr text']) {
    assert.equal(parseProgressLine(bad), null, bad.slice(0, 60));
  }
});

test('the throttle emits at once, folds bursts into a count, flushes the latest after the interval, and caps output', async () => {
  let now = 0; const out: ProgressUpdate[] = [];
  const throttle = new ProgressThrottle({ intervalMs: 20, maxUpdates: 3, emit: (u) => out.push(u), now: () => now });
  throttle.push({ kind: 'command', label: 'a' });
  throttle.push({ kind: 'read', label: 'b' });
  throttle.push({ kind: 'edit', label: 'c' }, 4);
  assert.deepEqual(out, [{ kind: 'command', label: 'a', skipped: 0 }]);
  now = 20; await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(out[1], { kind: 'edit', label: 'c', skipped: 5 });
  now = 100; throttle.push({ kind: 'read', label: 'd' });
  now = 200; throttle.push({ kind: 'read', label: 'e' });
  assert.equal(out.length, 3); assert.equal(throttle.count, 3);
  throttle.push({ kind: 'read', label: 'f' }); throttle.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(out.length, 3);
  const throwing = new ProgressThrottle({ intervalMs: 0, emit: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => throwing.push({ kind: 'other', label: 'x' }));
});
