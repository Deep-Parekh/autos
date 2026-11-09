import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseConfigYaml, AutosError } from '@autos/contracts';
import { createAtlassianClient } from '../../packages/atlassian/src/index.js';

const config = parseConfigYaml(readFileSync('config/config.example.yaml', 'utf8'));
const credentials = { jira: { username: 'fixture@example.test', token: 'fixture-secret' }, confluence: { username: 'fixture@example.test', token: 'fixture-secret' } };
const now = () => new Date('2026-01-02T03:04:05Z');
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function issue(key: string, self = 'https://attacker.invalid/with-secret') {
  return { key, self, fields: {
    project: { key: 'SAMPLE' }, summary: `${key} summary`, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
    issuetype: { name: 'Bug' }, status: { name: 'Open' }, updated: '2026-01-01T23:00:00+0000',
    components: [{ name: 'web' }], issuelinks: [],
  } };
}

test('enhanced JQL pagination hydrates complete comments and performs only GET requests', async () => {
  const urls: URL[] = [];
  const methods: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)); urls.push(url); methods.push(init?.method ?? '');
    if (url.pathname === '/rest/api/3/search/jql') {
      if (url.searchParams.has('nextPageToken')) return json({ issues: [issue('SAMPLE-2')], isLast: true });
      return json({ issues: [issue('SAMPLE-1')], nextPageToken: 'opaque-token' });
    }
    if (url.pathname.endsWith('/comment')) {
      const startAt = Number(url.searchParams.get('startAt'));
      if (startAt === 0) return json({ comments: [{ id: 'c1', body: 'first' }], startAt: 0, maxResults: 1, total: 2 });
      return json({ comments: [{ id: 'c2', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] } }], startAt: 1, maxResults: 1, total: 2 });
    }
    if (/\/rest\/api\/3\/issue\/SAMPLE-[12]$/.test(url.pathname)) return json(issue(url.pathname.endsWith('1') ? 'SAMPLE-1' : 'SAMPLE-2'));
    throw new Error('unexpected fixture route');
  };
  const client = createAtlassianClient({ config, credentials, fetch, now, sleep: async () => {} });
  const snapshots = await client.listIssues('project = SAMPLE ORDER BY created ASC');
  assert.deepEqual(snapshots.map((item) => item.key), ['SAMPLE-1', 'SAMPLE-2']);
  assert.deepEqual(snapshots[0]?.comments, [{ id: 'c1', body: 'first' }, { id: 'c2', body: 'second' }]);
  assert.equal(snapshots[0]?.updated_at, '2026-01-01T23:00:00.000Z');
  assert.equal(snapshots[0]?.url, 'https://example.atlassian.net/browse/SAMPLE-1');
  assert.ok(urls.some((url) => url.searchParams.get('nextPageToken') === 'opaque-token'));
  assert.ok(methods.length > 0 && methods.every((method) => method === 'GET'));
});

test('configured acceptance criteria field is requested and normalized without guessing custom fields', async () => {
  const criteriaConfig = { ...config, jira: { ...config.jira, acceptance_criteria_fields: ['customfield_10000'] } };
  let requestedFields = '';
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/search/jql')) return json({ issues: [issue('SAMPLE-3')], isLast: true });
    if (url.pathname.endsWith('/comment')) return json({ comments: [], total: 0 });
    requestedFields = url.searchParams.get('fields') ?? '';
    return json({ ...issue('SAMPLE-3'), fields: { ...issue('SAMPLE-3').fields, customfield_10000: '- Must work\n- Must remain safe' } });
  };
  const client = createAtlassianClient({ config: criteriaConfig, credentials, fetch, now, sleep: async () => {} });
  const [snapshot] = await client.listIssues('project = SAMPLE');
  assert.ok(requestedFields.includes('customfield_10000'));
  assert.deepEqual(snapshot?.acceptance_criteria, ['- Must work', '- Must remain safe']);
});

test('only configured saved filter and branch-map page can be read', async () => {
  const client = createAtlassianClient({ config, credentials, fetch: async () => json({}), now });
  await assert.rejects(client.getSavedFilter('42'), (error: unknown) => error instanceof AutosError && error.code === 'FORBIDDEN');
  await assert.rejects(client.getBranchMap('42'), (error: unknown) => error instanceof AutosError && error.code === 'FORBIDDEN');
});

