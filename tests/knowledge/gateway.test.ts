import test from 'node:test';
import assert from 'node:assert/strict';
import { AutosError, knowledgeCallResponseSchema, knowledgeConfigSchema, type KnowledgeCallResponse, type KnowledgePage, type KnowledgeReadPort } from '@autos/contracts';
import { KnowledgeGateway } from '../../apps/controller/src/knowledge-gateway.js';

const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope = { job_id: JOB, issue_key: 'CMS2-1', role: 'swe' as const };
const page = (over: Partial<KnowledgePage> = {}): KnowledgePage => ({ id: '100', title: 'Fix notes', space_key: 'KB', ancestor_ids: ['1'], updated: '2026-01-01', body: 'body text', ...over });

let nextPort = 21000 + (process.pid % 2000) * 10;
function harness(knowledgeOver: Record<string, unknown> = {}, readsOver: Partial<KnowledgeReadPort> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const base: KnowledgeReadPort = {
    getIssueDetail: async (key) => ({ key, project_key: 'CMS2', summary: 'Broken list', description: 'It breaks', issue_type: 'Bug', status: 'Done', resolution: 'Fixed', labels: ['ui'], components: [], created: 'c', updated: 'u', links: [{ key: 'CMS2-9', relation: 'relates to', summary: 'Other', status: 'Open' }], attachments: [{ id: '7', filename: 'trace.log', mime_type: 'text/plain', size: 5, created: 'c', author: 'Pat' }] }),
    getIssueComments: async () => [{ id: '1', author: 'Pat', created: 'c', body: 'Seen on prod' }],
    getIssueAttachment: async (_key, id) => id === '8' ? { meta: { id, filename: 'shot.png', mime_type: 'image/png', size: 3, created: 'c', author: 'Pat' }, data: new Uint8Array([1, 2, 3]) } : id === '9' ? { meta: { id, filename: 'dump.bin', mime_type: 'application/octet-stream', size: 3, created: 'c', author: 'Pat' }, data: new Uint8Array([1, 2, 3]) } : { meta: { id, filename: 'trace.log', mime_type: 'text/plain', size: 5, created: 'c', author: 'Pat' }, data: new TextEncoder().encode('stack') },
    searchIssues: async () => [{ key: 'CMS2-5', summary: 'Similar', status: 'Done', resolution: 'Fixed', updated: 'u' }, { key: 'SECRET-1', summary: 'Leak', status: 'Done', resolution: null, updated: 'u' }],
    searchPages: async () => [{ id: '100', title: 'Fix notes', space_key: 'KB', excerpt: 'how we fixed it', updated: 'u' }, { id: '200', title: 'HR', space_key: 'HR', excerpt: 'private', updated: 'u' }],
    getPage: async (id) => page({ id }),
    getPageChildren: async () => [{ id: '101', title: 'Child', space_key: 'KB', excerpt: '', updated: 'u' }],
  };
  const reads = Object.fromEntries(Object.entries({ ...base, ...readsOver }).map(([name, fn]) => [name, (...args: unknown[]) => { calls.push({ method: name, args }); return (fn as (...a: unknown[]) => unknown)(...args); }])) as unknown as KnowledgeReadPort;
  const knowledge = knowledgeConfigSchema.parse({ enabled: true, gateway: { port: nextPort++ }, confluence: { spaces: ['KB'], pages: ['555'] }, ...knowledgeOver });
  const logs: Array<Record<string, unknown>> = [];
  const gateway = new KnowledgeGateway({ config: { jira: { allowed_projects: ['CMS2'] }, confluence: { site_url: 'https://example.atlassian.net' }, knowledge } as never, reads, log: (r) => logs.push(r) });
  return { gateway, calls, logs, knowledge };
}
const textOf = (r: KnowledgeCallResponse) => r.ok ? r.content.map((c) => c.type === 'text' ? c.text : `[image ${c.mimeType}]`).join('\n') : `${r.code}: ${r.message}`;

test('sessions exist only when enabled and for configured roles; a closed token stops working', async () => {
  assert.equal(new KnowledgeGateway({ config: { jira: { allowed_projects: ['CMS2'] }, confluence: { site_url: 'https://example.atlassian.net' } } as never, reads: {} as never }).open(scope), null);
  const off = harness({ enabled: false }); assert.equal(off.gateway.open(scope), null);
  const h = harness({ roles: ['qa'] }); assert.equal(h.gateway.open(scope), null);
  try {
    const session = h.gateway.open({ ...scope, role: 'qa' })!;
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(session.url, 'http://host.docker.internal:8791');
    assert.equal((await h.gateway.call(session.token, 'jira_get_comments', { issue_key: 'CMS2-1' })).ok, true);
    assert.equal((await h.gateway.call('x'.repeat(43), 'jira_get_comments', { issue_key: 'CMS2-1' })).ok, false);
    const summary = h.gateway.close(session.token);
    assert.equal(summary.calls, 1); assert.equal(summary.entries[0]!.tool, 'jira_get_comments'); assert.equal(summary.entries[0]!.target, 'CMS2-1');
    const after = await h.gateway.call(session.token, 'jira_get_comments', { issue_key: 'CMS2-1' });
    assert.deepEqual(after, { ok: false, code: 'UNAUTHORIZED', message: 'The knowledge session is not valid' });
    assert.deepEqual(h.gateway.close(session.token), { calls: 0, chars: 0, entries: [] });
  } finally { await h.gateway.stop(); }
});

