import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseConfigYaml, AutosError } from '@autos/contracts';
import { createAtlassianClient } from '../../packages/atlassian/src/index.js';

const config = parseConfigYaml(readFileSync('config/config.example.yaml', 'utf8'));
const SECRET = 'fixture-secret-token';
const credentials = { jira: { username: 'fixture@example.test', token: SECRET }, confluence: { username: 'fixture@example.test', token: SECRET } };
const AUTH = `Basic ${Buffer.from(`fixture@example.test:${SECRET}`).toString('base64')}`;
const BODY_LEAK = 'UPSTREAM-BODY-LEAK';
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function setup(handler: Handler) {
  const calls: { url: URL; method: string }[] = [];
  const client = createAtlassianClient({
    config, credentials, maxRetries: 0, sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method ?? '' });
      assert.equal((init?.headers as Record<string, string>).Authorization, AUTH);
      return handler(url, init ?? {});
    },
  });
  return { client, calls };
}
const adf = (...paragraphs: string[]) => ({ type: 'doc', version: 1, content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
const code = (error: unknown, expected: string) => error instanceof AutosError && error.code === expected;
const noLeak = (error: unknown) => {
  const message = String((error as Error).message);
  assert.ok(!message.includes(SECRET) && !message.includes(AUTH) && !message.includes(BODY_LEAK) && !/Basic /.test(message), message);
  return true;
};

const attachment = { id: '10001', filename: 'log.txt', mimeType: 'text/plain', size: 5, created: '2026-01-01T00:00:00.000+0000', author: { displayName: 'Ann' } };

test('getIssueDetail maps fields, ADF description, links and attachments', async () => {
  const { client, calls } = setup(() => json({ key: 'SAMPLE-12', fields: {
    summary: 'Crash on save', description: adf('First line', 'Second line'), issuetype: { name: 'Bug' }, status: { name: 'Done' }, resolution: { name: 'Fixed' },
    labels: ['a'], components: [{ name: 'api' }], created: '2026-01-01T00:00:00.000+0000', updated: '2026-01-02T00:00:00.000+0000', project: { key: 'SAMPLE' },
    issuelinks: [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'SAMPLE-13', fields: { summary: 'Other', status: { name: 'Open' } } } },
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'SAMPLE-9', fields: { summary: 'Prior', status: { name: 'Done' } } } },
    ],
    attachment: [attachment],
  } }));
  const issue = await client.getIssueDetail('SAMPLE-12');
  assert.equal(issue.description, 'First line\nSecond line');
  assert.equal(issue.resolution, 'Fixed');
  assert.deepEqual(issue.links, [
    { key: 'SAMPLE-13', relation: 'blocks', summary: 'Other', status: 'Open' },
    { key: 'SAMPLE-9', relation: 'is blocked by', summary: 'Prior', status: 'Done' },
  ]);
  assert.deepEqual(issue.attachments, [{ id: '10001', filename: 'log.txt', mime_type: 'text/plain', size: 5, created: attachment.created, author: 'Ann' }]);
  assert.equal(calls[0]!.url.pathname, '/rest/api/3/issue/SAMPLE-12');
  assert.equal(calls[0]!.url.searchParams.get('fields'), 'summary,description,issuetype,status,resolution,labels,components,created,updated,issuelinks,attachment,project');
});

test('getIssueComments paginates oldest first and caps at 200', async () => {
  const { client, calls } = setup((url) => {
    const start = Number(url.searchParams.get('startAt'));
    const size = Number(url.searchParams.get('maxResults'));
    return json({ startAt: start, maxResults: size, total: 450, comments: Array.from({ length: size }, (_, i) => ({ id: String(start + i), created: '2026-01-01T00:00:00.000+0000', author: { displayName: 'Bob' }, body: adf(`c${start + i}`) })) });
  });
  const comments = await client.getIssueComments('SAMPLE-1');
  assert.equal(comments.length, 200);
  assert.equal(comments[0]!.body, 'c0');
  assert.equal(comments[0]!.author, 'Bob');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.searchParams.get('orderBy'), 'created');
});

