import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError, MAX_TICKET_NOTES, parseConfigYaml, ticketNotesSummarySchema, operatorNoteSchema, type GitPrepareRequest, type GitWorkspace, type IssueSnapshot, type ProjectMapping, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';

let root: string;
let config: ReturnType<typeof parseConfigYaml>;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Fixture issue', description: 'Description', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z' } as IssueSnapshot);
const sha = (n: number) => n.toString(16).padStart(64, '0');

interface Script { digestIndex: number; commitSeq: number; prompts: { role: string; text: string }[]; keys: string[]; clock: number }
let script: Script;

function deps(store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date(Date.UTC(2026, 10, 7, 20, 0, script.clock++)) },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return script.keys; },
      async listIssues() { return []; },
      async getIssue(key: string) { return issue(key); },
      async getBranchMap() { return [mapping]; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req: GitPrepareRequest) {
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}`, ...(req.continue_from ? { start_sha: req.continue_from.parent_commit_sha } : {}) } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(script.digestIndex), paths: ['src/Fix.java'], diff: `+ fixed v${script.digestIndex}` }; },
      async commit(req) { script.commitSeq++; return { commit_sha: String(script.commitSeq).repeat(40).slice(0, 40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; },
      async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req) {
        script.prompts.push({ role: req.role, text: await readFile(req.prompt_path, 'utf8') });
        const base = { provider: 'claude' as const, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        if (req.role === 'swe') { script.digestIndex++; return { ...base, result: 'Implemented.' } as ProviderResult; }
        const d = sha(script.digestIndex);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] } } as ProviderResult;
      },
      async runChecks(_ws, d, commands) {
        return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status: 'PASS', exit_code: 0, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop() { /* nothing running */ },
    },
  };
}

beforeEach(async () => {
  script = { digestIndex: 1, commitSeq: 0, prompts: [], keys: ['SAMPLE-1'], clock: 0 };
  root = await mkdtemp(join(tmpdir(), 'autos-ticketnotes-'));
  config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
  config.storage.data_dir = join(root, 'data'); config.storage.artifacts_dir = join(root, 'artifacts'); config.storage.workspaces_dir = join(root, 'workspaces');
  config.jobs.max_repair_rounds = 2;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = () => {
  const store = new SqliteJobStore(join(root, 'jobs.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, service: new WorkflowService(deps(store, artifacts)) };
};
const promptsFor = (role: string) => script.prompts.filter((p) => p.role === role).map((p) => p.text).join('\n');
const summary = async (service: WorkflowService, key: string) => { const [s] = await service.ticketNotes(key); return ticketNotesSummarySchema.parse(s); };
const ready = async (service: WorkflowService, key = 'SAMPLE-1') => { const j = await service.execute((await service.submit(key, false)).job_id); assert.equal(j.state, 'READY_FOR_HUMAN', j.blocked_reason); return j; };

describe('ticket notes', () => {
  it('stores a note for an unseen key and reports not_seen, then delivers it to the discovered job', async () => {
    const { service } = open();
    const stored = await service.addTicketNote('SAMPLE-1', { instructions: 'use the legacy parser', roles: ['swe'] }, 'deep');
    assert.equal(stored.issue_key, 'SAMPLE-1');
    let s = await summary(service, 'SAMPLE-1'); assert.equal(s.status, 'not_seen'); assert.equal(s.attempts, 0); assert.equal(s.latest_job_id, null); assert.equal(s.attempts_with_current_notes, 0);
    assert.deepEqual((await service.ticketNotes()).map((x) => x.issue_key), ['SAMPLE-1']);
    await service.discover();
    const [job] = await service.list(10); assert.ok(job);
    const notes = service.operatorNotes(job.job_id);
    assert.equal(notes.length, 1); assert.equal(notes[0]!.source, 'ticket'); assert.equal(notes[0]!.instructions, 'use the legacy parser'); operatorNoteSchema.parse(notes[0]);
    s = await summary(service, 'SAMPLE-1'); assert.equal(s.status, 'queued'); assert.equal(s.attempts, 1); assert.equal(s.attempts_with_current_notes, 1);
  });

  it('delivers notes to the prompts of their roles', async () => {
    const { service } = open();
    await service.addTicketNote('SAMPLE-1', { instructions: 'SWEONLY-marker', roles: ['swe'] }, 'deep');
    await service.addTicketNote('SAMPLE-1', { instructions: 'QAONLY-marker', roles: ['qa'] }, 'deep');
    await service.addTicketNote('SAMPLE-1', { instructions: 'ALLROLES-marker', roles: ['swe', 'qa', 'reviewer'] }, 'deep');
    await ready(service);
    const swe = promptsFor('swe'); const qa = promptsFor('qa'); const rev = promptsFor('reviewer');
    assert.ok(swe.includes('SWEONLY-marker') && swe.includes('ALLROLES-marker')); assert.ok(!swe.includes('QAONLY-marker'));
    // Existing rule: QA and reviewer see every note as an acceptance requirement; only addressed notes carry the role header.
    assert.ok(qa.includes('Operator note addressed to qa') && qa.includes('QAONLY-marker') && qa.includes('ALLROLES-marker'));
    assert.ok(!/addressed to qa[^\n]*\n[^\n]*\n[^\n]*SWEONLY/.test(qa));
    assert.ok(rev.includes('ALLROLES-marker'));
  });

  it('hold skips discovery, not explicit submit, and release lets discovery queue it', async () => {
    const { service } = open();
    await service.setTicketHold('SAMPLE-1', true, 'deep'); await service.setTicketHold('SAMPLE-1', true, 'deep');
    let s = await summary(service, 'SAMPLE-1'); assert.equal(s.held, true); assert.equal(s.status, 'held');
    assert.deepEqual(await service.discover(), { discovered: 1, queued: 0 });
    assert.equal((await service.list(10)).length, 0);
    assert.ok((await service.events({ limit: 100 })).some((e) => e.type === 'poll_finished' && /1 held/.test(e.message ?? '')));
    await service.execute((await service.submit('SAMPLE-1', true)).job_id); s = await summary(service, 'SAMPLE-1'); assert.notEqual(s.status, 'held'); assert.equal(s.dry_runs, 1); assert.equal(s.attempts, 0);
    await service.setTicketHold('SAMPLE-1', false, 'deep'); await service.setTicketHold('SAMPLE-1', false, 'deep');
    assert.equal((await service.discover()).queued, 1);
    assert.deepEqual(await service.ticketNotes(), []);
  });

  it('retry carries operator notes but refreshes ticket notes', async () => {
    const { service } = open();
    const first = await service.addTicketNote('SAMPLE-1', { instructions: 'old-ticket-note', roles: ['swe'] }, 'deep');
    const job = await service.submit('SAMPLE-1', false, [{ instructions: 'attempt-note', roles: ['swe'] }]);
    await service.cancel(job.job_id);
    await service.removeTicketNotes('SAMPLE-1', first.note_id);
    await service.addTicketNote('SAMPLE-1', { instructions: 'new-ticket-note', roles: ['qa'] }, 'deep');
    const retry = await service.retry(job.job_id);
    const notes = service.operatorNotes(retry.job_id);
    assert.deepEqual(notes.map((n) => [n.instructions, n.source ?? 'operator']), [['attempt-note', 'operator'], ['new-ticket-note', 'ticket']]);
    const s = await summary(service, 'SAMPLE-1'); assert.equal(s.attempts, 2); assert.equal(s.attempts_with_current_notes, 1);
  });

  it('revision gets its own note plus current ticket notes', async () => {
    const { service } = open();
    await service.addTicketNote('SAMPLE-1', { instructions: 'ticket-guidance', roles: ['swe'] }, 'deep');
    const parent = await ready(service);
    await service.addTicketNote('SAMPLE-1', { instructions: 'later-guidance', roles: ['swe'] }, 'deep');
    const rev = await service.reviseIssue('SAMPLE-1', { instructions: 'revision-request', roles: ['swe'] }, 'deep');
    assert.notEqual(rev.job_id, parent.job_id);
    assert.deepEqual(service.operatorNotes(rev.job_id).map((n) => [n.instructions, n.source ?? 'operator']), [['revision-request', 'operator'], ['ticket-guidance', 'ticket'], ['later-guidance', 'ticket']]);
    assert.equal((await summary(service, 'SAMPLE-1')).attempts_with_current_notes, 1);
  });

  it('enforces limits and validation', async () => {
    const { service } = open();
    for (let i = 0; i < MAX_TICKET_NOTES; i++) await service.addTicketNote('SAMPLE-1', { instructions: `n${i}` }, 'deep');
    await assert.rejects(service.addTicketNote('SAMPLE-1', { instructions: 'sixth' }, 'deep'), (e) => e instanceof AutosError && e.code === 'CONFLICT');
    await assert.rejects(service.addTicketNote('OTHER-1', { instructions: 'x' }, 'deep'), (e) => e instanceof AutosError && e.code === 'INVALID_INPUT');
    await assert.rejects(service.setTicketHold('OTHER-1', true, 'deep'), (e) => e instanceof AutosError && e.code === 'INVALID_INPUT');
    await assert.rejects(service.addTicketNote('SAMPLE-2', { instructions: 'x' }, 'bad author!'), (e) => e instanceof AutosError && e.code === 'INVALID_INPUT');
    await assert.rejects(service.removeTicketNotes('SAMPLE-1', '00000000-0000-4000-8000-000000000000'), (e) => e instanceof AutosError && e.code === 'NOT_FOUND');
    const [one] = await service.ticketNotes('SAMPLE-1'); assert.equal(one!.notes[0]!.roles[0], 'swe');
    assert.equal(await service.removeTicketNotes('SAMPLE-1'), MAX_TICKET_NOTES);
    assert.equal((await summary(service, 'SAMPLE-1')).notes.length, 0);
    script.keys = ['SAMPLE-1', 'SAMPLE-2']; await ready(service, 'SAMPLE-2'); await service.closeIssue('SAMPLE-2', { resolution: 'MERGED', dry_run: false }, 'deep');
    await assert.rejects(service.addTicketNote('SAMPLE-2', { instructions: 'x' }, 'deep'), (e) => e instanceof AutosError && e.code === 'CONFLICT');
  });

  it('reports status across the lifecycle, dry runs and closure; note text never reaches events', async () => {
    const { service } = open();
    await service.addTicketNote('SAMPLE-1', { instructions: 'EVENT-LEAK-CANARY', roles: ['swe'] }, 'deep');
    await service.addTicketNote('SAMPLE-2', { instructions: 'dry only' }, 'deep');
    script.keys = ['SAMPLE-1', 'SAMPLE-2'];
    const dry = await service.submit('SAMPLE-2', true);
    assert.equal((await summary(service, 'SAMPLE-2')).status, 'queued');
    const executedDry = await service.execute(dry.job_id);
    const s2 = await summary(service, 'SAMPLE-2'); assert.equal(s2.attempts, 0); assert.equal(s2.dry_runs, 1); assert.equal(s2.status, executedDry.state === 'PLANNED' ? 'planned' : s2.status);
    const job = await service.submit('SAMPLE-1', false); assert.equal((await summary(service, 'SAMPLE-1')).status, 'queued');
    await service.cancel(job.job_id); assert.equal((await summary(service, 'SAMPLE-1')).status, 'cancelled');
    const retry = await service.retry(job.job_id); await service.execute(retry.job_id);
    const s1 = await summary(service, 'SAMPLE-1'); assert.equal(s1.status, 'awaiting_review'); assert.equal(s1.attempts, 2); assert.equal(s1.latest_job_id, retry.job_id); assert.equal(s1.latest_state, 'READY_FOR_HUMAN');
    await service.closeIssue('SAMPLE-1', { resolution: 'MERGED', dry_run: false }, 'deep');
    assert.equal((await summary(service, 'SAMPLE-1')).status, 'closed_merged'); assert.equal((await summary(service, 'SAMPLE-1')).notes.length, 1);
    assert.deepEqual((await service.ticketNotes()).map((x) => x.issue_key), ['SAMPLE-1', 'SAMPLE-2']);
    assert.equal((await summary(service, 'SAMPLE-9')).status, 'not_seen');
    assert.ok(!JSON.stringify(await service.events({ limit: 500 })).includes('EVENT-LEAK-CANARY'));
  });

  it('attempts_with_current_notes drops to zero when a new note is added', async () => {
    const { service } = open();
    await service.addTicketNote('SAMPLE-1', { instructions: 'first', roles: ['swe'] }, 'deep');
    await ready(service); assert.equal((await summary(service, 'SAMPLE-1')).attempts_with_current_notes, 1);
    await service.addTicketNote('SAMPLE-1', { instructions: 'second', roles: ['swe'] }, 'deep');
    assert.equal((await summary(service, 'SAMPLE-1')).attempts_with_current_notes, 0);
  });
});