test('key discovery preserves mixed filter membership while issue hydration rejects disallowed projects', async () => {
  const client = createAtlassianClient({ config, credentials, now, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/search/jql')) return json({ issues: [{ key: 'SAMPLE-1' }, { key: 'OTHER-2' }], isLast: true });
    if (url.pathname.endsWith('/issue/SAMPLE-1')) return json(issue('SAMPLE-1'));
    if (url.pathname.endsWith('/issue/SAMPLE-1/comment')) return json({ comments: [], total: 0 });
    if (url.pathname.endsWith('/issue/OTHER-2')) return json({ ...issue('OTHER-2'), fields: { ...issue('OTHER-2').fields, project: { key: 'OTHER' } } });
    throw new Error('unexpected fixture route');
  } });
  assert.deepEqual(await client.listIssueKeys('project in (SAMPLE, OTHER)'), ['SAMPLE-1', 'OTHER-2']);
  await assert.rejects(client.getIssue('OTHER-2'), (error: unknown) => error instanceof AutosError && error.code === 'FORBIDDEN');
  assert.equal((await client.getIssue('SAMPLE-1')).key, 'SAMPLE-1');
});

test('private filter denial remains an error, not an empty filter', async () => {
  const client = createAtlassianClient({ config, credentials, fetch: async () => json({ body: 'secret detail' }, 404), now });
  await assert.rejects(client.getSavedFilter(config.jira.saved_filter_id), (error: unknown) => error instanceof AutosError && error.code === 'NOT_FOUND' && !error.message.includes('secret'));
});

