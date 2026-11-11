import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { KNOWLEDGE_MCP_SERVER, KNOWLEDGE_TOOLS } from '@autos/contracts';

const shimPath = resolve('docker/worker/knowledge-mcp.mjs');
const { createShim } = (await import(pathToFileURL(shimPath).href)) as {
  createShim(options: { url?: string | undefined; token?: string | undefined; fetch?: typeof fetch; write: (line: string) => void; timeoutMs?: number }): { handleLine(line: string): Promise<void> };
};

const TOKEN = 'tok_SECRET_0123456789abcdef0123456789abcdef';
const URL_BASE = 'http://gateway.test:8791/';
type Fetch = typeof fetch;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(fetchImpl: Fetch, options: { url?: string | undefined; token?: string | undefined } = {}) {
  const lines: string[] = [];
  const shim = createShim({ url: 'url' in options ? options.url : URL_BASE, token: 'token' in options ? options.token : TOKEN, fetch: fetchImpl, write: (line) => lines.push(line) });
  const messages = () => lines.map((line) => JSON.parse(line) as Record<string, any>);
  const send = (message: unknown) => shim.handleLine(JSON.stringify(message));
  return { lines, messages, send, shim };
}
const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const unavailable = { content: [{ type: 'text', text: 'UNAVAILABLE: the knowledge gateway could not be reached' }], isError: true };
const noFetch: Fetch = async () => { throw new Error('must not be called'); };

test('initialize echoes the requested protocol version, with a default', async () => {
  const h = harness(noFetch);
  await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  const [a, b] = h.messages();
  assert.deepEqual(a, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: KNOWLEDGE_MCP_SERVER, version: '1' } } });
  assert.equal(b?.result.protocolVersion, '2025-06-18');
});

test('tools/list returns exactly the contract tools with their schemas; ping and probes work', async () => {
  const h = harness(noFetch);
  await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await h.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await h.send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  await h.send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  await h.send({ jsonrpc: '2.0', id: 5, method: 'nope/nope' });
  const m = h.messages();
  assert.deepEqual(m[0]?.result.tools, KNOWLEDGE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
  assert.deepEqual(m[1]?.result, {});
  assert.deepEqual(m[2]?.result, { resources: [] });
  assert.deepEqual(m[3]?.result, { prompts: [] });
  assert.equal(m[4]?.error.code, -32601);
});

test('a successful call posts to the gateway and returns the content', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const h = harness((async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return jsonResponse({ ok: true, content: [{ type: 'text', text: 'hello' }] });
  }) as unknown as Fetch);
  await h.send(call(7, 'jira_get_issue', { issue_key: 'ABC-1' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'http://gateway.test:8791/v1/tools/jira_get_issue');
  assert.equal(seen[0]?.init.method, 'POST');
  assert.deepEqual(seen[0]?.init.headers, { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
  assert.equal(seen[0]?.init.body, JSON.stringify({ issue_key: 'ABC-1' }));
  assert.equal(seen[0]?.init.redirect, 'error');
  assert.ok(seen[0]?.init.signal);
  assert.deepEqual(h.messages(), [{ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'hello' }], isError: false } }]);
});

test('missing arguments are sent as an empty object', async () => {
  let body: unknown;
  const h = harness((async (_url: string, init: RequestInit) => { body = init.body; return jsonResponse({ ok: true, content: [{ type: 'text', text: 'x' }] }); }) as unknown as Fetch);
  await h.send(call(1, 'jira_search'));
  assert.equal(body, '{}');
});

test('ok:false maps to a tool error with CODE: message, regardless of HTTP status', async () => {
  const h = harness((async () => jsonResponse({ ok: false, code: 'FORBIDDEN', message: 'Space not allowed' }, 403)) as unknown as Fetch);
  await h.send(call(1, 'confluence_get_page', { page: '1' }));
  assert.deepEqual(h.messages()[0]?.result, { content: [{ type: 'text', text: 'FORBIDDEN: Space not allowed' }], isError: true });
});

test('truncated results get a marker block', async () => {
  const h = harness((async () => jsonResponse({ ok: true, content: [{ type: 'text', text: 'a' }], truncated: true })) as unknown as Fetch);
  await h.send(call(1, 'jira_get_comments', { issue_key: 'ABC-1' }));
  assert.deepEqual(h.messages()[0]?.result.content, [{ type: 'text', text: 'a' }, { type: 'text', text: '[result truncated]' }]);
});