test('getIssueAttachment returns bytes for an attachment of the issue', async () => {
  const { client, calls } = setup((url) => url.pathname.includes('/attachment/content/')
    ? new Response(new Uint8Array([104, 101, 108, 108, 111]), { status: 200 })
    : json({ fields: { attachment: [attachment] } }));
  const result = await client.getIssueAttachment('SAMPLE-1', '10001', 100);
  assert.equal(Buffer.from(result.data).toString(), 'hello');
  assert.equal(result.meta.filename, 'log.txt');
  assert.equal(calls[1]!.url.pathname, '/rest/api/3/attachment/content/10001');
  assert.equal(calls[1]!.url.searchParams.get('redirect'), 'false');
});

test('attachment not on the issue is NOT_FOUND without a content request', async () => {
  const { client, calls } = setup(() => json({ fields: { attachment: [attachment] } }));
  await assert.rejects(client.getIssueAttachment('SAMPLE-1', '99999', 100), (e) => code(e, 'NOT_FOUND') && noLeak(e));
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.url.pathname.includes('/attachment/content/')));
});

test('oversized attachments are INVALID_INPUT, by declared size and by streamed size', async () => {
  const declared = setup(() => json({ fields: { attachment: [attachment] } }));
  await assert.rejects(declared.client.getIssueAttachment('SAMPLE-1', '10001', 4), (e) => code(e, 'INVALID_INPUT'));
  assert.equal(declared.calls.length, 1);
  const streamed = setup((url) => url.pathname.includes('/attachment/content/') ? new Response(new Uint8Array(50)) : json({ fields: { attachment: [{ ...attachment, size: 1 }] } }));
  await assert.rejects(streamed.client.getIssueAttachment('SAMPLE-1', '10001', 10), (e) => code(e, 'INVALID_INPUT'));
});

test('a redirect on attachment content is refused', async () => {
  const { client, calls } = setup((url) => url.pathname.includes('/attachment/content/')
    ? new Response(null, { status: 302, headers: { location: 'https://evil.example.test/x' } })
    : json({ fields: { attachment: [attachment] } }));
  await assert.rejects(client.getIssueAttachment('SAMPLE-1', '10001', 100), (e) => code(e, 'FORBIDDEN') && noLeak(e));
  assert.equal(calls.length, 2);
});

test('searchIssues composes JQL with escaping and a project restriction', async () => {
  const { client, calls } = setup(() => json({ issues: [
    { key: 'SAMPLE-5', fields: { summary: 'Old bug', status: { name: 'Done' }, resolution: { name: 'Fixed' }, updated: '2026-01-01T00:00:00.000+0000' } },
    { key: 'OTHER-1', fields: { summary: 'Open', status: { name: 'Open' }, resolution: null, updated: '2026-01-02T00:00:00.000+0000' } },
  ] }));
  const hits = await client.searchIssues({ text: 'say "hi" \\ now', projects: ['SAMPLE', 'OTHER'], resolvedOnly: true, limit: 7 });
  assert.deepEqual(hits[0], { key: 'SAMPLE-5', summary: 'Old bug', status: 'Done', resolution: 'Fixed', updated: '2026-01-01T00:00:00.000+0000' });
  assert.equal(hits[1]!.resolution, null);
  const url = calls[0]!.url;
  assert.equal(url.pathname, '/rest/api/3/search/jql');
  assert.equal(url.searchParams.get('jql'), 'project in ("SAMPLE", "OTHER") AND text ~ "say \\"hi\\" \\\\ now" AND statusCategory = Done ORDER BY updated DESC');
  assert.equal(url.searchParams.get('maxResults'), '7');
  assert.equal(url.searchParams.get('fields'), 'summary,status,resolution,updated');
  await client.searchIssues({ text: 'x', projects: ['SAMPLE'], resolvedOnly: false, limit: 1 });
  assert.ok(!calls[1]!.url.searchParams.get('jql')!.includes('statusCategory'));
});

