import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFragment } from 'parse5';
import { AutosError, type ConfluenceDraftRef } from '@autos/contracts';
import { ConfluenceDraftWriter, fixDocumentTitle, renderFixDocumentStorage, type FixDocumentInput } from '../../packages/atlassian/src/index.js';

const SITE = 'https://example.atlassian.net';
const TOKEN = 'fixture-draft-token';
const TITLE = 'PROJA-1: secret-title-text — fix';
const BODY = '<p>secret-body-text</p>';
type Call = { method: string; url: URL; body: Record<string, unknown> | undefined; init: RequestInit | undefined };
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const page = (extra: Record<string, unknown> = {}) => ({ id: '555', status: 'draft', title: 'x', spaceId: '77', parentId: '900', version: { number: 1 }, ...extra });

function writer(route: (call: Call) => Response | Promise<Response>, extra: Partial<ConstructorParameters<typeof ConfluenceDraftWriter>[0]> = {}) {
  const calls: Call[] = [];
  const instance = new ConfluenceDraftWriter({
    siteUrl: SITE, username: 'fixture@example.test', token: TOKEN, spaceKey: 'AUTOS', parentPageId: '900', sleep: async () => {},
    fetch: async (input, init) => {
      const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, init };
      calls.push(call);
      if (call.url.pathname === '/wiki/api/v2/spaces') return json({ results: [{ id: 77, key: 'AUTOS' }] });
      return route(call);
    },
    ...extra,
  });
  return { instance, calls };
}
function assertSafeCalls(calls: Call[]): void {
  for (const call of calls) {
    assert.notEqual(call.method, 'DELETE');
    assert.ok(['GET', 'POST', 'PUT'].includes(call.method));
    assert.equal(call.url.origin, SITE);
    assert.equal(call.init?.redirect, 'manual');
    assert.ok(!JSON.stringify(call.body ?? {}).includes('"current"'));
    if (call.body && 'status' in call.body) assert.equal(call.body.status, 'draft');
  }
}
function noContent(error: unknown): boolean {
  return error instanceof AutosError && !/secret-title-text|secret-body-text|fixture-draft-token|Zml4dHVyZ/.test(`${error.message} ${error.stack ?? ''}`);
}

test('createDraft resolves the space once and POSTs a draft under the configured parent', async () => {
  let id = 554;
  const { instance, calls } = writer((call) => { id += 1; return json(page({ id: String(id) })); });
  const ref = await instance.createDraft({ title: TITLE, storageBody: BODY });
  await instance.createDraft({ title: TITLE, storageBody: BODY });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), ['GET /wiki/api/v2/spaces', 'POST /wiki/api/v2/pages', 'POST /wiki/api/v2/pages']);
  assert.equal(calls[0]?.url.searchParams.get('keys'), 'AUTOS');
  assert.deepEqual(calls[1]?.body, { spaceId: '77', status: 'draft', title: TITLE, parentId: '900', body: { representation: 'storage', value: BODY } });
  assert.ok((calls[1]?.init?.headers as Record<string, string>).Authorization?.startsWith('Basic '));
  assert.deepEqual(ref, { page_id: '555', space_id: '77', version: 1, status: 'draft', edit_url: `${SITE}/wiki/spaces/AUTOS/pages/edit-v2/555` });
  assertSafeCalls(calls);
});

test('createDraft throws when the response is not a draft or lands outside the configured space/parent', async () => {
  for (const bad of [{ status: 'current' }, { spaceId: '78' }, { parentId: '901' }, { id: 'abc' }]) {
    const { instance, calls } = writer(() => json(page(bad)));
    await assert.rejects(instance.createDraft({ title: TITLE, storageBody: BODY }), noContent);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assertSafeCalls(calls);
  }
});

