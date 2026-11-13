import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { AutosError, type AutosConfig, type JobRecord, type PrecedentIndexPort, type WorkflowServicePort } from '@autos/contracts';
import { createController, generateOpenApi, type ControllerOptions } from '../../apps/controller/src/index.js';
import { monitorPort } from './monitor-fake.js';
import { baseConfig, draftRecord, fakeIndex, gate, JOB, precedentConfig, SECRET_SUMMARY, SECRET_TEXT, status } from './precedents-fake.js';

const TOKEN = 'precedents-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-12T12:00:00.000Z';
const job: JobRecord = { job_id: JOB, issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'READY_FOR_HUMAN', dry_run: false, repair_round: 0, created_at: now, updated_at: now };

function setup(input: { config?: AutosConfig; index?: PrecedentIndexPort; draft?: WorkflowServicePort['createFixDocumentDraft']; extra?: Partial<ControllerOptions> } = {}) {
  const logs: string[] = [];
  const workflow: WorkflowServicePort = {
    ...monitorPort(), submit: async () => job, execute: async () => job, cancel: async () => job, retry: async () => job, revise: async () => job, poll: async () => undefined,
    get: async () => job, list: async () => [], ...(input.draft ? { createFixDocumentDraft: input.draft } : {}),
  };
  const options: ControllerOptions = {
    config: input.config ?? precedentConfig(), workflow, operatorToken: TOKEN, onBackgroundFailure: () => undefined, logStream: { write: (line) => logs.push(line) },
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
    ...(input.index ? { precedentIndex: input.index } : {}), ...input.extra,
  };
  return { options, logs };
}
const post = (app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, headers, payload: payload as object });
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(condition: () => boolean, label: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), `timed out waiting for ${label}`);
}
const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/v1/index/status'], ['POST', '/v1/index/sync', {}], ['POST', '/v1/index/rebuild'], ['POST', '/v1/index/purge', { project_key: 'SAMPLE' }], ['GET', '/v1/lineage'],
  ['POST', '/v1/precedents/search', { issue_key: 'SAMPLE-1' }], ['GET', '/v1/precedents/OTHER-881'], ['POST', '/v1/confluence-drafts', { issue_key: 'SAMPLE-1' }],
];

test('every precedent and draft route requires the operator token', async () => {
  const index = fakeIndex(); const { options } = setup({ index, config: precedentConfig({ drafts: true }), draft: async () => draftRecord() });
  const app = await createController(options);
  try {
    for (const [method, url, payload] of ROUTES) {
      const response = await app.inject({ method: method as 'GET', url, ...(payload ? { payload: payload as object } : {}) });
      assert.equal(response.statusCode, 401, `${method} ${url}`); assert.equal(response.json().code, 'AUTH');
    }
    assert.equal(index.calls.length, 0);
  } finally { await app.close(); }
});

test('without a precedent index or drafts every new route answers 404 NOT_FOUND with a clear message', async () => {
  for (const config of [baseConfig, precedentConfig()]) {
    const { options } = setup({ config }); const app = await createController(options);
    try {
      for (const [method, url, payload] of ROUTES) {
        const response = await app.inject({ method: method as 'GET', url, headers: auth, ...(payload ? { payload: payload as object } : {}) });
        assert.equal(response.statusCode, 404, `${method} ${url}`); assert.equal(response.json().code, 'NOT_FOUND');
        assert.match(response.json().message, url.startsWith('/v1/confluence') ? /Confluence drafts are not configured/ : /Precedent index is not configured/);
      }
    } finally { await app.close(); }
  }
  // An index without config.precedents is also "not configured".
  const { options } = setup({ config: baseConfig, index: fakeIndex() }); const app = await createController(options);
  try { assert.equal((await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).statusCode, 404); } finally { await app.close(); }
});

