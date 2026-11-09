import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parse } from 'yaml';
import { parseConfig, type AutosConfig, type GitWorkspace, type IssueSnapshot, type ProjectMapping, type ProviderRequest, type ProviderResult, type WorkflowDependencies } from '@autos/contracts';
import { exportDataset, FileArtifactStore, SqliteJobStore, WorkflowService } from '../../packages/workflow/src/index.js';
import { placePin, resolveStep, selectStart } from '../../packages/workflow/src/tiers.js';

let root: string;
let config: AutosConfig;
const BASE = 'b'.repeat(40);
const mapping: ProjectMapping = { project_key: 'SAMPLE', workspace: 'example', repository_slug: 'sample-app', development_branch: 'develop', sandbox_branch: null, enabled: true, source: { page_id: '67890', version: 7, fetched_at: '2026-11-07T20:00:00.000Z' } };
const issue = (key: string): IssueSnapshot => ({ key, project_key: 'SAMPLE', summary: 'Rename a field', description: 'Rename foo to bar', acceptance_criteria: ['works'], issue_type: 'Bug', status: 'Open', updated_at: '2026-11-07T20:00:00.000Z', fetched_at: '2026-11-07T20:00:00.000Z', comments: [], linked_issue_keys: [], components: [], url: `https://example.atlassian.net/browse/${key}` });
const sha = (n: number) => n.toString(16).padStart(64, '0');

type Reply = { code?: string; edit?: boolean; result?: unknown; times?: number };
interface Script {
  digest: number; requests: Array<ProviderRequest & { triage: boolean }>; commits: number;
  /** Keyed by `${provider}:${model}:${role}` (model 'default' when none); first entry is consumed (or decremented by times). */
  replies: Map<string, Reply[]>;
  triage: unknown; checksFail: number; sweSinceChecks: boolean;
}
const newScript = (): Script => ({ digest: 1, requests: [], commits: 0, replies: new Map(), triage: { schema_version: 1, roles: {} }, checksFail: 0, sweSinceChecks: false });
const reply = (s: Script, key: string, ...r: Reply[]) => s.replies.set(key, r);

function deps(script: Script, store: SqliteJobStore, artifacts: FileArtifactStore): WorkflowDependencies {
  const repo = () => config.bitbucket.allowed_repositories[0]!;
  return {
    config, jobs: store, artifacts, clock: { now: () => new Date('2026-11-07T20:00:00.000Z') },
    atlassian: {
      async getSavedFilter() { return { id: '12345', name: 'Synthetic', jql: 'project = SAMPLE' }; },
      async listIssueKeys() { return ['SAMPLE-1', 'SAMPLE-2']; }, async listIssues() { return [issue('SAMPLE-1'), issue('SAMPLE-2')]; },
      async getIssue(key: string) { return issue(key); }, async getBranchMap() { return [mapping]; },
    },
    precedents: { async findPrecedents() { return { outcome: 'NO_MATCH' as const, items: [] }; } },
    git: {
      async resolveBase() { return { base_sha: BASE, development_branch: 'develop' }; },
      async prepare(req) {
        const directory = join(root, 'ws', `${req.job_id}-dir`); await mkdir(directory, { recursive: true });
        return { job_id: req.job_id, issue_key: req.issue_key, repository: repo(), directory, base_sha: BASE, development_branch: 'develop', feature_branch: `deep/${req.issue_key}`, ...(req.continue_from ? { start_sha: req.continue_from.parent_commit_sha } : {}) } as GitWorkspace;
      },
      async inspectCandidate() { return { digest: sha(script.digest), paths: ['src/Fix.java'], diff: `+ fixed v${script.digest}` }; },
      async commit(req) { script.commits++; return { commit_sha: 'c'.repeat(40), candidate_digest: req.candidate_digest, paths: req.approved_paths }; },
      async readInstructionFiles() { return []; }, async takeHandoff() { return null; },
      async push(_ws, commitSha) { return { status: 'PUSHED' as const, commit_sha: commitSha }; },
    },
    runner: {
      async runRole(req) {
        const prompt = await readFile(req.prompt_path, 'utf8'); const triage = prompt.startsWith('You are a triage step');
        script.requests.push({ ...req, triage }); if (req.role === 'swe') script.sweSinceChecks = true;
        const base = { provider: req.provider, role: req.role, status: 'SUCCEEDED' as const, exit_code: 0, elapsed_ms: 1, transcript_path: req.transcript_path };
        if (triage) return { ...base, result: script.triage } as ProviderResult;
        const key = `${req.provider}:${req.model ?? 'default'}:${req.role}`; const queue = script.replies.get(key); const next = queue?.[0];
        if (next) {
          if (next.times === undefined || --next.times <= 0) queue!.shift();
          if (next.edit) script.digest++;
          if (next.code) return { ...base, status: 'FAILED', exit_code: 1, error_code: next.code } as unknown as ProviderResult;
          if (next.result !== undefined) return { ...base, result: typeof next.result === 'function' ? (next.result as (d: string) => unknown)(sha(script.digest)) : next.result } as ProviderResult;
        }
        if (req.role === 'swe') { script.digest++; return { ...base, result: 'Implemented.' } as ProviderResult; }
        const d = sha(script.digest);
        return { ...base, result: req.role === 'qa' ? { schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] } : { schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] } } as ProviderResult;
      },
      async runChecks(_ws, d, commands) {
        // Only candidate checks right after an SWE run fail (never baseline or the finalization re-run).
        const status = script.sweSinceChecks && script.checksFail > 0 ? (script.checksFail--, 'FAIL') : 'PASS'; script.sweSinceChecks = false;
        return { schema_version: 1, candidate_digest: d, recorded_at: new Date().toISOString(), checks: commands.map((c) => ({ name: c.executable, command: [c.executable, ...c.args], status, exit_code: status === 'PASS' ? 0 : 1, timed_out: false, required: c.required, report_paths: [] })) } as never;
      },
      async stop() { /* nothing running */ },
    },
  };
}