test('Jira tools enforce the project allow-list before any upstream read and format results', async () => {
  const h = harness(); const { token } = h.gateway.open(scope)!;
  try {
    const issue = await h.gateway.call(token, 'jira_get_issue', { issue_key: 'CMS2-1' });
    assert.match(textOf(issue), /CMS2-1: Broken list[\s\S]*Resolution: Fixed[\s\S]*relates to CMS2-9[\s\S]*id 7: trace\.log/);
    const denied = await h.gateway.call(token, 'jira_get_issue', { issue_key: 'SECRET-1' });
    assert.deepEqual(denied, { ok: false, code: 'FORBIDDEN', message: 'Jira project SECRET is not on the knowledge allow-list' });
    assert.equal((await h.gateway.call(token, 'jira_get_attachment', { issue_key: 'SECRET-1', attachment_id: '7' })).ok, false);
    assert.equal((await h.gateway.call(token, 'jira_search', { query: 'list bug', project: 'SECRET' })).ok, false);
    assert.equal(h.calls.filter((c) => c.method !== 'getIssueDetail').length, 0, 'refused calls never reach Atlassian');
    const search = await h.gateway.call(token, 'jira_search', { query: 'list bug', resolved_only: true });
    assert.match(textOf(search), /CMS2-5/); assert.doesNotMatch(textOf(search), /SECRET-1/, 'hits outside the allow-list are dropped');
    assert.deepEqual(h.calls.at(-1)!.args[0], { text: 'list bug', projects: ['CMS2'], resolvedOnly: true, limit: 10 });
    assert.match(textOf(await h.gateway.call(token, 'jira_get_attachment', { issue_key: 'CMS2-1', attachment_id: '7' })), /trace\.log[\s\S]*stack/);
    const image = await h.gateway.call(token, 'jira_get_attachment', { issue_key: 'CMS2-1', attachment_id: '8' });
    assert.ok(image.ok && image.content[1]!.type === 'image' && image.content[1]!.data === 'AQID');
    assert.match(textOf(await h.gateway.call(token, 'jira_get_attachment', { issue_key: 'CMS2-1', attachment_id: '9' })), /Binary attachment/);
    // jira.projects overrides jira.allowed_projects.
    const custom = harness({ jira: { projects: ['WTS'] } }); const t2 = custom.gateway.open(scope)!.token;
    assert.equal((await custom.gateway.call(t2, 'jira_get_issue', { issue_key: 'CMS2-1' })).ok, false);
    assert.equal((await custom.gateway.call(t2, 'jira_get_issue', { issue_key: 'WTS-1' })).ok, true);
    await custom.gateway.stop();
  } finally { await h.gateway.stop(); }
});