test('existing routes behave the same with and without the precedent index', async () => {
  const plain = setup({ config: baseConfig }); const withIndex = setup({ index: fakeIndex() });
  const a = await createController(plain.options); const b = await createController(withIndex.options);
  try {
    for (const url of ['/health', '/v1/jobs', '/v1/queue', `/v1/jobs/${JOB}`, '/v1/nope']) {
      const [x, y] = [await a.inject({ method: 'GET', url, headers: auth }), await b.inject({ method: 'GET', url, headers: auth })];
      assert.equal(x.statusCode, y.statusCode, url); assert.deepEqual({ ...(x.json() as object), request_id: undefined }, { ...(y.json() as object), request_id: undefined }, url);
    }
  } finally { await a.close(); await b.close(); }
});

test('GET /v1/index/status returns index counts, loop and operation state', async () => {
  const { options } = setup({ index: fakeIndex() }); const app = await createController(options);
  try {
    const body = (await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).json();
    assert.deepEqual(body.index, status()); assert.equal(body.auto_sync, true);
    assert.deepEqual(body.loop, { active: false, last_tick_at: null, last_tick_error_code: null, ticks: 0 }); assert.equal(body.operation, null);
  } finally { await app.close(); }
});

test('POST /v1/index/sync runs in the background, is single-flight, records reports and audits counts only', async () => {
  const hold = gate(); const index = fakeIndex();
  const sync = index.sync; index.sync = async (opts, signal) => { await hold.promise; return sync(opts, signal); };
  const { options, logs } = setup({ index }); const app = await createController(options);
  try {
    const first = await post(app, '/v1/index/sync', { full: true, reconcile: true });
    assert.equal(first.statusCode, 202); assert.equal(first.json().kind, 'sync'); assert.equal(first.json().running, true); assert.equal(first.json().full, true);
    const busy = await post(app, '/v1/index/rebuild', undefined);
    assert.equal(busy.statusCode, 409); assert.equal(busy.json().message, 'An index operation is already running');
    assert.equal((await post(app, '/v1/index/sync', {})).statusCode, 409);
    hold.open(); await settle();
    assert.deepEqual(index.calls.map((call) => call.kind), ['sync']); assert.deepEqual(index.calls[0]!.args, [{ full: true, reconcile: true }]);
    const op = (await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).json().operation;
    assert.equal(op.running, false); assert.equal(op.reports.length, 1); assert.equal(op.reports[0].mode, 'full'); assert.equal(op.error_code, null);
    const rebuild = await post(app, '/v1/index/rebuild', undefined); assert.equal(rebuild.statusCode, 202); await settle();
    assert.deepEqual(index.calls.map((call) => call.kind), ['sync', 'rebuild']);
    assert.equal((await post(app, '/v1/index/sync', { bogus: true })).statusCode, 400);
    assert.equal((await post(app, '/v1/index/sync', { full: 'yes' })).statusCode, 400);
    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.some((r) => r.event === 'audit' && r.action === 'index_sync' && r.full === true));
    assert.ok(records.some((r) => r.event === 'audit' && r.action === 'index_rebuild'));
    assert.ok(records.some((r) => r.event === 'index_operation' && r.kind === 'sync' && r.issues_upserted === 7 && r.error_code === null));
  } finally { await app.close(); }
});

test('a failing sync records its error code and frees the index for the next operation', async () => {
  const index = fakeIndex({ sync: async () => { throw new AutosError('RATE_LIMIT', `upstream said ${SECRET_TEXT}`); } });
  const { options, logs } = setup({ index }); const app = await createController(options);
  try {
    assert.equal((await post(app, '/v1/index/sync', {})).statusCode, 202); await settle();
    const op = (await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).json().operation;
    assert.equal(op.error_code, 'RATE_LIMIT'); assert.equal(op.running, false);
    assert.equal((await post(app, '/v1/index/sync', {})).statusCode, 202);
    assert.ok(!logs.join('\n').includes(SECRET_TEXT));
  } finally { await app.close(); }
});