test('searchIssues with no projects makes no request; bad project keys are rejected', async () => {
  const { client, calls } = setup(() => json({ issues: [] }));
  assert.deepEqual(await client.searchIssues({ text: 'x', projects: [], resolvedOnly: false, limit: 5 }), []);
  await assert.rejects(client.searchIssues({ text: 'x', projects: ['A") OR (project = "B'], resolvedOnly: false, limit: 5 }), (e) => code(e, 'INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('searchPages composes CQL with escaping and always restricts scope', async () => {
  const { client, calls } = setup(() => json({ results: [
    { content: { id: '123', title: 'Deploy guide', space: { key: 'UAE' }, version: { when: '2026-01-01T00:00:00.000Z' } }, excerpt: 'how to @@@hl@@@deploy@@@endhl@@@ &amp; roll &lt;back&gt;' },
    { content: { id: '124', title: 'No space', version: { when: '2026-01-02T00:00:00.000Z' } }, excerpt: 'x'.repeat(900), resultGlobalContainer: { displayUrl: '/spaces/HO/overview' } },
  ] }));
  const hits = await client.searchPages({ text: 'a "quoted"\nterm\\', spaces: ['UAE', 'HO'], ancestors: ['555', '666'], limit: 5 });
  assert.deepEqual(hits[0], { id: '123', title: 'Deploy guide', space_key: 'UAE', excerpt: 'how to deploy & roll <back>', updated: '2026-01-01T00:00:00.000Z' });
  assert.equal(hits[1]!.space_key, 'HO');
  assert.ok(hits[1]!.excerpt.length <= 400);
  const url = calls[0]!.url;
  assert.equal(url.pathname, '/wiki/rest/api/search');
  assert.equal(url.searchParams.get('cql'), 'type = page AND text ~ "a \\"quoted\\" term\\\\" AND (space in ("UAE", "HO") OR ancestor in (555, 666))');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('expand'), 'content.space,content.version');
  await client.searchPages({ text: 'x', spaces: ['UAE'], ancestors: [], limit: 1 });
  assert.equal(calls[1]!.url.searchParams.get('cql'), 'type = page AND text ~ "x" AND (space in ("UAE"))');
  await client.searchPages({ text: 'x', spaces: [], ancestors: ['9'], limit: 1 });
  assert.equal(calls[2]!.url.searchParams.get('cql'), 'type = page AND text ~ "x" AND (ancestor in (9))');
});

test('searchPages with no scope makes no request; bad ids are rejected', async () => {
  const { client, calls } = setup(() => json({ results: [] }));
  assert.deepEqual(await client.searchPages({ text: 'x', spaces: [], ancestors: [], limit: 5 }), []);
  await assert.rejects(client.searchPages({ text: 'x', spaces: [], ancestors: ['1) OR (x'], limit: 5 }), (e) => code(e, 'INVALID_INPUT'));
  await assert.rejects(client.searchPages({ text: 'x', spaces: ['A" OR "B'], ancestors: [], limit: 5 }), (e) => code(e, 'INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('getPage converts storage XHTML to readable text', async () => {
  const body = '<h1>Title</h1><p>Intro <strong>bold</strong> text</p><ul><li>one</li><li>two</li></ul>'
    + '<table><tr><th>Key</th><th>Val</th></tr><tr><td>a</td><td>b</td></tr></table>'
    + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:plain-text-body><![CDATA[int x = 1;\nint y = 2;]]></ac:plain-text-body></ac:structured-macro>';
  const { client, calls } = setup(() => json({ id: '123', title: 'Guide', space: { key: 'UAE' }, ancestors: [{ id: '1' }, { id: '2' }], version: { when: '2026-02-03T00:00:00.000Z' }, body: { storage: { value: body } } }));
  const page = await client.getPage('123');
  assert.equal(page.title, 'Guide');
  assert.equal(page.space_key, 'UAE');
  assert.deepEqual(page.ancestor_ids, ['1', '2']);
  assert.equal(page.updated, '2026-02-03T00:00:00.000Z');
  const lines = page.body.split('\n');
  for (const expected of ['Title', 'Intro bold text', 'one', 'two', 'Key\tVal', 'a\tb', 'int x = 1;', 'int y = 2;']) assert.ok(lines.includes(expected), `${expected} in ${JSON.stringify(lines)}`);
  assert.ok(!page.body.includes('java'));
  assert.equal(calls[0]!.url.pathname, '/wiki/rest/api/content/123');
  assert.equal(calls[0]!.url.searchParams.get('expand'), 'body.storage,space,ancestors,version');
});

test('getPageChildren maps child pages with empty excerpts', async () => {
  const { client, calls } = setup(() => json({ results: [{ id: '7', title: 'Child', space: { key: 'UAE' }, version: { when: '2026-01-01T00:00:00.000Z' } }] }));
  assert.deepEqual(await client.getPageChildren('123', 25), [{ id: '7', title: 'Child', space_key: 'UAE', excerpt: '', updated: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(calls[0]!.url.pathname, '/wiki/rest/api/content/123/child/page');
  assert.equal(calls[0]!.url.searchParams.get('limit'), '25');
  assert.equal(calls[0]!.url.searchParams.get('expand'), 'space,version');
});

test('input validation throws INVALID_INPUT before any request', async () => {
  const { client, calls } = setup(() => json({}));
  await assert.rejects(client.getIssueDetail('../x'), (e) => code(e, 'INVALID_INPUT'));
  await assert.rejects(client.getIssueComments('bad'), (e) => code(e, 'INVALID_INPUT'));
  await assert.rejects(client.getIssueAttachment('SAMPLE-1', 'x/../y', 10), (e) => code(e, 'INVALID_INPUT'));
  await assert.rejects(client.getPage('12/../3'), (e) => code(e, 'INVALID_INPUT'));
  await assert.rejects(client.getPageChildren('abc', 5), (e) => code(e, 'INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('malformed upstream responses are UPSTREAM errors', async () => {
  const { client } = setup(() => json({ unexpected: true }));
  await assert.rejects(client.getIssueDetail('SAMPLE-1'), (e) => code(e, 'UPSTREAM') && (e as Error).message === 'Atlassian returned an invalid response');
  await assert.rejects(client.getPage('1'), (e) => code(e, 'UPSTREAM'));
  await assert.rejects(client.getPageChildren('1', 5), (e) => code(e, 'UPSTREAM'));
  await assert.rejects(client.searchIssues({ text: 'x', projects: ['SAMPLE'], resolvedOnly: false, limit: 5 }), (e) => code(e, 'UPSTREAM'));
});

test('401/403/404 map to safe errors that never carry the token or body', async () => {
  for (const [status, expected] of [[401, 'AUTH'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND']] as const) {
    const { client } = setup(() => new Response(`${BODY_LEAK} ${AUTH}`, { status }));
    const attempts = [
      client.getIssueDetail('SAMPLE-1'), client.getIssueComments('SAMPLE-1'), client.getIssueAttachment('SAMPLE-1', '1', 10),
      client.searchIssues({ text: 'x', projects: ['SAMPLE'], resolvedOnly: false, limit: 1 }),
      client.searchPages({ text: 'x', spaces: ['UAE'], ancestors: [], limit: 1 }), client.getPage('1'), client.getPageChildren('1', 1),
    ];
    for (const attempt of attempts) await assert.rejects(attempt, (e) => code(e, expected) && noLeak(e));
  }
});

test('only GET requests are made', async () => {
  const { client, calls } = setup((url) => {
    if (url.pathname.includes('/attachment/content/')) return new Response(new Uint8Array([1]));
    if (url.pathname.endsWith('/comment')) return json({ comments: [] });
    if (url.pathname.startsWith('/wiki/rest/api/search') || url.pathname.endsWith('/child/page')) return json({ results: [] });
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [] });
    if (url.pathname.startsWith('/wiki/')) return json({ id: '1' });
    return json({ key: 'SAMPLE-1', fields: { attachment: [attachment] } });
  });
  await client.getIssueDetail('SAMPLE-1'); await client.getIssueComments('SAMPLE-1'); await client.getIssueAttachment('SAMPLE-1', '10001', 10);
  await client.searchIssues({ text: 'x', projects: ['SAMPLE'], resolvedOnly: false, limit: 1 });
  await client.searchPages({ text: 'x', spaces: ['UAE'], ancestors: [], limit: 1 });
  await client.getPage('1'); await client.getPageChildren('1', 1);
  assert.ok(calls.length >= 7 && calls.every((c) => c.method === 'GET'));
});
