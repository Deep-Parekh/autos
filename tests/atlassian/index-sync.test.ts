import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseConfigYaml, AutosError, indexedIssueSchema } from '@autos/contracts';
import { createAtlassianClient } from '../../packages/atlassian/src/index.js';

const config = parseConfigYaml(readFileSync('config/config.example.yaml', 'utf8'));
const credentials = { jira: { username: 'fixture@example.test', token: 'fixture-secret' }, confluence: { username: 'fixture@example.test', token: 'fixture-secret' } };
const now = () => new Date('2026-11-12T00:00:00Z');
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const adf = (value: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] });
function comment(id: string, extra: Record<string, unknown> = {}) {
  return { id, created: '2026-10-01T10:00:00.000+0200', body: adf(`comment ${id}`), author: { accountType: 'atlassian' }, ...extra };
}
function row(id: string, key: string, fields: Record<string, unknown> = {}) {
  return { id, key, fields: {
    summary: `${key} summary`, description: adf('desc text'), issuetype: { name: 'Story' }, status: { name: 'Done' },
    resolution: { name: 'Fixed' }, resolutiondate: '2026-10-02T10:00:00.000+0000', created: '2026-09-01T10:00:00.000+0000',
    updated: '2026-10-03T10:00:00.000+0000', project: { key: 'PROJA' }, components: [{ name: 'core' }], labels: ['x'],
    issuelinks: [{ inwardIssue: { key: 'PROJB-1' } }, { outwardIssue: { key: 'bad key' } }], parent: { key: 'PROJA-1' },
    comment: { comments: [comment('10')], total: 1, maxResults: 20, startAt: 0 }, security: null, ...fields,
  } };
}
function client(fetch: (url: URL, init?: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}) {
  return createAtlassianClient({ config, credentials, now, sleep: async () => {}, fetch: async (input, init) => fetch(new URL(String(input)), init), ...extra });
}
const scope = { projects: ['PROJA', 'PROJB'], windowWeeks: 104 };

test('searchIssuesForIndex builds JQL from validated keys, requests index fields and normalizes rows', async () => {
  const urls: URL[] = []; const methods: string[] = [];
  const c = client(async (url, init) => { urls.push(url); methods.push(init?.method ?? ''); return json({ issues: [row('100', 'PROJA-2')], nextPageToken: 'tok-2', isLast: false }); });
  const page = await c.searchIssuesForIndex({ ...scope, updatedSince: new Date('2026-11-01T08:05:00Z') });
  assert.equal(urls[0]?.pathname, '/rest/api/3/search/jql');
  assert.equal(urls[0]?.searchParams.get('jql'), 'project in (PROJA, PROJB) AND updated >= -104w AND updated >= "2026/11/01 08:05" ORDER BY updated ASC, key ASC');
  assert.equal(urls[0]?.searchParams.get('maxResults'), '100');
  const fields = urls[0]?.searchParams.get('fields')?.split(',') ?? [];
  for (const field of ['summary', 'description', 'issuetype', 'status', 'resolution', 'resolutiondate', 'created', 'updated', 'project', 'components', 'labels', 'issuelinks', 'parent', 'comment', 'security']) assert.ok(fields.includes(field), field);
  assert.ok(!urls[0]?.searchParams.get('jql')?.includes('issuetype'));
  assert.deepEqual(methods, ['GET']);
  assert.equal(page.nextPageToken, 'tok-2');
  assert.equal(page.skipped_restricted, 0);
  const [issue] = page.issues;
  assert.ok(indexedIssueSchema.safeParse(issue).success);
  assert.equal(issue?.description, 'desc text');
  assert.equal(issue?.resolved_at, '2026-10-02T10:00:00.000Z');
  assert.deepEqual(issue?.link_keys, ['PROJB-1']);
  assert.equal(issue?.parent_key, 'PROJA-1');
  assert.deepEqual(issue?.comments, [{ id: '10', author_is_app: false, created: '2026-10-01T08:00:00.000Z', body: 'comment 10' }]);
  assert.equal(issue?.comments_truncated, false);

  const next = client(async (url) => { urls.push(url); return json({ issues: [], isLast: true, nextPageToken: 'ignored' }); });
  const last = await next.searchIssuesForIndex({ ...scope, nextPageToken: 'tok-2' });
  assert.equal(urls.at(-1)?.searchParams.get('nextPageToken'), 'tok-2');
  assert.equal(last.nextPageToken, undefined);
});