test('sync, rebuild and search answer 409 while precedents.enabled is false; status, lineage, show and purge still work', async () => {
  const index = fakeIndex(); const { options } = setup({ index, config: precedentConfig({ enabled: false }) }); const app = await createController(options);
  try {
    for (const [url, payload] of [['/v1/index/sync', {}], ['/v1/index/rebuild', undefined], ['/v1/precedents/search', { text: 'checkout fails' }]] as const) {
      const response = await post(app, url, payload); assert.equal(response.statusCode, 409, url); assert.match(response.json().message, /precedents\.enabled is false/);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/lineage', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/precedents/OTHER-881', headers: auth })).statusCode, 200);
    assert.equal((await post(app, '/v1/index/purge', { project_key: 'OTHER' })).statusCode, 200);
    assert.deepEqual(index.calls.map((call) => call.kind), ['lineage', 'show', 'purge']);
  } finally { await app.close(); }
});

test('POST /v1/index/purge validates the project key and audits the count', async () => {
  const index = fakeIndex(); const { options, logs } = setup({ index }); const app = await createController(options);
  try {
    for (const payload of [{}, { project_key: 'bad' }, { project_key: 'SAMPLE', extra: 1 }]) assert.equal((await post(app, '/v1/index/purge', payload)).statusCode, 400);
    const response = await post(app, '/v1/index/purge', { project_key: 'OTHER' });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { project_key: 'OTHER', issues_deleted: 12 });
    assert.deepEqual(index.calls, [{ kind: 'purge', args: ['OTHER'] }]);
    assert.ok(logs.some((line) => { const r = JSON.parse(line); return r.action === 'index_purge' && r.project_key === 'OTHER' && r.issues_deleted === 12; }));
  } finally { await app.close(); }
});

test('GET /v1/lineage and /v1/precedents/{key} return validated data; unknown key is 404', async () => {
  const { options } = setup({ index: fakeIndex() }); const app = await createController(options);
  try {
    const lineage = (await app.inject({ method: 'GET', url: '/v1/lineage', headers: auth })).json();
    assert.equal(lineage.nodes[0].project_key, 'SAMPLE'); assert.deepEqual(lineage.unattached, ['feature/x']);
    const shown = await app.inject({ method: 'GET', url: '/v1/precedents/OTHER-881', headers: auth });
    assert.equal(shown.statusCode, 200); assert.equal(shown.json().summary, SECRET_SUMMARY);
    const missing = await app.inject({ method: 'GET', url: '/v1/precedents/OTHER-1', headers: auth });
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().message, 'Issue is not in the precedent index');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/precedents/bad-key', headers: auth })).statusCode, 400);
  } finally { await app.close(); }
});

test('POST /v1/precedents/search requires exactly one of issue_key/text, passes options, and never logs the text or results', async () => {
  const index = fakeIndex(); const { options, logs } = setup({ index }); const app = await createController(options);
  try {
    for (const payload of [{}, { issue_key: 'SAMPLE-1', text: SECRET_TEXT }, { text: 'x' }, { issue_key: 'nope' }, { text: SECRET_TEXT, limit: 0 }, { text: SECRET_TEXT, limit: 21 }, { text: SECRET_TEXT, extra: true }]) {
      assert.equal((await post(app, '/v1/precedents/search', payload)).statusCode, 400, JSON.stringify(payload));
    }
    const response = await post(app, '/v1/precedents/search', { text: `  ${SECRET_TEXT}  `, limit: 5, include_unresolved: true, judge: false, explain: true });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.outcome, 'FOUND'); assert.equal(response.json().explain.length, 1);
    assert.deepEqual(index.calls.at(-1), { kind: 'search', args: [{ text: SECRET_TEXT, limit: 5, include_unresolved: true, judge: false, explain: true }] });
    assert.equal((await post(app, '/v1/precedents/search', { issue_key: 'SAMPLE-1' })).statusCode, 200);
    assert.deepEqual(index.calls.at(-1), { kind: 'search', args: [{ issue_key: 'SAMPLE-1', include_unresolved: false, judge: true, explain: false }] }, 'schema defaults are explicit');
    const all = logs.join('\n');
    assert.ok(!all.includes('NULLPOINTER') && !all.includes('ZEBRA') && !all.includes('OTHER-881'), 'request/response bodies must not be logged');
    assert.ok(logs.some((line) => JSON.parse(line).route === '/v1/precedents/search'));
  } finally { await app.close(); }
});