const MODELS = { luna: { provider: 'codex', model: 'gpt-6-luna' }, terra: { provider: 'codex', model: 'gpt-6-terra' } };
const TIERS = {
  sm: ['luna:medium'], 'sm-x': ['luna:xhigh'], 'rv-sm': ['luna:high'],
  med: ['terra:high', { provider: 'claude', model: 'sonnet', effort: 'high' }],
  lg: [{ provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }],
  xl: [{ provider: 'claude', model: 'opus', effort: 'max' }],
};
function tieredConfig(mutate: (c: any) => void = () => undefined): AutosConfig {
  const c = parse(readFileSync(new URL('../../config/config.example.yaml', import.meta.url), 'utf8')) as any;
  c.models = structuredClone(MODELS); c.model_tiers = structuredClone(TIERS);
  c.agents.swe = { ladder: ['sm', 'sm-x', 'med', 'lg', 'xl'] };
  c.agents.qa = { provider: 'codex' };
  c.agents.reviewer = { ladder: ['rv-sm', 'med', 'xl'], min: 'med' };
  c.jobs.max_repair_rounds = 1;
  c.storage = { data_dir: join(root, 'data'), artifacts_dir: join(root, 'artifacts'), workspaces_dir: join(root, 'workspaces') };
  mutate(c); return parseConfig(c);
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'autos-tiers-')); config = tieredConfig(); });
afterEach(async () => rm(root, { recursive: true, force: true }));