test('authentication failure and cross-origin redirects never expose upstream bodies or credentials', async () => {
  let options: RequestInit | undefined;
  const denied = createAtlassianClient({ config, credentials, fetch: async (_input, init) => { options = init; return json({ body: 'secret-response-body' }, 401); }, now });
  await assert.rejects(denied.getSavedFilter(config.jira.saved_filter_id), (error: unknown) => error instanceof AutosError && error.code === 'AUTH' && !error.message.includes('secret-response-body'));
  assert.equal(options?.method, 'GET');
  assert.equal(options?.redirect, 'manual');
  assert.equal((options?.headers as Record<string, string>).Authorization?.startsWith('Basic '), true);

  const redirected = createAtlassianClient({ config, credentials, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/collect' } }), now });
  await assert.rejects(redirected.getSavedFilter(config.jira.saved_filter_id), (error: unknown) => error instanceof AutosError && error.code === 'FORBIDDEN');
});

test('429 retries with injected backoff and then returns the filter', async () => {
  let calls = 0; const delays: number[] = [];
  const client = createAtlassianClient({ config, credentials, now, maxRetries: 2, sleep: async (ms) => { delays.push(ms); }, fetch: async () => {
    calls += 1;
    return calls === 1 ? json({}, 429, { 'retry-after': '0.5' }) : json({ id: Number(config.jira.saved_filter_id), name: 'Bugs', jql: 'project = SAMPLE' });
  } });
  assert.equal((await client.getSavedFilter(config.jira.saved_filter_id)).jql, 'project = SAMPLE');
  assert.equal(calls, 2); assert.deepEqual(delays, [500]);
});

test('pre-aborted read cancels before sending and exposes no credential data', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const client = createAtlassianClient({ config, credentials, fetch: async () => { calls += 1; return json({}); }, now });
  await assert.rejects(client.getSavedFilter(config.jira.saved_filter_id, controller.signal), (error: unknown) => error instanceof AutosError && error.code === 'CANCELLED' && !error.message.includes('fixture-secret'));
  assert.equal(calls, 0);
});

test('Confluence mapping validates exact schema and preserves version; disabled rows fail resolution', async () => {
  const table = `<table><tbody><tr><th>Project Key</th><th>Bitbucket Workspace</th><th>Repository Slug</th><th>Development Branch</th><th>Sandbox Branch</th><th>Enabled</th></tr><tr><td>SAMPLE</td><td>example</td><td>sample-app</td><td>develop</td><td></td><td>yes</td></tr></tbody></table>`;
  const client = createAtlassianClient({ config, credentials, fetch: async () => json({ id: config.confluence.branch_map_page_id, version: { number: 9 }, body: { storage: { value: table } } }), now });
  const [mapping] = await client.getBranchMap(config.confluence.branch_map_page_id);
  assert.equal(mapping?.source.version, 9); assert.equal(mapping?.enabled, true);
  assert.equal((await client.resolveProjectMapping('SAMPLE')).repository_slug, 'sample-app');

  const disabled = table.replace('<td>yes</td>', '<td>no</td>');
  const disabledClient = createAtlassianClient({ config, credentials, fetch: async () => json({ id: config.confluence.branch_map_page_id, version: { number: 9 }, body: { storage: { value: disabled } } }), now });
  await assert.rejects(disabledClient.resolveProjectMapping('SAMPLE'), (error: unknown) => error instanceof AutosError && error.code === 'MAPPING' && error.message.includes('disabled'));
});

test('precedent lookup reports disabled separately from an honest no-match', async () => {
  const disabled = createAtlassianClient({ config, credentials, fetch: async () => json({}), now });
  const issueSnapshot = { key: 'SAMPLE-1', project_key: 'SAMPLE', summary: 'Summary', description: '', acceptance_criteria: [], issue_type: 'Bug', status: 'Open', updated_at: now().toISOString(), fetched_at: now().toISOString(), comments: [], linked_issue_keys: [], components: [], url: 'https://example.atlassian.net/browse/SAMPLE-1' };
  const mapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: config.confluence.branch_map_page_id, version: 1, fetched_at: now().toISOString() } };
  assert.deepEqual(await disabled.precedents.findPrecedents(issueSnapshot, mapping), { outcome: 'DISABLED', items: [], disabled_reason: 'MISSING_CREDENTIALS' });
  const disabledConfig = { ...config, jobs: { ...config.jobs, similar_tickets: { ...config.jobs.similar_tickets, enabled: false } } };
  const disabledByPolicy = createAtlassianClient({ config: disabledConfig, credentials, fetch: async () => json({}), now });
  assert.deepEqual(await disabledByPolicy.precedents.findPrecedents(issueSnapshot, mapping), { outcome: 'DISABLED', items: [], disabled_reason: 'CONFIG_DISABLED' });
  const noMatch = createAtlassianClient({ config, credentials, fetch: async () => json({}), now, precedentSearch: async () => ({ outcome: 'NO_MATCH', items: [] }) });
  assert.deepEqual(await noMatch.precedents.findPrecedents(issueSnapshot, mapping), { outcome: 'NO_MATCH', items: [] });
});

test('built-in precedent lookup returns only a real matching Bitbucket commit and diff', async () => {
  const current = { key: 'SAMPLE-1', project_key: 'SAMPLE', summary: 'related parser timeout', description: '', acceptance_criteria: [], issue_type: 'Bug', status: 'Open', updated_at: now().toISOString(), fetched_at: now().toISOString(), comments: [], linked_issue_keys: ['SAMPLE-2'], components: ['web'], url: 'https://example.atlassian.net/browse/SAMPLE-1' };
  const mapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: config.confluence.branch_map_page_id, version: 1, fetched_at: now().toISOString() } };
  const sha = 'a'.repeat(40); const calls: URL[] = [];
  const client = createAtlassianClient({ config, credentials: { ...credentials, bitbucketToken: 'fixture-bb-token' }, now, fetch: async (input) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: 'SAMPLE-2' }], isLast: true });
    if (url.pathname === '/rest/api/3/issue/SAMPLE-2') return json(issue('SAMPLE-2'));
    if (url.pathname.endsWith('/issue/SAMPLE-2/comment')) return json({ comments: [], total: 0 });
    if (url.pathname.endsWith('/commits/develop')) return json({ values: [{ hash: sha, message: 'Fix SAMPLE-2 timeout handling' }] });
    if (url.pathname.endsWith(`/diff/${sha}`)) return new Response('diff --git a/src/a b/src/a\n+fixed timeout behavior', { status: 200, headers: { 'content-type': 'text/plain' } });
    throw new Error('unexpected fixture route');
  } });
  const result = await client.precedents.findPrecedents(current, mapping);
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.items[0]?.issue_key, 'SAMPLE-2');
  assert.equal(result.items[0]?.commit_sha, sha);
  assert.equal(result.items[0]?.issue_url, 'https://example.atlassian.net/browse/SAMPLE-2');
  assert.equal(result.items[0]?.evidence_url, `https://bitbucket.org/example/sample-app/commits/${sha}`);
  assert.match(result.items[0]?.diff ?? '', /^diff --git/);
  assert.ok(calls.every((url) => url.protocol === 'https:' && (url.hostname === 'example.atlassian.net' || url.hostname === 'api.bitbucket.org')));
});