test('a malformed search result from the index is a 500 without leaking upstream text', async () => {
  const index = fakeIndex({ search: async () => ({ result: { outcome: SECRET_TEXT } as never, related: [], explain: [] }) });
  const { options, logs } = setup({ index }); const app = await createController(options);
  try {
    const response = await post(app, '/v1/precedents/search', { issue_key: 'SAMPLE-1' });
    assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('NULLPOINTER')); assert.ok(!logs.join('\n').includes('NULLPOINTER'));
  } finally { await app.close(); }
});

test('POST /v1/confluence-drafts creates a draft by job id or issue key and audits ids only', async () => {
  const targets: string[] = [];
  const { options, logs } = setup({ config: precedentConfig({ drafts: true }), draft: async (target) => { targets.push(target); return draftRecord(); } });
  const app = await createController(options);
  try {
    for (const payload of [{}, { job_id: JOB, issue_key: 'SAMPLE-1' }, { job_id: 'nope' }, { issue_key: 'bad' }]) assert.equal((await post(app, '/v1/confluence-drafts', payload)).statusCode, 400);
    const byJob = await post(app, '/v1/confluence-drafts', { job_id: JOB });
    assert.equal(byJob.statusCode, 201); assert.deepEqual(byJob.json(), draftRecord());
    assert.equal((await post(app, '/v1/confluence-drafts', { issue_key: 'SAMPLE-1' })).statusCode, 201);
    assert.deepEqual(targets, [JOB, 'SAMPLE-1']);
    assert.ok(logs.some((line) => { const r = JSON.parse(line); return r.action === 'confluence_draft' && r.page_id === '777' && r.job_id === JOB; }));
    assert.ok(!logs.join('\n').includes('resumedraft'), 'edit links are not logged');
  } finally { await app.close(); }
});

test('confluence drafts: not configured is 404; workflow refusals map to the usual codes', async () => {
  // The workflow method exists but confluence.drafts is absent from config.
  const off = setup({ config: precedentConfig(), draft: async () => draftRecord() }); const a = await createController(off.options);
  try { const r = await post(a, '/v1/confluence-drafts', { issue_key: 'SAMPLE-1' }); assert.equal(r.statusCode, 404); assert.match(r.json().message, /not configured/); } finally { await a.close(); }
  for (const [code, statusCode] of [['NOT_FOUND', 404], ['CONFLICT', 409], ['FORBIDDEN', 403]] as const) {
    const f = setup({ config: precedentConfig({ drafts: true }), draft: async () => { throw new AutosError(code, `secret ${SECRET_TEXT}`); } }); const app = await createController(f.options);
    try {
      const r = await post(app, '/v1/confluence-drafts', { issue_key: 'SAMPLE-1' });
      assert.equal(r.statusCode, statusCode); assert.equal(r.json().code, code); assert.ok(!r.body.includes('NULLPOINTER')); assert.ok(!f.logs.join('\n').includes('NULLPOINTER'));
    } finally { await app.close(); }
  }
});

test('OpenAPI lists the new operations', async () => {
  const doc = await generateOpenApi(setup().options) as { paths: Record<string, Record<string, { operationId: string }>> };
  assert.deepEqual(['/v1/index/status', '/v1/index/sync', '/v1/index/rebuild', '/v1/index/purge', '/v1/lineage', '/v1/precedents/search', '/v1/precedents/{issueKey}', '/v1/confluence-drafts'].map((path) => Object.values(doc.paths[path] ?? {})[0]?.operationId),
    ['getIndexStatus', 'syncIndex', 'rebuildIndex', 'purgeIndexProject', 'getLineage', 'searchPrecedents', 'getPrecedent', 'createConfluenceDraft']);
});

