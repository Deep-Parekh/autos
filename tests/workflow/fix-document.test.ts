import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, confluenceDraftRecordSchema, fixDocumentDataSchema, type JobEvent } from '@autos/contracts';
import { affectedFor, commitSha, draftRef, exists, foundResult, newHarness, open, readJson, readText, ready, semanticConfig, type Harness } from './precedents-harness.js';

let root: string; let h: Harness;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'autos-fixdoc-')); h = await newHarness(root); });
afterEach(async () => rm(root, { recursive: true, force: true }));

const enableDrafts = (auto: boolean) => { h.config.confluence.drafts = { enabled: true, space_key: 'ENG', parent_page_id: '42', auto }; };
const draftEvents = async (service: { events(q: { job_id?: string; limit: number }): Promise<JobEvent[]> }, jobId: string) =>
  (await service.events({ job_id: jobId, limit: 500 })).filter((e) => e.outcome === 'DRAFT_CREATED' || e.outcome === 'DRAFT_FAILED');
const LEGACY_SUMMARY_TAIL = 'Limitations: no pull request, merge, or deployment was performed.\n';

describe('possibly affected after READY_FOR_HUMAN', () => {
  it('writes possibly-affected.json, appends "May also affect" to summary.md and writes fix-report.md', async () => {
    h.config.precedents = semanticConfig();
    const { service, store } = open(h, { semantic: true, drafts: false }); const job = await ready(service);
    const commit = commitSha(1);
    assert.deepEqual(await readJson(h, job.job_id, 'possibly-affected.json'), affectedFor(commit));
    const request = h.affectedRequests[0]!;
    assert.equal(request.commit_sha, commit); assert.deepEqual(request.changed_paths, ['src/Fix.java']); assert.equal(request.development_branch, 'develop');
    assert.equal(request.patch, await readText(h, job.job_id, 'changes.patch')); assert.deepEqual(request.routing, foundResult());
    const summary = await readText(h, job.job_id, 'summary.md');
    assert.ok(summary.startsWith('# SAMPLE-1\n\nRepository: example/sample-app\n'));
    assert.ok(summary.includes(`Limitations: no pull request, merge, or deployment was performed.\n\n## May also affect\n\nAdvisory only.`));
    const report = await readText(h, job.job_id, 'fix-report.md');
    for (const part of ['# SAMPLE-1: Fixture issue — fix', 'Ticket: https://example.atlassian.net/browse/SAMPLE-1', 'Repository: example/sample-app', 'Branch: deep/SAMPLE-1', `Commit: ${commit}`,
      '## Changed files\n- src/Fix.java', '## QA\nStatus: PASS', '## Review\nStatus: PASS', 'summary: Fixed the rounding in Fix.java.', '### Open tickets in other projects', 'PROJC-7 (project PROJC, Open)',
      'Branch projd_dev (Jira project PROJD, lineage core): fix applies cleanly', '## Precedents used\n- PROJB-881 (FIXED_IN_RELATIVE): https://example.atlassian.net/browse/PROJB-881', '## Limitations']) assert.ok(report.includes(part), part);
    const manifest = (await readJson(h, job.job_id, 'manifest.json')).files as Array<{ name: string }>;
    for (const name of ['precedents.json', 'possibly-affected.json', 'fix-report.md']) assert.ok(manifest.some((f) => f.name === name), name);
    assert.equal(await exists(h, job.job_id, 'confluence-draft.json'), false);
    store.close();
  });

  it('a failing or invalid check is non-fatal: still READY_FOR_HUMAN, a short note, no possibly-affected.json', async () => {
    for (const fail of [async () => { throw new AutosError('UNAVAILABLE', 'mirror busy'); }, async () => ({ affected: { schema_version: 2 }, markdown: 'x' })]) {
      h = await newHarness(await mkdtemp(join(root, 'run-'))); h.config.precedents = semanticConfig();
      h.possiblyAffected = fail as never;
      const { service, store } = open(h, { semantic: true, drafts: false }); const job = await ready(service);
      assert.equal((await service.get(job.job_id))!.state, 'READY_FOR_HUMAN');
      assert.equal(await exists(h, job.job_id, 'possibly-affected.json'), false);
      assert.match(await readText(h, job.job_id, 'summary.md'), /## May also affect\n\nCheck unavailable \((UNAVAILABLE|INVALID_OUTPUT)\)\.\n$/);
      assert.ok((await readText(h, job.job_id, 'fix-report.md')).includes('## May also affect\nNot checked.'));
      assert.equal((await readJson(h, job.job_id, 'manifest.json')).status, 'READY_FOR_HUMAN');
      store.close();
    }
  });

  it('possibly_affected: false skips the check but still writes fix-report.md', async () => {
    h.config.precedents = semanticConfig({ possibly_affected: false });
    const { service, store } = open(h, { semantic: true, drafts: false }); const job = await ready(service);
    assert.ok(!h.calls.includes('possiblyAffected')); assert.ok((await readText(h, job.job_id, 'summary.md')).endsWith(LEGACY_SUMMARY_TAIL));
    assert.equal(await exists(h, job.job_id, 'fix-report.md'), true); store.close();
  });

  it('drafts enabled without semantic precedents: fix-report.md only, summary unchanged', async () => {
    enableDrafts(false);
    const { service, store } = open(h); const job = await ready(service);
    assert.deepEqual(h.calls, ['legacy']);
    assert.ok((await readText(h, job.job_id, 'summary.md')).endsWith(LEGACY_SUMMARY_TAIL));
    const report = await readText(h, job.job_id, 'fix-report.md');
    assert.ok(report.includes('## May also affect\nNot checked.') && report.includes('## Precedents used\nNone.'));
    assert.equal(await exists(h, job.job_id, 'confluence-draft.json'), false); store.close();
  });
});

describe('automatic Confluence draft', () => {
  it('creates the draft after READY_FOR_HUMAN, records confluence-draft.json and an event without content', async () => {
    h.config.precedents = semanticConfig(); enableDrafts(true);
    const { service, store } = open(h); const job = await ready(service);
    assert.equal(h.drafts.length, 1); assert.equal(h.drafts[0]!.previous, null);
    const data = fixDocumentDataSchema.parse(h.drafts[0]!.data);
    assert.equal(data.issue_url, 'https://example.atlassian.net/browse/SAMPLE-1'); assert.equal(data.commit_sha, commitSha(1)); assert.equal(data.branch, 'deep/SAMPLE-1');
    assert.deepEqual(data.possibly_affected, affectedFor(commitSha(1))); assert.deepEqual(data.precedents_used.map((p) => p.issue_key), ['PROJB-881', 'PROJD-12']);
    const record = confluenceDraftRecordSchema.parse(await readJson(h, job.job_id, 'confluence-draft.json'));
    assert.deepEqual(record, { schema_version: 1, job_id: job.job_id, issue_key: 'SAMPLE-1', draft: draftRef('1001'), created_at: '2026-11-07T20:00:00.000Z', supersedes_page_id: null });
    const evs = await draftEvents(service, job.job_id);
    assert.equal(evs.length, 1); assert.equal(evs[0]!.outcome, 'DRAFT_CREATED'); assert.match(evs[0]!.message!, /page 1001/);
    assert.ok(!evs[0]!.message!.includes('Fixture issue') && !evs[0]!.message!.includes('http'));
    const all = await service.events({ job_id: job.job_id, limit: 500 });
    assert.ok(all.findIndex((e) => e.type === 'job_finished') < all.findIndex((e) => e.outcome === 'DRAFT_CREATED'));
    assert.ok(((await readJson(h, job.job_id, 'manifest.json')).files as Array<{ name: string }>).some((f) => f.name === 'confluence-draft.json'));
    store.close();
  });

  it('a draft failure is non-fatal: READY_FOR_HUMAN, no record, a DRAFT_FAILED event with only the code', async () => {
    enableDrafts(true);
    h.createOrUpdate = async () => { throw new AutosError('FORBIDDEN', 'space https://secret.example/wiki denied'); };
    const { service, store } = open(h); const job = await ready(service);
    assert.equal((await service.get(job.job_id))!.state, 'READY_FOR_HUMAN');
    assert.equal(await exists(h, job.job_id, 'confluence-draft.json'), false);
    const evs = await draftEvents(service, job.job_id);
    assert.equal(evs.length, 1); assert.equal(evs[0]!.outcome, 'DRAFT_FAILED'); assert.equal(evs[0]!.code, 'FORBIDDEN'); assert.ok(!evs[0]!.message!.includes('secret'));
    store.close();
  });

  it('an invalid writer result is rejected and not recorded', async () => {
    enableDrafts(true);
    h.createOrUpdate = async () => ({ draft: { ...draftRef('1001'), status: 'current' }, superseded_page_id: null }) as never;
    const { service, store } = open(h); const job = await ready(service);
    assert.equal(await exists(h, job.job_id, 'confluence-draft.json'), false);
    assert.equal((await draftEvents(service, job.job_id))[0]!.code, 'INVALID_OUTPUT'); store.close();
  });

  it('auto: false or no writer wired creates no draft automatically', async () => {
    enableDrafts(false);
    const { service, store } = open(h); await ready(service);
    assert.equal(h.drafts.length, 0); store.close();
  });
});

describe('createFixDocumentDraft', () => {
  it('is FORBIDDEN when drafts are disabled or no writer is wired', async () => {
    const a = open(h); const job = await ready(a.service);
    await assert.rejects(() => a.service.createFixDocumentDraft(job.job_id), { code: 'FORBIDDEN' }); a.store.close();
    enableDrafts(false);
    const b = open(h, { semantic: false, drafts: false });
    await assert.rejects(() => b.service.createFixDocumentDraft(job.job_id), { code: 'FORBIDDEN' }); b.store.close();
  });

  it('is CONFLICT for a job that is not READY_FOR_HUMAN, NOT_FOUND for unknown jobs and issues, INVALID_INPUT otherwise', async () => {
    enableDrafts(false);
    const { service, store } = open(h);
    const queued = await service.submit('SAMPLE-1', false);
    await assert.rejects(() => service.createFixDocumentDraft(queued.job_id), { code: 'CONFLICT' });
    await assert.rejects(() => service.createFixDocumentDraft('SAMPLE-1'), { code: 'NOT_FOUND' });
    await assert.rejects(() => service.createFixDocumentDraft('00000000-0000-4000-8000-00000000ffff'), { code: 'NOT_FOUND' });
    await assert.rejects(() => service.createFixDocumentDraft('not a key'), { code: 'INVALID_INPUT' });
    const dry = await service.execute((await service.submit('SAMPLE-2', true)).job_id); assert.equal(dry.state, 'PLANNED');
    await assert.rejects(() => service.createFixDocumentDraft(dry.job_id), { code: 'CONFLICT' });
    assert.equal(h.drafts.length, 0); store.close();
  });

  it('builds the document from artifacts (issue key resolves the latest ready attempt) and reuses its own draft next time', async () => {
    h.config.precedents = semanticConfig(); enableDrafts(false);
    const { service, store } = open(h); const job = await ready(service);
    const first = await service.createFixDocumentDraft('SAMPLE-1');
    assert.equal(first.job_id, job.job_id); assert.deepEqual(first.draft, draftRef('1001')); assert.equal(h.drafts[0]!.previous, null);
    const data = h.drafts[0]!.data;
    assert.deepEqual(data.changed_files, ['src/Fix.java']); assert.equal(data.repository, 'example/sample-app'); assert.equal(data.summary, 'Fixture issue');
    assert.deepEqual(data.checks.map((c) => c.status), data.checks.map(() => 'PASS')); assert.equal(data.qa.status, 'PASS'); assert.match(data.fix_summary, /Fixed the rounding/);
    assert.deepEqual(data.possibly_affected, affectedFor(commitSha(1))); assert.deepEqual(data.precedents_used.map((p) => p.kind), ['FIXED_IN_RELATIVE', 'ALREADY_PRESENT_HERE']);
    const second = await service.createFixDocumentDraft(job.job_id);
    assert.deepEqual(h.drafts[1]!.previous, draftRef('1001')); assert.equal(second.draft.version, 2);
    assert.deepEqual(confluenceDraftRecordSchema.parse(await readJson(h, job.job_id, 'confluence-draft.json')), second);
    store.close();
  });

  it('a revision starts from the parent draft and records what it supersedes', async () => {
    enableDrafts(false);
    const { service, store } = open(h); const parent = await ready(service);
    await service.createFixDocumentDraft(parent.job_id);
    const revision = await service.execute((await service.revise(parent.job_id, { instructions: 'Also handle nulls', roles: ['swe'] }, 'operator')).job_id);
    assert.equal(revision.state, 'READY_FOR_HUMAN', revision.blocked_reason ?? undefined);
    h.createOrUpdate = async (_d, previous) => ({ draft: draftRef('2002'), superseded_page_id: previous?.page_id ?? null }); // the user published the parent draft
    const record = await service.createFixDocumentDraft('SAMPLE-1');
    assert.equal(record.job_id, revision.job_id); assert.deepEqual(h.drafts[1]!.previous, draftRef('1001'));
    assert.equal(record.supersedes_page_id, '1001'); assert.equal(record.draft.page_id, '2002');
    assert.equal(h.drafts[1]!.data.commit_sha, commitSha(2));
    assert.deepEqual(confluenceDraftRecordSchema.parse(await readJson(h, parent.job_id, 'confluence-draft.json')).draft, draftRef('1001')); // parent record untouched
    store.close();
  });

  it('propagates a writer failure as a sanitized error and records a DRAFT_FAILED event', async () => {
    enableDrafts(false);
    const { service, store } = open(h); const job = await ready(service);
    h.createOrUpdate = async () => { throw new Error('raw upstream body with token=abc'); };
    await assert.rejects(() => service.createFixDocumentDraft(job.job_id), (e: unknown) => e instanceof AutosError && e.code === 'INTERNAL' && !e.message.includes('token'));
    assert.equal((await draftEvents(service, job.job_id))[0]!.code, 'INTERNAL');
    assert.equal(await exists(h, job.job_id, 'confluence-draft.json'), false); store.close();
  });
});