test('Confluence tools enforce spaces and page trees, and only accept the configured site', async () => {
  const h = harness(); const { token } = h.gateway.open(scope)!;
  try {
    const search = await h.gateway.call(token, 'confluence_search', { query: 'null pointer' });
    assert.deepEqual(h.calls.at(-1)!.args[0], { text: 'null pointer', spaces: ['KB'], ancestors: ['555'], limit: 10 });
    assert.match(textOf(search), /page 100 \[KB\] Fix notes/);
    const narrowed = await h.gateway.call(token, 'confluence_search', { query: 'null pointer', space: 'kb' });
    assert.deepEqual(h.calls.at(-1)!.args[0], { text: 'null pointer', spaces: ['KB'], ancestors: [], limit: 10 });
    assert.doesNotMatch(textOf(narrowed), /HR/, 'hits from other spaces are dropped');
    assert.equal(textOf(await h.gateway.call(token, 'confluence_search', { query: 'salary', space: 'HR' })), 'FORBIDDEN: Confluence space HR is not on the knowledge allow-list');
    assert.match(textOf(await h.gateway.call(token, 'confluence_get_page', { page: 'https://example.atlassian.net/wiki/spaces/KB/pages/100/Fix+notes' })), /Fix notes \(page 100, space KB[\s\S]*body text/);
    assert.equal((await h.gateway.call(token, 'confluence_get_page', { page: 'https://evil.example/wiki/spaces/KB/pages/100' })).ok, false);
    assert.equal((await h.gateway.call(token, 'confluence_get_page', { page: 'https://example.atlassian.net/wiki/spaces/KB/overview' })).ok, false);
    assert.match(textOf(await h.gateway.call(token, 'confluence_get_children', { page_id: '100' })), /page 101: Child/);
  } finally { await h.gateway.stop(); }
  const other = harness({}, { getPage: async (id) => page({ id, space_key: 'HR', ancestor_ids: ['9'] }) }); const t = other.gateway.open(scope)!.token;
  assert.equal(textOf(await other.gateway.call(t, 'confluence_get_page', { page: '300' })), 'FORBIDDEN: This page is in space HR, which is not on the knowledge allow-list');
  assert.equal((await other.gateway.call(t, 'confluence_get_children', { page_id: '300' })).ok, false);
  assert.equal(other.calls.some((c) => c.method === 'getPageChildren'), false);
  await other.gateway.stop();
  const tree = harness({}, { getPage: async (id) => page({ id, space_key: 'HR', ancestor_ids: ['9', '555'] }) }); const t3 = tree.gateway.open(scope)!.token;
  assert.equal((await tree.gateway.call(t3, 'confluence_get_page', { page: '300' })).ok, true, 'a descendant of an allowed page is readable');
  await tree.gateway.stop();
  const none = harness({ confluence: { spaces: [], pages: [] } }); const t4 = none.gateway.open(scope)!.token;
  assert.equal((await none.gateway.call(t4, 'confluence_search', { query: 'anything' })).ok, false);
  assert.equal(none.calls.length, 0);
  await none.gateway.stop();
});

test('input is validated, upstream errors are mapped without their text, budgets stop reading, and every call is audited', async () => {
  const h = harness({ limits: { max_calls_per_run: 6, max_result_chars: 1000, max_total_chars_per_run: 1500 } }, {
    getIssueComments: async () => { throw new AutosError('UPSTREAM', 'raw upstream body with secret-token-value'); },
    getPage: async (id) => { if (id === '404') throw new AutosError('NOT_FOUND', 'x'); return page({ id, body: 'y'.repeat(5000) }); },
  });
  const { token } = h.gateway.open(scope)!;
  try {
    assert.equal(textOf(await h.gateway.call(token, 'jira_get_issue', { issue_key: 'CMS2-1', extra: true })), "INVALID_INPUT: Invalid input for jira_get_issue: check the tool's parameters");
    assert.equal((await h.gateway.call(token, 'delete_everything', {})).ok, false);
    const failed = await h.gateway.call(token, 'jira_get_comments', { issue_key: 'CMS2-1' });
    assert.deepEqual(failed, { ok: false, code: 'UNAVAILABLE', message: 'Jira/Confluence could not be read right now' });
    assert.equal(textOf(await h.gateway.call(token, 'confluence_get_page', { page: '404' })).startsWith('NOT_FOUND'), true);
    const big = await h.gateway.call(token, 'confluence_get_page', { page: '100' });
    assert.ok(big.ok && big.truncated === true && big.content[0]!.type === 'text' && big.content[0]!.text.length === 1000);
    const second = await h.gateway.call(token, 'confluence_get_page', { page: '100' });
    assert.ok(second.ok && second.content[0]!.type === 'text' && second.content[0]!.text.length === 500, 'the run budget caps the second result');
    assert.equal(textOf(await h.gateway.call(token, 'confluence_get_page', { page: '100' })).startsWith('BUDGET'), true);
    const summary = h.gateway.close(token);
    assert.deepEqual(summary.entries.map((e) => e.outcome), ['INVALID_INPUT', 'UNAVAILABLE', 'NOT_FOUND', 'OK', 'OK', 'BUDGET']);
    assert.equal(summary.chars, 1500);
    assert.doesNotMatch(JSON.stringify(summary), /secret-token-value|yyyy|body text/);
    for (const entry of summary.entries) assert.ok(entry.target.length <= 80);
  } finally { await h.gateway.stop(); }
});

test('the HTTP endpoint needs a valid bearer token and answers in the contract shape', async () => {
  const h = harness(); const session = h.gateway.open(scope)!;
  try {
    await h.gateway.listen();
    const base = `http://127.0.0.1:${h.gateway.port}`;
    const post = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const ok = await post('/v1/tools/jira_get_comments', { issue_key: 'CMS2-1' }, session.token);
    assert.equal(ok.status, 200); assert.equal(knowledgeCallResponseSchema.parse(await ok.json()).ok, true);
    for (const [response, status] of [[await post('/v1/tools/jira_get_comments', { issue_key: 'CMS2-1' }), 401], [await post('/v1/tools/jira_get_comments', { issue_key: 'CMS2-1' }, 'z'.repeat(43)), 401], [await post('/v1/tools/jira_get_issue', { issue_key: 'SECRET-1' }, session.token), 403], [await post('/v1/tools/jira_get_issue', '{bad', session.token), 400], [await post('/v1/tools/jira_get_issue', { issue_key: 'x'.repeat(20_000) }, session.token), 413], [await post('/v1/other', {}, session.token), 404], [await fetch(`${base}/v1/tools/jira_get_issue`), 404]] as const) {
      assert.equal(response.status, status); assert.equal(knowledgeCallResponseSchema.parse(await response.json()).ok, false);
    }
    assert.ok(h.logs.some((l) => l.event === 'knowledge_gateway_unauthorized'));
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(session.token));
  } finally { await h.gateway.stop(); }
});