test('invalid project keys, window and cursor are rejected before any request', async () => {
  let calls = 0;
  const c = client(async () => { calls += 1; return json({ issues: [], isLast: true }); });
  for (const projects of [['proja'], ['PROJA) OR project = SECRET'], ['PROJA', 'A"B'], [], ['1ABC']]) {
    await assert.rejects(c.searchIssuesForIndex({ projects, windowWeeks: 104 }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT' && !error.message.includes('SECRET'));
    await assert.rejects(c.listIssueIds({ projects, windowWeeks: 104 }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  }
  await assert.rejects(c.searchIssuesForIndex({ ...scope, windowWeeks: 1.5 }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  await assert.rejects(c.searchIssuesForIndex({ ...scope, updatedSince: new Date('nope') }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  assert.equal(calls, 0);
});

test('repeated pagination token and isLast=false without a token fail closed', async () => {
  const repeated = client(async () => json({ issues: [], nextPageToken: 'same', isLast: false }));
  await assert.rejects(repeated.searchIssuesForIndex({ ...scope, nextPageToken: 'same' }), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM' && /repeated/.test(error.message));
  await assert.rejects(repeated.listIssueIds({ ...scope, nextPageToken: 'same' }), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM');
  const mismatch = client(async () => json({ issues: [], isLast: false }));
  await assert.rejects(mismatch.searchIssuesForIndex(scope), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM' && /continuation/.test(error.message));
  await assert.rejects(mismatch.listIssueIds(scope), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM');
});

test('429 honours Retry-After; 401 and 403 stop without retry and leak no body', async () => {
  let calls = 0; const delays: number[] = [];
  const limited = client(async () => { calls += 1; return calls === 1 ? json({}, 429, { 'retry-after': '2' }) : json({ issues: [], isLast: true }); }, { sleep: async (ms: number) => { delays.push(ms); } });
  assert.deepEqual((await limited.searchIssuesForIndex(scope)).issues, []);
  assert.equal(calls, 2); assert.deepEqual(delays, [2000]);
  for (const [status, code] of [[401, 'AUTH'], [403, 'FORBIDDEN']] as const) {
    let hits = 0;
    const denied = client(async () => { hits += 1; return json({ errorMessages: ['secret-upstream PROJA-2 text'] }, status); });
    await assert.rejects(denied.searchIssuesForIndex(scope), (error: unknown) => error instanceof AutosError && error.code === code && !/secret-upstream|PROJA|project in/.test(error.message));
    assert.equal(hits, 1);
  }
});

test('security-level issues are skipped and counted; restricted comments dropped; app authors flagged; truncation detected', async () => {
  const c = client(async () => json({ issues: [
    row('1', 'PROJA-3', { security: { id: '10000', name: 'Internal' } }),
    row('2', 'PROJA-4', { comment: { comments: [
      comment('20', { visibility: { type: 'role', value: 'Developers' } }),
      comment('21', { author: { accountType: 'app', displayName: 'Autos bot' } }),
      comment('22'),
    ], total: 5 } }),
  ], isLast: true }));
  const page = await c.searchIssuesForIndex(scope);
  assert.equal(page.skipped_restricted, 1);
  assert.deepEqual(page.issues.map((issue) => issue.key), ['PROJA-4']);
  const issue = page.issues[0]!;
  assert.deepEqual(issue.comments.map((item) => [item.id, item.author_is_app]), [['21', true], ['22', false]]);
  assert.ok(!JSON.stringify(issue).includes('comment 20'));
  assert.equal(issue.comments_truncated, true);
});

test('invalid rows are skipped and counted without failing the page', async () => {
  const c = client(async () => json({ issues: [
    { id: 'x', key: 'PROJA-5', fields: {} },
    row('3', 'PROJA-6', { updated: 'not a date' }),
    row('4', 'OTHER-1', { project: { key: 'OTHER' } }),
    row('5', 'PROJA-7', { comment: { comments: [{ id: 'abc' }], total: 1 } }),
    'garbage',
    row('6', 'PROJA-8'),
  ], isLast: true }));
  const page = await c.searchIssuesForIndex(scope);
  assert.deepEqual(page.issues.map((issue) => issue.key), ['PROJA-8']);
  assert.equal(page.skipped_invalid, 5);
  assert.equal(page.skipped_restricted, 0);
});

test('getIndexComments pages by startAt with the same visibility and app rules', async () => {
  const urls: URL[] = [];
  const c = client(async (url) => {
    urls.push(url);
    const startAt = Number(url.searchParams.get('startAt'));
    if (startAt === 0) return json({ comments: [comment('30', { author: { accountType: 'app' } }), comment('31', { visibility: { type: 'group', value: 'x' } })], startAt: 0, maxResults: 2, total: 3 });
    return json({ comments: [comment('32')], startAt: 2, maxResults: 2, total: 3 });
  });
  const first = await c.getIndexComments('1234', 0);
  assert.equal(urls[0]?.pathname, '/rest/api/3/issue/1234/comment');
  assert.deepEqual(first.comments.map((item) => [item.id, item.author_is_app]), [['30', true]]);
  assert.equal(first.next_start_at, 2);
  const second = await c.getIndexComments('1234', 2);
  assert.deepEqual(second.comments.map((item) => item.id), ['32']);
  assert.equal(second.next_start_at, null);
  await assert.rejects(c.getIndexComments('../1', 0), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  await assert.rejects(c.getIndexComments('1', -1), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  assert.equal(urls.length, 2);
});

test('listIssueIds requests only id,key,updated and fails closed on malformed rows', async () => {
  const urls: URL[] = [];
  const c = client(async (url) => { urls.push(url); return json({ issues: [{ id: '7', key: 'PROJA-9', fields: { updated: '2026-10-03T10:00:00.000+0000' } }], nextPageToken: 'n1' }); });
  const page = await c.listIssueIds(scope);
  assert.equal(urls[0]?.searchParams.get('fields'), 'id,key,updated');
  assert.equal(urls[0]?.searchParams.get('jql'), 'project in (PROJA, PROJB) AND updated >= -104w ORDER BY updated ASC, key ASC');
  assert.deepEqual(page, { ids: [{ id: '7', key: 'PROJA-9', updated: '2026-10-03T10:00:00.000Z' }], nextPageToken: 'n1' });
  const bad = client(async () => json({ issues: [{ id: '7', key: 'PROJA-9', fields: {} }], isLast: true }));
  await assert.rejects(bad.listIssueIds(scope), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM');
});

test('index reads refuse redirects', async () => {
  const c = client(async () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } }));
  await assert.rejects(c.searchIssuesForIndex(scope), (error: unknown) => error instanceof AutosError && error.code === 'FORBIDDEN');
});
