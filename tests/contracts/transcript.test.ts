import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSCRIPT_ACTION_LIMIT, summarizeTranscriptActions } from '@autos/contracts';

const line = (value: unknown) => JSON.stringify(value);
const claudeTool = (name: string, input: Record<string, unknown>) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });

test('claude stream-json tool_use blocks yield tool and primary target', () => {
  const text = [
    line({ type: 'system', subtype: 'init' }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will read the file' }, { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/src/App.java' } }] } }),
    claudeTool('Bash', { command: 'mvn -q test', description: 'run tests' }),
    claudeTool('Grep', { pattern: 'TODO', path: 'src' }),
    claudeTool('Glob', { pattern: '**/*.ts' }),
    claudeTool('WebFetch', { url: 'https://example.com/a?token=x', prompt: 'p' }),
    claudeTool('TodoWrite', { todos: [] }),
    line({ type: 'result', subtype: 'success', result: 'done' }),
  ].join('\n');
  assert.deepEqual(summarizeTranscriptActions(text), [
    { tool: 'Read', target: 'src/App.java' },
    { tool: 'Bash', target: 'mvn -q test' },
    { tool: 'Grep', target: 'src' },
    { tool: 'Glob', target: '**/*.ts' },
    { tool: 'WebFetch', target: '[url]' },
    { tool: 'TodoWrite', target: '' },
  ]);
});

test('cursor tool_call started events are summarized; completed results are not', () => {
  const text = [
    line({ type: 'tool_call', subtype: 'started', call_id: '1', tool_call: { readToolCall: { args: { path: 'README.md' } } } }),
    line({ type: 'tool_call', subtype: 'completed', call_id: '1', tool_call: { readToolCall: { args: { path: 'README.md' }, result: { success: { content: 'SECRET_CONTENT' } } } } }),
    line({ type: 'tool_call', subtype: 'started', call_id: '2', tool_call: { shellToolCall: { args: { command: 'npm test' } } } }),
    line({ type: 'tool_call', subtype: 'started', call_id: '3', tool_call: { function: { name: 'edit_file', arguments: '{"path":"src/a.ts"}' } } }),
  ].join('\n');
  assert.deepEqual(summarizeTranscriptActions(text), [
    { tool: 'read', target: 'README.md' },
    { tool: 'shell', target: 'npm test' },
    { tool: 'edit_file', target: 'src/a.ts' },
  ]);
});

test('codex items: commands, file changes, mcp calls, de-duplicated by id', () => {
  const text = [
    line({ type: 'thread.started' }),
    line({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'thinking hard' } }),
    line({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', status: 'in_progress' } }),
    line({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'password=hunter2', exit_code: 0 } }),
    line({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: '/workspace/a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }], status: 'completed' } }),
    line({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 's', tool: 'search_docs', arguments: { pattern: 'x' } } }),
    line({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'All done' } }),
    line({ type: 'turn.completed' }),
  ].join('\n');
  assert.deepEqual(summarizeTranscriptActions(text), [
    { tool: 'command', target: 'bash -lc ls' },
    { tool: 'file_change:update', target: 'a.ts' },
    { tool: 'file_change:add', target: 'b.ts' },
    { tool: 'search_docs', target: 'x' },
  ]);
});

test('returns the last `limit` actions in order', () => {
  const text = Array.from({ length: 40 }, (_, i) => claudeTool('Read', { file_path: `f${i}.ts` })).join('\n');
  const all = summarizeTranscriptActions(text);
  assert.equal(all.length, TRANSCRIPT_ACTION_LIMIT);
  assert.equal(all[0]?.target, 'f25.ts');
  assert.equal(all.at(-1)?.target, 'f39.ts');
  assert.deepEqual(summarizeTranscriptActions(text, 3).map((a) => a.target), ['f37.ts', 'f38.ts', 'f39.ts']);
  assert.deepEqual(summarizeTranscriptActions(text, 0), []);
  assert.deepEqual(summarizeTranscriptActions(text, Number.NaN).length, TRANSCRIPT_ACTION_LIMIT);
});

test('tool outputs, assistant text and stderr never appear', () => {
  const secret = 'sk-live-THISISASECRETVALUE';
  const text = [
    claudeTool('Read', { file_path: 'config.env' }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: `API_KEY=${secret}` }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: `the key is ${secret}` }, { type: 'thinking', thinking: secret }] } }),
    '[stderr]',
    claudeTool('Bash', { command: `echo ${secret}` }),
  ].join('\n');
  const actions = summarizeTranscriptActions(text);
  assert.deepEqual(actions, [{ tool: 'Read', target: 'config.env' }]);
  assert.equal(JSON.stringify(actions).includes('SECRET'), false);
});

test('targets are sanitized, redacted and truncated; tool names are constrained', () => {
  const hex = 'a1b2c3d4'.repeat(6);
  const actions = summarizeTranscriptActions([
    claudeTool('Bash', { command: 'curl -H "Authorization: Bearer abc.def" https://user:pw@host/x\n\tapi_key=XYZ123 token: "q w" PASSWORD=p' }),
    claudeTool('Bash', { command: `git log ${hex} --oneline` }),
    claudeTool('Bash', { command: `echo ${'x '.repeat(200)}` }),
    claudeTool('bad name!', { file_path: 'a\u0000b\u001b[31mc' }),
    claudeTool('x'.repeat(41), { file_path: 'ok' }),
  ].join('\n'));
  assert.equal(actions[0]?.target, 'curl -H "Authorization: Bearer [redacted] [url] api_key=[redacted] token: [redacted] PASSWORD=[redacted]');
  assert.equal(actions[1]?.target, 'git log [redacted] --oneline');
  assert.equal(actions[2]?.target.length, 160);
  assert.ok(actions[2]?.target.endsWith('…'));
  assert.deepEqual(actions[3], { tool: 'tool', target: 'a b [31mc' });
  assert.equal(actions[4]?.tool, 'tool');
});

test('malformed input never throws', () => {
  const garbage = [
    'not json', '{', '[transcript truncated]', '{"type":"assistant","message":{"content":"x"}}', '{"type":"assistant","message":null}',
    '{"type":"assistant","message":{"content":[null,1,{"type":"tool_use"}]}}', '{"type":"tool_call","subtype":"started","tool_call":{"ToolCall":1}}',
    '{"type":"item.completed","item":{"type":"file_change","changes":[null,{"kind":5}]}}', '{"type":"item.completed","item":{"type":"command_execution","command":["git","status"]}}',
    '[1,2,3]', 'null', '"string"',
  ].join('\n');
  assert.deepEqual(summarizeTranscriptActions(garbage), [
    { tool: 'tool', target: '' },
    { tool: 'file_change', target: '' },
    { tool: 'command', target: 'git status' },
  ]);
  assert.deepEqual(summarizeTranscriptActions(''), []);
  assert.deepEqual(summarizeTranscriptActions(undefined as unknown as string), []);
});

test('only the tail of very large transcripts is inspected', () => {
  const filler = claudeTool('Read', { file_path: 'early.ts' });
  const padding = `${'x'.repeat(2_100_000)}`;
  const text = [filler, padding, claudeTool('Read', { file_path: 'late.ts' })].join('\n');
  assert.deepEqual(summarizeTranscriptActions(text), [{ tool: 'Read', target: 'late.ts' }]);
});