test('built-in precedent lookup reports authenticated Bitbucket failures safely', async () => {
  const current = { key: 'SAMPLE-1', project_key: 'SAMPLE', summary: 'timeout', description: '', acceptance_criteria: [], issue_type: 'Bug', status: 'Open', updated_at: now().toISOString(), fetched_at: now().toISOString(), comments: [], linked_issue_keys: ['SAMPLE-2'], components: [], url: 'https://example.atlassian.net/browse/SAMPLE-1' };
  const mapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: config.confluence.branch_map_page_id, version: 1, fetched_at: now().toISOString() } };
  const client = createAtlassianClient({ config, credentials: { ...credentials, bitbucketToken: 'secret-token' }, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: 'SAMPLE-2' }], isLast: true });
    if (url.pathname === '/rest/api/3/issue/SAMPLE-2') return json(issue('SAMPLE-2'));
    if (url.pathname.endsWith('/issue/SAMPLE-2/comment')) return json({ comments: [], total: 0 });
    return json({ body: 'secret-token upstream diagnostic' }, 401);
  }, now });
  await assert.rejects(client.precedents.findPrecedents(current, mapping), (error: unknown) => error instanceof AutosError && error.code === 'AUTH' && !error.message.includes('secret-token'));
});

test('built-in precedent lookup rejects cross-origin Bitbucket pagination and malformed commits', async () => {
  const current = { key: 'SAMPLE-1', project_key: 'SAMPLE', summary: 'timeout', description: '', acceptance_criteria: [], issue_type: 'Bug', status: 'Open', updated_at: now().toISOString(), fetched_at: now().toISOString(), comments: [], linked_issue_keys: ['SAMPLE-2'], components: [], url: 'https://example.atlassian.net/browse/SAMPLE-1' };
  const mapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: config.confluence.branch_map_page_id, version: 1, fetched_at: now().toISOString() } };
  let bbCalls = 0;
  const client = createAtlassianClient({ config, credentials: { ...credentials, bitbucketToken: 'fixture-token' }, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: 'SAMPLE-2' }], isLast: true });
    if (url.pathname === '/rest/api/3/issue/SAMPLE-2') return json(issue('SAMPLE-2'));
    if (url.pathname.endsWith('/issue/SAMPLE-2/comment')) return json({ comments: [], total: 0 });
    bbCalls += 1; return json({ values: [], next: 'https://attacker.invalid/steal' });
  }, now });
  await assert.rejects(client.precedents.findPrecedents(current, mapping), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM');
  assert.equal(bbCalls, 1);

  const malformed = createAtlassianClient({ config, credentials: { ...credentials, bitbucketToken: 'fixture-token' }, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: 'SAMPLE-2' }], isLast: true });
    if (url.pathname === '/rest/api/3/issue/SAMPLE-2') return json(issue('SAMPLE-2'));
    if (url.pathname.endsWith('/issue/SAMPLE-2/comment')) return json({ comments: [], total: 0 });
    return json({ values: [{ hash: 'bad-hash', message: 'SAMPLE-2' }] });
  }, now });
  await assert.rejects(malformed.precedents.findPrecedents(current, mapping), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM');
});