const open = (script: Script) => {
  const store = new SqliteJobStore(join(config.storage.data_dir, 'autos.sqlite')); const artifacts = new FileArtifactStore(config.storage.artifacts_dir);
  return { store, service: new WorkflowService(deps(script, store, artifacts)) };
};
const readJson = async (jobId: string, name: string) => JSON.parse(await readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8')) as Record<string, any>;
const readText = async (jobId: string, name: string) => readFile(join(config.storage.artifacts_dir, jobId, name), 'utf8');
const calls = async (jobId: string) => {
  const out: Array<Record<string, any>> = []; const priv = join(config.storage.artifacts_dir, jobId, '_private');
  for (const role of await readdir(priv)) for (const id of await readdir(join(priv, role))) { try { out.push(JSON.parse(await readFile(join(priv, role, id, 'call.json'), 'utf8'))); } catch { /* no call.json */ } }
  return out.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
};
const steps = (s: Script, role: string) => s.requests.filter((r) => r.role === role && !r.triage).map((r) => `${r.provider}/${r.model ?? '-'}/${r.effort ?? '-'}`);

describe('model tier ladders', () => {
  it('triage picks a start step (validated, clamped to ladder and floor) and every call records tier, model and effort', async () => {
    config = tieredConfig((c) => { c.triage = { tier: 'sm' }; });
    const s = newScript(); s.triage = { schema_version: 1, roles: { swe: { step: 2, reason: 'multi-file change\nsee https://x.example/y' }, reviewer: { step: 0, reason: 'trivial' } } };
    const { store, service } = open(s);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN', `${job.blocked_code}: ${job.blocked_reason}`);
    const triage = s.requests.filter((r) => r.triage);
    assert.equal(triage.length, 1); assert.equal(triage[0]!.role, 'qa'); assert.equal(triage[0]!.source_access, 'read'); assert.equal(triage[0]!.model, 'gpt-6-luna'); assert.equal(triage[0]!.effort, 'medium');
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-terra/high']);
    assert.deepEqual(steps(s, 'reviewer'), ['codex/gpt-6-terra/high'], 'reviewer clamped up to its floor');
    assert.deepEqual(steps(s, 'qa'), ['codex/-/-'], 'plain role keeps its provider chain');
    const tiers = await readJson(job.job_id, 'tiers.json');
    assert.equal(tiers.roles.swe.start, 'med'); assert.equal(tiers.roles.swe.start_source, 'triage');
    assert.match(tiers.roles.swe.start_reason, /triage: multi-file change see \[url\]/);
    assert.equal(tiers.roles.reviewer.start, 'med'); assert.match(tiers.roles.reviewer.start_reason, /clamped/);
    assert.equal(tiers.roles.qa, undefined);
    assert.equal(tiers.triage.status, 'CHOSEN'); assert.deepEqual(tiers.triage.requested, { swe: 2, reviewer: 0 });
    const recorded = await calls(job.job_id);
    const triageCall = recorded.find((c) => c.purpose === 'triage')!;
    assert.deepEqual([triageCall.role, triageCall.tier, triageCall.effort, triageCall.model], ['qa', 'sm', 'medium', 'gpt-6-luna']);
    const swe = recorded.find((c) => c.role === 'swe')!;
    assert.deepEqual([swe.tier, swe.effort, swe.model, swe.purpose], ['med', 'high', 'gpt-6-terra', 'role']);
    assert.equal(recorded.find((c) => c.role === 'qa' && c.purpose === 'role')!.tier, null);
    const events = await service.events({ job_id: job.job_id, limit: 500 });
    const selected = events.filter((e) => e.type === 'tier_selected');
    assert.deepEqual(selected.map((e) => [e.role, e.tier, e.outcome]), [['swe', 'med', 'TRIAGE'], ['reviewer', 'med', 'TRIAGE']]);
    const started = events.find((e) => e.type === 'role_started' && e.role === 'swe')!;
    assert.deepEqual([started.tier, started.model, started.effort], ['med', 'gpt-6-terra', 'high']);
    const summary = await readText(job.job_id, 'summary.md');
    assert.match(summary, /SWE: codex \[med: gpt-6-terra high\]/); assert.match(summary, /swe: solved at med \(start: triage\)/);
    // Dataset export carries tiers.json and per-call tier/effort.
    const records = []; for await (const r of exportDataset({ config, options: {} })) records.push(r);
    assert.equal((records[0]!.tiers as any).roles.swe.start, 'med');
    assert.ok(records[0]!.calls.some((c) => c.call?.tier === 'med' && c.call.effort === 'high'));
    store.close();
  });

  it('triage failure or malformed output falls back to the lowest step (or floor); disabled triage makes no call', async () => {
    config = tieredConfig((c) => { c.triage = { tier: 'sm' }; });
    const s = newScript(); s.triage = 'I think step 3 is good';
    const { store, service } = open(s);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN', `${job.blocked_code}: ${job.blocked_reason}`);
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-luna/medium']); assert.deepEqual(steps(s, 'reviewer'), ['codex/gpt-6-terra/high']);
    const tiers = await readJson(job.job_id, 'tiers.json');
    assert.equal(tiers.triage.status, 'FAILED'); assert.equal(tiers.triage.code, 'INVALID_OUTPUT');
    assert.equal(tiers.roles.swe.start_source, 'lowest'); assert.match(tiers.roles.swe.start_reason, /triage failed \(INVALID_OUTPUT\)/);
    store.close();
    config = tieredConfig((c) => { c.triage = { tier: 'sm', enabled: false }; });
    const s2 = newScript(); const second = open(s2);
    const job2 = await second.service.execute((await second.service.submit('SAMPLE-2', false)).job_id);
    assert.equal(job2.state, 'READY_FOR_HUMAN', `${job2.blocked_code}: ${job2.blocked_reason}`); assert.equal(s2.requests.filter((r) => r.triage).length, 0);
    assert.deepEqual(steps(s2, 'swe'), ['codex/gpt-6-luna/medium']);
    second.store.close();
  });

  it('a pin stored before Autos has seen the ticket is applied at pickup, survives a restart and skips triage', async () => {
    config = tieredConfig((c) => { c.triage = { tier: 'sm' }; });
    const s = newScript(); const first = open(s);
    const result = await first.service.setTierPin('SAMPLE-1', { tier: 'lg' }, 'deep');
    assert.deepEqual([result.step, result.in_ladder, result.pin.role, result.pin.effort], ['lg', true, 'swe', null]);
    assert.equal((await first.service.ticketNotes('SAMPLE-1'))[0]!.status, 'not_seen');
    assert.equal((await first.service.ticketNotes())[0]!.tier_pins[0]!.tier, 'lg');
    first.store.close();
    const { store, service } = open(s); // restart
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN', `${job.blocked_code}: ${job.blocked_reason}`);
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-sol/xhigh']);
    // Only the reviewer still needed triage (SWE pinned).
    const triage = s.requests.find((r) => r.triage)!; const prompt = await readFile(triage.prompt_path, 'utf8');
    assert.match(prompt, /reviewer:/); assert.doesNotMatch(prompt, /\nswe:/);
    const tiers = await readJson(job.job_id, 'tiers.json');
    assert.equal(tiers.roles.swe.start_source, 'ticket_pin'); assert.match(tiers.roles.swe.start_reason, /pinned by deep/);
    assert.equal(await service.clearTierPins('SAMPLE-1'), 1); assert.deepEqual(await service.tierPins('SAMPLE-1'), []);
    store.close();
  });

  it('pins are validated (unknown tier, effort an entry rejects, floor); an effort override replaces the ladder step in place', async () => {
    const { store, service } = open(newScript());
    await assert.rejects(() => service.setTierPin('SAMPLE-1', { tier: 'gemini' }, 'deep'), /Unknown model tier gemini/);
    await assert.rejects(() => service.setTierPin('SAMPLE-1', { tier: 'xl', effort: 'minimal' }, 'deep'), /claude does not accept effort minimal/);
    await assert.rejects(() => service.setTierPin('SAMPLE-1', { role: 'reviewer', tier: 'rv-sm' }, 'deep'), /below the reviewer floor/);
    await assert.rejects(() => service.setTierPin('SAMPLE-1', { role: 'reviewer', tier: 'lg' }, 'deep'), /cannot be compared with the floor/);
    await assert.rejects(() => service.setTierPin('OTHER-1', { tier: 'sm' }, 'deep'), /allowed_projects/);
    const override = await service.setTierPin('SAMPLE-1', { tier: 'med', effort: 'xhigh' }, 'deep');
    assert.deepEqual([override.step, override.in_ladder], ['med:xhigh', true]);
    const p = placePin(config, 'swe', { tier: 'med', effort: 'xhigh' });
    assert.ok(p.ok); assert.deepEqual(p.ok && p.steps, ['sm', 'sm-x', 'med:xhigh', 'lg', 'xl']); assert.equal(p.ok && p.index, 2);
    assert.deepEqual(resolveStep(config, 'swe', 'med:xhigh')!.chain.map((e) => [e.provider, e.model, e.effort]), [['codex', 'gpt-6-terra', 'xhigh'], ['claude', 'sonnet', 'xhigh']]);
    // A tier outside a floorless ladder is a fixed step; plain roles can be pinned too.
    const fixed = placePin(config, 'swe', { tier: 'rv-sm' }); assert.ok(fixed.ok); assert.deepEqual(fixed.ok && fixed.steps, ['rv-sm']);
    const qa = placePin(config, 'qa', { tier: 'xl' }); assert.ok(qa.ok); assert.deepEqual(qa.ok && qa.steps, ['xl']);
    assert.ok((await service.setTierPin('SAMPLE-1', { role: 'reviewer', tier: 'xl' }, 'deep')).in_ladder);
    store.close();
  });

  it('pin precedence: revise --tier beats the ticket pin; a revision without --tier starts at the tier that finished its parent', async () => {
    const s = newScript(); const { store, service } = open(s);
    s.checksFail = 1; // initial attempt escalates once: sm -> sm-x
    const first = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(first.state, 'READY_FOR_HUMAN', `${first.blocked_code}: ${first.blocked_reason}`);
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-luna/medium', 'codex/gpt-6-luna/xhigh']);
    s.requests.length = 0;
    const second = await service.execute((await service.reviseIssue('SAMPLE-1', { instructions: 'Also rename the getter' }, 'deep')).job_id);
    assert.equal(second.state, 'READY_FOR_HUMAN', `${second.blocked_code}: ${second.blocked_reason}`);
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-luna/xhigh'], 'never below the previous finishing tier');
    assert.equal((await readJson(second.job_id, 'tiers.json')).roles.swe.start_source, 'previous');
    s.requests.length = 0;
    await service.setTierPin('SAMPLE-1', { tier: 'xl' }, 'deep');
    const third = await service.execute((await service.reviseIssue('SAMPLE-1', { instructions: 'Tiny typo' }, 'deep', { tier: 'sm' })).job_id);
    assert.equal(third.state, 'READY_FOR_HUMAN', `${third.blocked_code}: ${third.blocked_reason}`);
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-luna/medium'], 'revise --tier wins over the ticket pin and the previous tier');
    assert.equal((await readJson(third.job_id, 'tiers.json')).roles.swe.start_source, 'attempt_pin');
    s.requests.length = 0;
    const fourth = await service.execute((await service.reviseIssue('SAMPLE-1', { instructions: 'More' }, 'deep')).job_id);
    assert.deepEqual(steps(s, 'swe'), ['claude/opus/max'], 'the ticket pin wins over the previous tier');
    assert.equal(fourth.state, 'READY_FOR_HUMAN', `${fourth.blocked_code}: ${fourth.blocked_reason}`);
    await assert.rejects(() => service.reviseIssue('SAMPLE-1', { instructions: 'x' }, 'deep', { tier: 'nope' }), /Unknown model tier/);
    store.close();
  });

  it('a failed check, QA or review moves the next SWE run one tier up without consuming repair rounds; at the top max_repair_rounds applies', async () => {
    const s = newScript(); s.checksFail = 1;
    // QA and review run every round: round 1 fails checks, round 2 fails QA, round 3 fails review, round 4 passes.
    const qaPass = { result: (d: string) => ({ schema_version: 1, candidate_digest: d, status: 'PASS', evidence: ['ok'] }) };
    const reviewPass = { result: (d: string) => ({ schema_version: 1, candidate_digest: d, status: 'PASS', findings: [] }) };
    reply(s, 'codex:default:qa', qaPass, { result: (d: string) => ({ schema_version: 1, candidate_digest: d, status: 'FAIL', evidence: ['wrong'] }) });
    reply(s, 'codex:gpt-6-terra:reviewer', reviewPass, reviewPass, { result: (d: string) => ({ schema_version: 1, candidate_digest: d, status: 'FAIL', findings: [{ severity: 'HIGH', file: 'src/Fix.java', line: 1, issue: 'bug', suggested_fix: 'fix' }] }) });
    const { store, service } = open(s);
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN', `${job.blocked_code}: ${job.blocked_reason}`); assert.equal(job.repair_round, 0, 'escalation rounds are not repair rounds');
    assert.deepEqual(steps(s, 'swe'), ['codex/gpt-6-luna/medium', 'codex/gpt-6-luna/xhigh', 'codex/gpt-6-terra/high', 'codex/gpt-6-sol/xhigh']);
    const tiers = await readJson(job.job_id, 'tiers.json');
    assert.equal(tiers.roles.swe.current, 'lg'); assert.equal(tiers.roles.swe.escalations.length, 3);
    assert.match(tiers.roles.swe.escalations[0].reason, /CHECKS/); assert.match(tiers.roles.swe.escalations[1].reason, /QA/); assert.match(tiers.roles.swe.escalations[2].reason, /REVIEW/);
    assert.deepEqual(tiers.roles.reviewer.escalations, [], 'QA/reviewer stay at their start tier on a FAIL verdict');
    const summary = await readText(job.job_id, 'summary.md'); assert.match(summary, /swe: started at sm, solved at lg after 3 escalations/);
    const events = await service.events({ job_id: job.job_id, limit: 500 });
    assert.equal(events.filter((e) => e.type === 'tier_escalated').length, 3);
    store.close();
    // At the top tier the usual repair budget applies, then the job blocks.
    const t = newScript(); t.checksFail = 10; const second = open(t);
    await second.service.setTierPin('SAMPLE-2', { tier: 'xl' }, 'deep');
    const blocked = await second.service.execute((await second.service.submit('SAMPLE-2', false)).job_id);
    assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.blocked_code, 'CHECK_FAILED');
    assert.deepEqual(steps(t, 'swe'), ['claude/opus/max', 'claude/opus/max'], 'one repair round (max_repair_rounds=1) at the top tier');
    second.store.close();
  });

  it('a provider failure moves to the next entry of the same tier without escalating; CONTEXT on a tier\'s last entry escalates', async () => {
    const s = newScript(); reply(s, 'codex:gpt-6-terra:swe', { code: 'RATE_LIMIT', times: 10 });
    const { store, service } = open(s);
    await service.setTierPin('SAMPLE-1', { tier: 'med' }, 'deep');
    const job = await service.execute((await service.submit('SAMPLE-1', false)).job_id);
    assert.equal(job.state, 'READY_FOR_HUMAN', `${job.blocked_code}: ${job.blocked_reason}`);
    assert.equal(steps(s, 'swe').at(-1), 'claude/sonnet/high');
    const tiers = await readJson(job.job_id, 'tiers.json');
    assert.equal(tiers.roles.swe.current, 'med'); assert.deepEqual(tiers.roles.swe.escalations, []);
    const attempts = (await readJson(job.job_id, 'rounds.json')).rounds.flatMap((r: any) => r.provider_attempts).filter((a: any) => a.role === 'swe');
    assert.deepEqual(attempts.map((a: any) => [a.provider, a.tier, a.effort, a.chain_index, a.error_code]), [['codex', 'med', 'high', 0, 'RATE_LIMIT'], ['claude', 'med', 'high', 1, null]]);
    store.close();
    const t = newScript(); reply(t, 'codex:gpt-6-luna:swe', { code: 'CONTEXT', edit: true, times: 2 });
    const second = open(t);
    const job2 = await second.service.execute((await second.service.submit('SAMPLE-2', false)).job_id);
    assert.equal(job2.state, 'READY_FOR_HUMAN', `${job2.blocked_code}: ${job2.blocked_reason}`);
    assert.deepEqual(steps(t, 'swe'), ['codex/gpt-6-luna/medium', 'codex/gpt-6-luna/xhigh', 'codex/gpt-6-terra/high']);
    const esc = (await readJson(job2.job_id, 'tiers.json')).roles.swe.escalations;
    assert.deepEqual(esc.map((e: any) => [e.from, e.to]), [['sm', 'sm-x'], ['sm-x', 'med']]);
    assert.match(esc[0].reason, /CONTEXT/);
    second.store.close();
  });

  it('start selection is pure and clamps: previous below the floor is raised; invalid pins fall through', () => {
    const reviewer = selectStart(config, 'reviewer', { previous: 'rv-sm' });
    assert.equal(reviewer!.steps[reviewer!.start_index], 'med'); assert.match(reviewer!.start_reason, /raised to floor/);
    const fallThrough = selectStart(config, 'swe', { ticketPin: { ref: { tier: 'gone' }, author: 'deep' } });
    assert.equal(fallThrough!.start_source, 'lowest'); assert.match(fallThrough!.start_reason, /ticket_pin gone ignored/);
    assert.equal(selectStart(config, 'qa', {}), null);
    const high = selectStart(config, 'swe', { triage: { index: 99, reason: 'hard' } });
    assert.equal(high!.steps[high!.start_index], 'xl');
  });
});