// ---- Background loop ----

test('background loop: first tick shortly after ready, then on the interval; one log line per tick with counts only', async () => {
  const index = fakeIndex(); const { options, logs } = setup({ index, extra: { indexLoop: { initialDelayMs: 5, intervalMs: 20 } } });
  const app = await createController(options);
  try {
    assert.equal(index.ticks, 0, 'no tick before the server is ready');
    await app.ready();
    await until(() => index.ticks >= 3, 'three ticks');
    const ticks = logs.map((line) => JSON.parse(line)).filter((r) => r.event === 'index_tick');
    assert.ok(ticks.length >= 2); assert.equal(ticks[0].outcome, 'OK'); assert.equal(ticks[0].issues, 120); assert.equal(typeof ticks[0].duration_ms, 'number');
    const loop = (await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).json().loop;
    assert.equal(loop.active, true); assert.ok(loop.ticks >= 2); assert.equal(loop.last_tick_error_code, null);
  } finally { await app.close(); }
  const after = index.ticks; await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(index.ticks, after, 'no ticks after close');
});

test('background loop is single-flight, blocks manual sync while ticking, and close aborts the running tick', async () => {
  const hold = gate(); let started = 0; let signal: AbortSignal | undefined;
  const index = fakeIndex({ tick: async (s) => { started++; signal = s; await Promise.race([hold.promise, new Promise((resolve) => s?.addEventListener('abort', resolve, { once: true }))]); } });
  const { options } = setup({ index, extra: { indexLoop: { initialDelayMs: 1, intervalMs: 5 } } });
  const app = await createController(options); await app.ready();
  await until(() => started === 1, 'first tick');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(started, 1, 'intervals do not start a second tick while one runs');
  const busy = await post(app, '/v1/index/sync', {}); assert.equal(busy.statusCode, 409);
  await app.close();
  assert.equal(signal?.aborted, true);
  assert.equal(index.calls.length, 0);
});

test('background loop survives tick errors and logs the code only', async () => {
  let calls = 0;
  const index = fakeIndex({ tick: async () => { calls++; if (calls === 1) throw new AutosError('UPSTREAM', SECRET_TEXT); if (calls === 2) throw new Error(SECRET_TEXT); } });
  const { options, logs } = setup({ index, extra: { indexLoop: { initialDelayMs: 1, intervalMs: 10 } } });
  const app = await createController(options); await app.ready();
  try {
    await until(() => calls >= 3, 'third tick');
    await until(() => logs.filter((line) => JSON.parse(line).event === 'index_tick').length >= 3, 'tick logs');
    const ticks = logs.map((line) => JSON.parse(line)).filter((r) => r.event === 'index_tick');
    assert.deepEqual(ticks.slice(0, 3).map((r) => [r.outcome, r.code ?? null]), [['FAILED', 'UPSTREAM'], ['FAILED', 'INTERNAL'], ['OK', null]]);
    assert.ok(!logs.join('\n').includes('NULLPOINTER'));
  } finally { await app.close(); }
});

test('background loop does not run without indexLoop, with auto_sync false, or with precedents disabled', async () => {
  for (const [config, loop] of [[precedentConfig(), undefined], [precedentConfig({ auto_sync: false }), { initialDelayMs: 1, intervalMs: 5 }], [precedentConfig({ enabled: false }), { initialDelayMs: 1, intervalMs: 5 }]] as const) {
    const index = fakeIndex(); const { options } = setup({ index, config, extra: loop ? { indexLoop: loop } : {} });
    const app = await createController(options); await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(index.ticks, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/index/status', headers: auth })).json().loop.active, false);
    await app.close();
  }
});