test('bounded Bitbucket scan returns honest truncated NO_MATCH at its page cap', async () => {
  const current = { key: 'SAMPLE-1', project_key: 'SAMPLE', summary: 'timeout', description: '', acceptance_criteria: [], issue_type: 'Bug', status: 'Open', updated_at: now().toISOString(), fetched_at: now().toISOString(), comments: [], linked_issue_keys: ['SAMPLE-2'], components: [], url: 'https://example.atlassian.net/browse/SAMPLE-1' };
  const mapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: config.confluence.branch_map_page_id, version: 1, fetched_at: now().toISOString() } };
  let pageCount = 0;
  const client = createAtlassianClient({ config, credentials: { ...credentials, bitbucketToken: 'fixture-token' }, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: 'SAMPLE-2' }], isLast: true });
    if (url.pathname === '/rest/api/3/issue/SAMPLE-2') return json(issue('SAMPLE-2'));
    if (url.pathname.endsWith('/issue/SAMPLE-2/comment')) return json({ comments: [], total: 0 });
    pageCount += 1;
    const page = Number(url.searchParams.get('page') ?? 0);
    return json({ values: [], next: `https://api.bitbucket.org${url.pathname}?pagelen=100&page=${page + 1}` });
  }, now });
  assert.deepEqual(await client.precedents.findPrecedents(current, mapping), { outcome: 'NO_MATCH', items: [], search_truncated: true });
  assert.equal(pageCount, 20);
});

test('Bitbucket repeated pagination URLs fail closed and pre-aborted diffs do not fetch', async () => {
  const current = { key: 'SAMPLE-1', project_key: 'SAMPLE', summary: 'timeout', description: '', acceptance_criteria: [], issue_type: 'Bug', status: 'Open', updated_at: now().toISOString(), fetched_at: now().toISOString(), comments: [], linked_issue_keys: ['SAMPLE-2'], components: [], url: 'https://example.atlassian.net/browse/SAMPLE-1' };
  const mapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: config.confluence.branch_map_page_id, version: 1, fetched_at: now().toISOString() } };
  let bbCalls = 0;
  const client = createAtlassianClient({ config, credentials: { ...credentials, bitbucketToken: 'fixture-token' }, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [{ key: 'SAMPLE-2' }], isLast: true });
    if (url.pathname === '/rest/api/3/issue/SAMPLE-2') return json(issue('SAMPLE-2'));
    if (url.pathname.endsWith('/issue/SAMPLE-2/comment')) return json({ comments: [], total: 0 });
    bbCalls += 1; return json({ values: [], next: `${url.origin}${url.pathname}?pagelen=100` });
  }, now });
  await assert.rejects(client.precedents.findPrecedents(current, mapping), (error: unknown) => error instanceof AutosError && error.code === 'UPSTREAM');
  assert.equal(bbCalls, 1);

  const controller = new AbortController(); controller.abort();
  const direct = client as unknown as { getText(url: URL, auth: string, maxChars: number, signal?: AbortSignal): Promise<string> };
  await assert.rejects(direct.getText(new URL('https://api.bitbucket.org/2.0/repositories/example/sample-app/diff/abc'), 'Bearer fixture', 1000, controller.signal), (error: unknown) => error instanceof AutosError && error.code === 'CANCELLED');
  assert.equal(bbCalls, 1);
});


test('a config with model tiers and ladders (resolved output) is accepted; a broken Jira section still fails closed', () => {
  const text = readFileSync('config/config.example.yaml', 'utf8').replace(/^agents:\n(?:  .*\n)+/m, '')
    + 'models:\n  luna: {provider: codex, model: gpt-6-luna}\nmodel_tiers:\n  sm: [luna:high]\n  med: [{provider: claude, model: sonnet, effort: high}]\n'
    + 'triage: {tier: sm}\nagents:\n  swe: {ladder: [sm, med]}\n  qa: {ladder: [sm, med]}\n  reviewer: {ladder: [sm, med], min: med}\n';
  const tiered = parseConfigYaml(text);
  assert.ok(tiered.agents.swe.ladder);
  const credentials = { jira: { username: 'u@example.com', token: 't' }, confluence: { username: 'u@example.com', token: 't' } };
  assert.doesNotThrow(() => createAtlassianClient({ config: tiered, credentials }));
  assert.throws(() => createAtlassianClient({ config: { ...tiered, jira: { ...tiered.jira, read_only: false } } as never, credentials }), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG');
});