test('an unknown tool is a -32602 error and never reaches the gateway', async () => {
  const h = harness(noFetch);
  await h.send(call(1, 'jira_delete_issue', {}));
  await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
  assert.equal(h.messages()[0]?.error.code, -32602);
  assert.equal(h.messages()[1]?.error.code, -32602);
});

test('gateway failures are UNAVAILABLE tool errors', async () => {
  const cases: Fetch[] = [
    (async () => { throw new TypeError(`connect failed ${URL_BASE} ${TOKEN}`); }) as unknown as Fetch,
    (async () => new Response('<html>nope</html>', { status: 502 })) as unknown as Fetch,
    (async () => jsonResponse({ ok: true, content: [] })) as unknown as Fetch,
    (async () => jsonResponse({ ok: false, code: 'WHATEVER', message: 'x' })) as unknown as Fetch,
    (async () => jsonResponse({ ok: true, content: [{ type: 'text', text: 'x' }], extra: 1 })) as unknown as Fetch,
  ];
  for (const fetchImpl of cases) {
    const h = harness(fetchImpl);
    await h.send(call(1, 'jira_get_issue', { issue_key: 'ABC-1' }));
    assert.deepEqual(h.messages()[0]?.result, unavailable);
    assert.ok(!h.lines.join('').includes(TOKEN));
  }
});

test('missing or invalid environment still serves initialize and list but fails calls', async () => {
  for (const options of [{ url: undefined, token: TOKEN }, { url: 'ftp://x', token: TOKEN }, { url: 'not a url', token: TOKEN }, { url: URL_BASE, token: '' }, { url: URL_BASE, token: undefined }]) {
    const h = harness(noFetch, options);
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await h.send(call(3, 'jira_get_issue', { issue_key: 'ABC-1' }));
    const m = h.messages();
    assert.equal(m[0]?.result.serverInfo.name, KNOWLEDGE_MCP_SERVER);
    assert.equal(m[1]?.result.tools.length, KNOWLEDGE_TOOLS.length);
    assert.deepEqual(m[2]?.result, unavailable);
  }
});

test('notifications produce no output', async () => {
  const h = harness(noFetch);
  await h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await h.send({ jsonrpc: '2.0', method: 'tools/list' });
  assert.deepEqual(h.lines, []);
});

test('malformed and oversized lines get -32700 with a null id', async () => {
  const h = harness(noFetch);
  await h.shim.handleLine('{not json');
  await h.shim.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_048_600) }));
  assert.deepEqual(h.messages().map((m) => [m.id, m.error.code]), [[null, -32700], [null, -32700]]);
});

test('concurrent calls are answered by id, in completion order', async () => {
  const releases: Record<string, () => void> = {};
  const h = harness((async (url: string) => {
    const name = url.split('/').pop() as string;
    await new Promise<void>((resolveGate) => { releases[name] = resolveGate; });
    return jsonResponse({ ok: true, content: [{ type: 'text', text: name }] });
  }) as unknown as Fetch);
  const slow = h.send(call(1, 'jira_get_issue', { issue_key: 'ABC-1' }));
  const fast = h.send(call(2, 'confluence_get_page', { page: '1' }));
  await h.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(h.messages().map((m) => m.id), [3]);
  releases.confluence_get_page?.();
  await fast;
  releases.jira_get_issue?.();
  await slow;
  assert.deepEqual(h.messages().map((m) => [m.id, m.result.content?.[0]?.text]), [[3, undefined], [2, 'confluence_get_page'], [1, 'jira_get_issue']]);
});

test('over real stdio the shim talks to a local gateway and leaks nothing to stdout', async (t) => {
  const requests: { url?: string | undefined; auth?: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'from gateway' }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', shimPath], {
    env: { ...process.env, AUTOS_KNOWLEDGE_URL: `http://127.0.0.1:${port}`, AUTOS_KNOWLEDGE_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((done) => child.on('close', done));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify(call(2, 'jira_get_issue', { issue_key: 'ABC-1' }))}\n`);
  child.stdin.end();
  const code = await exited;
  assert.equal(code, 0, stderr);
  const replies = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
  assert.equal(replies.length, 2);
  assert.equal(replies.find((r) => r.id === 1)?.result.protocolVersion, '2025-03-26');
  assert.deepEqual(replies.find((r) => r.id === 2)?.result, { content: [{ type: 'text', text: 'from gateway' }], isError: false });
  assert.deepEqual(requests, [{ url: '/v1/tools/jira_get_issue', auth: `Bearer ${TOKEN}`, body: '{"issue_key":"ABC-1"}' }]);
  assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN));
});