test('content limits and configuration are enforced before any write', async () => {
  const { instance, calls } = writer(() => json(page()));
  await assert.rejects(instance.createDraft({ title: 'x'.repeat(256), storageBody: BODY }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  await assert.rejects(instance.createDraft({ title: ' ', storageBody: BODY }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  await assert.rejects(instance.createDraft({ title: TITLE, storageBody: 'a'.repeat(2 * 1024 * 1024 + 1) }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_INPUT');
  assert.equal(calls.length, 0);
  for (const bad of [{ siteUrl: 'http://example.atlassian.net' }, { siteUrl: 'https://u:p@example.atlassian.net' }, { siteUrl: 'https://example.atlassian.net/wiki' }, { spaceKey: 'A B' }, { parentPageId: '9x' }, { token: 'a\nb' }]) {
    assert.throws(() => writer(() => json({}), bad), (error: unknown) => error instanceof AutosError && !String(error.message).includes(TOKEN));
  }
});

test('updateDraft PUTs a draft with the next version only when the page is unchanged', async () => {
  const ref: ConfluenceDraftRef = { page_id: '555', space_id: '77', version: 3, status: 'draft', edit_url: `${SITE}/wiki/spaces/AUTOS/pages/edit-v2/555` };
  const { instance, calls } = writer((call) => call.method === 'GET' ? json(page({ version: { number: 3 } })) : json(page({ version: { number: 4 } })));
  const updated = await instance.updateDraft(ref, { title: TITLE, storageBody: BODY });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), ['GET /wiki/api/v2/spaces', 'GET /wiki/api/v2/pages/555', 'PUT /wiki/api/v2/pages/555']);
  assert.equal(calls[1]?.url.searchParams.get('get-draft'), 'true');
  assert.deepEqual(calls[2]?.body, { id: '555', status: 'draft', title: TITLE, body: { representation: 'storage', value: BODY }, version: { number: 4 } });
  assert.deepEqual(updated, { ...ref, version: 4 });
  assertSafeCalls(calls);
});

test('updateDraft does not write when the page was published, edited, moved, deleted or conflicts', async () => {
  const ref: ConfluenceDraftRef = { page_id: '555', space_id: '77', version: 3, status: 'draft', edit_url: `${SITE}/wiki/spaces/AUTOS/pages/edit-v2/555` };
  const cases: Record<string, unknown>[] = [
    { status: 'current', version: { number: 3 } },
    { version: { number: 4 } },
    { version: { number: 3 }, spaceId: '78' },
    { version: { number: 3 }, parentId: '901' },
    { version: { number: 3 }, parentId: null },
  ];
  for (const fields of cases) {
    const { instance, calls } = writer(() => json(page(fields)));
    assert.deepEqual(await instance.updateDraft(ref, { title: TITLE, storageBody: BODY }), { superseded: true });
    assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);
  }
  const gone = writer(() => json({ message: 'secret-body-text' }, 404));
  assert.deepEqual(await gone.instance.updateDraft(ref, { title: TITLE, storageBody: BODY }), { superseded: true });
  assert.equal(gone.calls.filter((call) => call.method !== 'GET').length, 0);
  const otherSpace = writer(() => json(page({ version: { number: 3 } })));
  assert.deepEqual(await otherSpace.instance.updateDraft({ ...ref, space_id: '99' }, { title: TITLE, storageBody: BODY }), { superseded: true });
  assert.equal(otherSpace.calls.filter((call) => call.url.pathname.startsWith('/wiki/api/v2/pages')).length, 0);
  const conflict = writer((call) => call.method === 'GET' ? json(page({ version: { number: 3 } })) : json({}, 409));
  assert.deepEqual(await conflict.instance.updateDraft(ref, { title: TITLE, storageBody: BODY }), { superseded: true });
  assertSafeCalls(conflict.calls);
});

test('updateDraft throws if Confluence publishes the page on update', async () => {
  const ref: ConfluenceDraftRef = { page_id: '555', space_id: '77', version: 3, status: 'draft', edit_url: `${SITE}/wiki/spaces/AUTOS/pages/edit-v2/555` };
  const { instance, calls } = writer((call) => call.method === 'GET' ? json(page({ version: { number: 3 } })) : json(page({ status: 'current', version: { number: 4 } })));
  await assert.rejects(instance.updateDraft(ref, { title: TITLE, storageBody: BODY }), (error: unknown) => noContent(error) && (error as AutosError).code === 'POLICY');
  assertSafeCalls(calls);
});

test('redirects are refused for writes and reads; errors carry no title, body or token', async () => {
  const redirect = writer(() => new Response(null, { status: 307, headers: { location: 'https://attacker.invalid/collect' } }));
  await assert.rejects(redirect.instance.createDraft({ title: TITLE, storageBody: BODY }), (error: unknown) => noContent(error) && (error as AutosError).code === 'FORBIDDEN');
  assert.equal(redirect.calls.length, 2);
  assertSafeCalls(redirect.calls);
  for (const status of [400, 401, 403, 500]) {
    const failing = writer(() => json({ message: `secret-body-text ${TOKEN}` }, status));
    await assert.rejects(failing.instance.createDraft({ title: TITLE, storageBody: BODY }), noContent);
    assert.equal(failing.calls.filter((call) => call.method === 'POST').length, 1, 'writes are not retried on 5xx');
  }
  let posts = 0;
  const limited = writer(() => { posts += 1; return posts === 1 ? json({}, 429, { 'retry-after': '1' }) : json(page()); });
  assert.equal((await limited.instance.createDraft({ title: TITLE, storageBody: BODY })).page_id, '555');
  assert.equal(posts, 2);
  const missingSpace = new ConfluenceDraftWriter({ siteUrl: SITE, username: 'u', token: TOKEN, spaceKey: 'AUTOS', parentPageId: '900', fetch: async () => json({ results: [] }) });
  await assert.rejects(missingSpace.createDraft({ title: TITLE, storageBody: BODY }), (error: unknown) => noContent(error) && (error as AutosError).code === 'MAPPING');
});

test('the writer exposes no publish or delete code path', () => {
  const methods = Object.getOwnPropertyNames(ConfluenceDraftWriter.prototype);
  assert.deepEqual(methods.filter((name) => /publish|delete|remove/i.test(name)), []);
});

const hostile = '<ac:structured-macro ac:name="html"><ac:plain-text-body><![CDATA[<script>alert(1)</script>]]></ac:plain-text-body></ac:structured-macro> & \'quote\' "dq" ]]> <script>x</script>\u0000\u0007';
const input: FixDocumentInput = {
  issueKey: 'PROJA-1', issueUrl: 'https://example.atlassian.net/browse/PROJA-1', summary: hostile,
  repository: 'example/sample-app', branch: 'autos/PROJA-1', commitSha: 'a'.repeat(40), changedFiles: ['src/a.ts', hostile],
  checks: [{ name: 'unit', status: 'PASSED' }, { name: hostile, status: hostile }],
  qa: { status: 'PASS', summary: `line one\n${hostile}` }, review: { status: 'APPROVED', summary: 'ok token=abc123' },
  fixSummary: `Fixed it.\n\n${hostile}`,
  possiblyAffected: {
    schema_version: 1, issue_key: 'PROJA-1', commit_sha: 'a'.repeat(40),
    open_tickets: [{ issue_key: 'PROJB-7', project_key: 'PROJB', summary: hostile, status: 'Open', evidence: ['same file src/a.ts', hostile] }],
    branches: [{ lineage_id: 'core', project_key: 'PROJC', branch: 'projc_dev', applies: 'clean', inherited: true, evidence: ['code inherited before fork'] }],
  },
  precedentsUsed: [
    { issue_key: 'PROJB-3', issue_url: 'https://example.atlassian.net/browse/PROJB-3', kind: 'FIXED_IN_RELATIVE' },
    { issue_key: 'PROJB-4', issue_url: 'javascript:alert(1)', kind: hostile },
    { issue_key: 'PROJB-5', issue_url: 'http://example.atlassian.net/browse/PROJB-5', kind: 'RELATED_FIX' },
  ],
};

interface Node { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] }
function walk(node: Node, visit: (node: Node) => void): void { visit(node); for (const child of node.childNodes ?? []) walk(child, visit); }

test('renderFixDocumentStorage escapes hostile text into text nodes and links only https URLs', () => {
  const xml = renderFixDocumentStorage(input);
  assert.ok(!xml.includes('<ac:'), 'no macros');
  assert.ok(!xml.includes('<script'), 'no script');
  assert.ok(!xml.includes(']]>'), 'no CDATA terminator');
  assert.ok(!xml.includes('<![CDATA['));
  assert.ok(!/[\u0000-\u0008]/.test(xml));
  assert.ok(xml.includes('&lt;ac:structured-macro'));
  assert.ok(xml.includes('&#39;quote&#39; &quot;dq&quot;'));
  assert.ok(xml.includes('token=[redacted]'));
  const elements = new Set<string>(); const hrefs: string[] = [];
  walk(parseFragment(xml) as unknown as Node, (node) => {
    if (!node.nodeName.startsWith('#')) elements.add(node.nodeName);
    for (const attr of node.attrs ?? []) { assert.equal(attr.name, 'href'); hrefs.push(attr.value); }
  });
  assert.deepEqual([...elements].filter((name) => !['h2', 'h3', 'p', 'ul', 'li', 'a', 'code', 'br'].includes(name)), []);
  assert.deepEqual(hrefs, ['https://example.atlassian.net/browse/PROJA-1', 'https://example.atlassian.net/browse/PROJB-3']);
  assert.ok(xml.includes('<h2>May also affect</h2>'));
  assert.match(xml, /PROJB-7 \(project PROJB, Open\).*may be a similar issue and should be checked/);
  assert.match(xml, /Branch projc_dev \(Jira project PROJC, lineage core\): fix applies cleanly\. This branch may have a similar issue and should be checked and fixed/);
});

test('the May also affect section is omitted when there is nothing to list', () => {
  assert.ok(!renderFixDocumentStorage({ ...input, possiblyAffected: null }).includes('May also affect'));
  const empty = { ...input.possiblyAffected!, open_tickets: [], branches: [] };
  assert.ok(!renderFixDocumentStorage({ ...input, possiblyAffected: empty }).includes('May also affect'));
});

test('fixDocumentTitle stays within the Confluence title limit', () => {
  const title = fixDocumentTitle('PROJA-1', 'x'.repeat(400));
  assert.ok([...title].length <= 255);
  assert.ok(title.startsWith('PROJA-1: ') && title.endsWith(' — fix'));
  assert.equal(fixDocumentTitle('PROJA-1', 'Short'), 'PROJA-1: Short — fix');
});
