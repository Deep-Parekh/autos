// Model-tier pins: controller routes (fake workflow) and the `autos tier` / `note --tier` / `revise --tier` CLI surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AutosError, parseConfigYaml, type AgentRole, type JobRecord, type TicketNote, type TicketNotesSummary, type TierPin, type TierPinRequest, type WorkflowServicePort } from '@autos/contracts';
import { createController, type ControllerOptions } from '../../apps/controller/src/index.js';
import { formatTicketDetail, formatTicketNotesTable, main } from '../../apps/cli/src/index.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const config = parseConfigYaml(canonical);
const TOKEN = 'tier-pins-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-07T12:00:00.000Z';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const parent: JobRecord = { job_id: PARENT, issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'READY_FOR_HUMAN', dry_run: false, repair_round: 0, created_at: now, updated_at: now };
const child = { ...parent, job_id: CHILD, state: 'CANCELLED', parent_job_id: PARENT, revision: 1 } as JobRecord;

/**
 * Fake workflow with the documented pin semantics: tiers sm, med, lg (the ladder) and xl (not in the ladder: a fixed
 * step); `tiny` is below the floor; DONE-* is closed; BAD-* is outside the allowed projects. `step` is `tier[:effort]`.
 */
function setup() {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const pins = new Map<string, TierPin[]>();
  const notes = new Map<string, TicketNote[]>();
  const logs: string[] = [];
  const ladder = ['sm', 'med', 'lg'];
  const summary = (key: string): TicketNotesSummary => ({ issue_key: key, notes: notes.get(key) ?? [], held: false, status: 'not_seen', attempts: 0, dry_runs: 0, latest_job_id: null, latest_state: null, last_activity_at: null, attempts_with_current_notes: 0, tier_pins: pins.get(key) ?? [] });
  const workflow: WorkflowServicePort = {
    ...monitorPort([makeEvent(1)]),
    submit: async () => parent, execute: async () => child, cancel: async () => parent, retry: async () => parent, poll: async () => undefined,
    list: async () => [parent], get: async (id) => (id === PARENT ? parent : null),
    revise: async (...args) => { calls.push({ kind: 'revise', args }); if (args[3]?.tier === 'tiny') throw new AutosError('INVALID_INPUT', 'swe step tiny is below the floor med'); return child; },
    reviseIssue: async (...args) => { calls.push({ kind: 'reviseIssue', args }); return child; },
    addTicketNote: async (key, note, author) => {
      calls.push({ kind: 'add', args: [key, note, author] });
      const stored: TicketNote = { note_id: randomUUID(), issue_key: key, instructions: note.instructions, roles: note.roles ?? ['swe'], author, created_at: now };
      notes.set(key, [...(notes.get(key) ?? []), stored]);
      return stored;
    },
    ticketNotes: async (key?: string) => key !== undefined ? [summary(key)] : [...new Set([...notes.keys(), ...pins.keys()])].sort().map(summary),
    setTierPin: async (key: string, request: TierPinRequest, author: string) => {
      calls.push({ kind: 'setTierPin', args: [key, request, author] });
      if (key.startsWith('BAD-')) throw new AutosError('INVALID_INPUT', 'Project BAD is not in jira.allowed_projects');
      if (key.startsWith('DONE-')) throw new AutosError('CONFLICT', 'issue is closed');
      if (![...ladder, 'xl', 'tiny'].includes(request.tier)) throw new AutosError('INVALID_INPUT', `Unknown tier ${request.tier} (known: sm, med, lg, xl)`);
      if (request.tier === 'tiny') throw new AutosError('INVALID_INPUT', 'swe step tiny is below the floor med');
      const role: AgentRole = request.role ?? 'swe';
      const pin: TierPin = { issue_key: key, role, tier: request.tier, effort: request.effort ?? null, author, created_at: now };
      pins.set(key, [...(pins.get(key) ?? []).filter((p) => p.role !== role), pin]);
      return { pin, step: request.effort ? `${request.tier}:${request.effort}` : request.tier, in_ladder: ladder.includes(request.tier) };
    },
    clearTierPins: async (key: string, role?: AgentRole) => {
      calls.push({ kind: 'clearTierPins', args: role === undefined ? [key] : [key, role] });
      const own = pins.get(key) ?? [];
      const kept = role === undefined ? [] : own.filter((p) => p.role !== role);
      if (kept.length) pins.set(key, kept); else pins.delete(key);
      return own.length - kept.length;
    },
    tierPins: async (key: string) => pins.get(key) ?? [],
  };
  const options: ControllerOptions = {
    config, workflow, operatorToken: TOKEN, runnerHealthTimeoutMs: 100,
    logStream: { write: (line) => logs.push(line) },
    onBackgroundFailure: () => undefined,
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
  };
  return { options, calls, logs, pins };
}
const call = (app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, extra: { payload?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({ method, url, headers: extra.headers ?? auth, ...(extra.payload !== undefined ? { payload: extra.payload as object } : {}) });
const audits = (logs: string[]) => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === 'audit');

// ---- Routes ----

test('tier routes require the bearer token', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    for (const [method, url] of [['GET', '/v1/issues/SAMPLE-1/tier'], ['PUT', '/v1/issues/SAMPLE-1/tier'], ['DELETE', '/v1/issues/SAMPLE-1/tier']] as const) {
      assert.equal((await call(app, method, url, { headers: {}, ...(method === 'PUT' ? { payload: { tier: 'med' } } : {}) })).statusCode, 401, `${method} ${url}`);
    }
    assert.equal(f.calls.length, 0);
  } finally { await app.close(); }
});

test('PUT tier pins a role (default swe), GET lists pins, DELETE clears one role or all, with audit lines', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    assert.deepEqual((await call(app, 'GET', '/v1/issues/NEW-1/tier')).json(), { pins: [] });
    const put = await call(app, 'PUT', '/v1/issues/NEW-1/tier', { payload: { tier: 'med', effort: 'xhigh' } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { pin: { issue_key: 'NEW-1', role: 'swe', tier: 'med', effort: 'xhigh', author: 'operator', created_at: now }, step: 'med:xhigh', in_ladder: true });
    assert.deepEqual(f.calls[0]!.args, ['NEW-1', { role: 'swe', tier: 'med', effort: 'xhigh' }, 'operator']);
    const qa = await call(app, 'PUT', '/v1/issues/NEW-1/tier', { payload: { role: 'qa', tier: 'xl' }, headers: { ...auth, 'x-autos-operator': 'alice' } });
    assert.equal(qa.statusCode, 200); assert.equal(qa.json().pin.effort, null); assert.equal(qa.json().in_ladder, false); assert.equal(qa.json().pin.author, 'alice');
    assert.deepEqual((await call(app, 'GET', '/v1/issues/NEW-1/tier')).json().pins.map((p: TierPin) => p.role), ['swe', 'qa']);
    // The issue view and the notes summary carry the pins; a pin alone makes the issue known.
    assert.equal((await call(app, 'GET', '/v1/issues/NEW-1/notes')).json().tier_pins.length, 2);
    const issue = await call(app, 'GET', '/v1/issues/NEW-1');
    assert.equal(issue.statusCode, 200); assert.equal(issue.json().ticket_notes.tier_pins[0].tier, 'med');
    assert.deepEqual((await call(app, 'GET', '/v1/notes')).json().tickets.map((t: TicketNotesSummary) => t.issue_key), ['NEW-1']);
    assert.deepEqual((await call(app, 'DELETE', '/v1/issues/NEW-1/tier?role=qa')).json(), { removed: 1 });
    assert.deepEqual(f.calls.at(-1)!.args, ['NEW-1', 'qa']);
    assert.deepEqual((await call(app, 'DELETE', '/v1/issues/NEW-1/tier')).json(), { removed: 1 });
    assert.deepEqual(f.calls.at(-1)!.args, ['NEW-1']);
    assert.equal((await call(app, 'DELETE', '/v1/issues/NEW-1/tier?role=admin')).statusCode, 400);
    const audit = audits(f.logs);
    assert.deepEqual(audit.map((line) => line.action), ['tier_pin_set', 'tier_pin_set', 'tier_pin_clear', 'tier_pin_clear']);
    assert.equal(audit[0]!.tier, 'med'); assert.equal(audit[0]!.effort, 'xhigh'); assert.equal(audit[0]!.role, 'swe'); assert.equal(audit[1]!.actor, 'alice'); assert.equal(audit[2]!.role, 'qa');
  } finally { await app.close(); }
});

test('PUT tier validates the body and maps workflow refusals: 400 with the reason, 409 when closed', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    for (const payload of [{}, { tier: 'Codex' }, { tier: 'med:xhigh' }, { tier: 'med', effort: 'turbo' }, { tier: 'med', role: 'admin' }, { tier: 'med', extra: 1 }]) {
      const response = await call(app, 'PUT', '/v1/issues/NEW-1/tier', { payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload)); assert.equal(response.json().code, 'INVALID_INPUT');
    }
    assert.equal((await call(app, 'PUT', '/v1/issues/NEW-1/tier', { payload: { tier: 'med' }, headers: { ...auth, 'x-autos-operator': 'bad label!' } })).statusCode, 400);
    assert.equal(f.calls.length, 0);
    const unknown = await call(app, 'PUT', '/v1/issues/NEW-1/tier', { payload: { tier: 'gpt-xl' } });
    assert.equal(unknown.statusCode, 400); assert.match(unknown.json().message, /Unknown tier gpt-xl/);
    const floor = await call(app, 'PUT', '/v1/issues/NEW-1/tier', { payload: { tier: 'tiny' } });
    assert.equal(floor.statusCode, 400); assert.match(floor.json().message, /below the floor med/);
    assert.equal((await call(app, 'PUT', '/v1/issues/BAD-1/tier', { payload: { tier: 'med' } })).statusCode, 400);
    const closed = await call(app, 'PUT', '/v1/issues/DONE-1/tier', { payload: { tier: 'med' } });
    assert.equal(closed.statusCode, 409); assert.equal(closed.json().code, 'CONFLICT');
    assert.equal(audits(f.logs).length, 0);
  } finally { await app.close(); }
});

test('revision routes pass an optional SWE tier pin and reject effort without tier', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const job = await call(app, 'POST', `/v1/jobs/${PARENT}/revisions`, { payload: { instructions: 'fix it', tier: 'med', effort: 'xhigh' } });
    assert.equal(job.statusCode, 202);
    assert.deepEqual(f.calls.at(-1)!.args, [PARENT, { instructions: 'fix it', roles: ['swe'] }, 'operator', { tier: 'med', effort: 'xhigh' }]);
    const issue = await call(app, 'POST', '/v1/issues/SAMPLE-1/revisions', { payload: { instructions: 'fix it', roles: ['qa'], tier: 'xl' } });
    assert.equal(issue.statusCode, 202);
    assert.deepEqual(f.calls.at(-1)!.args, ['SAMPLE-1', { instructions: 'fix it', roles: ['qa'] }, 'operator', { tier: 'xl' }]);
    // Without a tier the workflow is called exactly as before (no pin argument).
    await call(app, 'POST', `/v1/jobs/${PARENT}/revisions`, { payload: { instructions: 'plain' } });
    assert.equal(f.calls.at(-1)!.args.length, 3);
    const before = f.calls.length;
    for (const payload of [{ instructions: 'x', effort: 'high' }, { instructions: 'x', tier: 'Bad Tier' }, { instructions: 'x', tier: 'med', effort: 'turbo' }, { tier: 'med' }]) {
      assert.equal((await call(app, 'POST', `/v1/jobs/${PARENT}/revisions`, { payload })).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(f.calls.length, before);
    const floor = await call(app, 'POST', `/v1/jobs/${PARENT}/revisions`, { payload: { instructions: 'x', tier: 'tiny' } });
    assert.equal(floor.statusCode, 400); assert.match(floor.json().message, /below the floor/);
    const audit = audits(f.logs).filter((line) => line.action === 'job_revise' || line.action === 'issue_revise');
    assert.equal(audit[0]!.tier, 'med'); assert.equal(audit[0]!.effort, 'xhigh'); assert.equal(audit[1]!.tier, 'xl'); assert.equal(audit[2]!.tier, undefined);
    assert.equal(f.logs.join('').includes('fix it'), false);
  } finally { await app.close(); }
});

// ---- CLI ----

async function withCli<T>(run: (ctx: { f: ReturnType<typeof setup>; run(...args: string[]): Promise<number>; out: string[]; err: string[] }) => Promise<T>): Promise<T> {
  const f = setup(); const app = await createController(f.options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const dir = await mkdtemp(join(tmpdir(), 'autos-tier-'));
  const out: string[] = []; const err: string[] = [];
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, `port: ${port}`));
    const deps = { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), now: () => Date.parse(now) };
    return await run({ f, out, err, run: (...args: string[]) => main(['--config', configPath, ...args], deps) });
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}
const pinCalls = (f: ReturnType<typeof setup>) => f.calls.filter((c) => c.kind === 'setTierPin').map((c) => c.args);

test('autos tier sets, lists and clears pins', async () => {
  await withCli(async ({ f, run, out, err }) => {
    assert.equal(await run('tier', 'SAMPLE-1', 'med:xhigh'), 0);
    assert.equal(out[0], 'Pinned swe of SAMPLE-1 to med:xhigh (in the ladder; escalation continues to the next tier)');
    assert.equal(await run('tier', 'SAMPLE-1', 'xl', '--effort', 'max', '--role', 'reviewer'), 0);
    assert.match(out.join('\n'), /Pinned reviewer of SAMPLE-1 to xl:max \(fixed step: not in the role's ladder, no escalation\)/);
    assert.deepEqual(pinCalls(f), [['SAMPLE-1', { role: 'swe', tier: 'med', effort: 'xhigh' }, 'operator'], ['SAMPLE-1', { role: 'reviewer', tier: 'xl', effort: 'max' }, 'operator']]);
    out.length = 0; assert.equal(await run('tier', 'SAMPLE-1'), 0);
    assert.match(out.join('\n'), /Tier pins for SAMPLE-1/); assert.match(out.join('\n'), /swe: med:xhigh by operator/); assert.match(out.join('\n'), /reviewer: xl:max/);
    out.length = 0; assert.equal(await run('--json', 'tier', 'SAMPLE-1'), 0); assert.equal(JSON.parse(out.join('\n')).pins.length, 2);
    out.length = 0; assert.equal(await run('--json', 'tier', 'SAMPLE-1', 'med'), 0);
    assert.deepEqual(JSON.parse(out.join('\n')), { pin: { issue_key: 'SAMPLE-1', role: 'swe', tier: 'med', effort: null, author: 'operator', created_at: now }, step: 'med', in_ladder: true });
    out.length = 0; assert.equal(await run('tier', 'SAMPLE-1', '--clear', '--role', 'reviewer'), 0); assert.match(out[0]!, /Removed 1 tier pin \(reviewer\) from SAMPLE-1/);
    assert.equal(await run('tier', 'SAMPLE-1', '--clear'), 0);
    out.length = 0; assert.equal(await run('tier', 'SAMPLE-1'), 0); assert.equal(out[0], 'No tier pins for SAMPLE-1.');
    // Refusals carry the controller's reason; usage errors exit 2 before any call.
    err.length = 0; assert.equal(await run('tier', 'SAMPLE-1', 'tiny'), 2); assert.match(err.join('\n'), /below the floor med/);
    err.length = 0; assert.equal(await run('tier', 'DONE-1', 'med'), 1); assert.match(err.join('\n'), /CONFLICT/);
    const before = f.calls.length;
    for (const args of [['med:xhigh', '--effort', 'high'], ['med', '--effort', 'turbo'], ['med:turbo'], ['Codex'], ['--effort', 'high'], ['--role', 'qa'], ['med', '--clear'], ['med', '--role', 'admin'], ['med', '--bogus']]) {
      assert.equal(await run('tier', 'SAMPLE-1', ...args), 2, args.join(' '));
    }
    assert.equal(await run('tier', 'bad-key', 'med'), 2);
    assert.equal(f.calls.length, before);
  });
});

test('autos note --tier stores notes and pins the SWE tier; --tier works alone; --effort needs --tier', async () => {
  await withCli(async ({ f, run, out }) => {
    assert.equal(await run('note', 'NEW-2', '--swe', 'Change only InvoiceService.java', '--tier', 'med', '--effort', 'xhigh'), 0);
    assert.equal(f.calls.filter((c) => c.kind === 'add').length, 1);
    assert.deepEqual(pinCalls(f), [['NEW-2', { role: 'swe', tier: 'med', effort: 'xhigh' }, 'operator']]);
    assert.match(out.join('\n'), /Stored note/); assert.match(out.join('\n'), /Pinned swe of NEW-2 to med:xhigh \(in the ladder; escalation continues to the next tier\)/);
    out.length = 0; assert.equal(await run('note', 'NEW-3', '--tier', 'xl'), 0);
    assert.match(out.join('\n'), /Pinned swe of NEW-3 to xl/);
    out.length = 0; assert.equal(await run('--json', 'note', 'NEW-4', '--tier', 'sm:high'), 0);
    assert.equal(JSON.parse(out.join('\n')).tier.step, 'sm:high');
    const before = f.calls.length;
    assert.equal(await run('note', 'NEW-5', '--swe', 'x', '--effort', 'high'), 2);
    assert.equal(await run('note', 'NEW-5', '--list', '--tier', 'med'), 2);
    assert.equal(await run('note', 'NEW-5', '--tier', 'med:high', '--effort', 'xhigh'), 2);
    assert.equal(f.calls.length, before);
  });
});

test('autos revise --tier --effort sends the pin in the revision body', async () => {
  await withCli(async ({ f, run, out }) => {
    assert.equal(await run('revise', PARENT, '--note', 'Handle the empty list', '--tier', 'med', '--effort', 'xhigh'), 0);
    assert.deepEqual(f.calls.at(-1)!.args, [PARENT, { instructions: 'Handle the empty list', roles: ['swe'] }, 'operator', { tier: 'med', effort: 'xhigh' }]);
    assert.equal(await run('revise', 'SAMPLE-1', '--note', 'again', '--tier', 'xl:max'), 0);
    assert.deepEqual(f.calls.at(-1)!.args, ['SAMPLE-1', { instructions: 'again', roles: ['swe'] }, 'operator', { tier: 'xl', effort: 'max' }]);
    assert.equal(await run('revise', PARENT, '--note', 'plain'), 0);
    assert.equal(f.calls.at(-1)!.args.length, 3);
    const before = f.calls.length;
    assert.equal(await run('revise', PARENT, '--note', 'x', '--effort', 'high'), 2);
    assert.equal(await run('revise', PARENT, '--note', 'x', '--tier', 'med:high', '--effort', 'xhigh'), 2);
    assert.equal(await run('revise', PARENT, '--note', 'x', '--tier', 'NOPE'), 2);
    assert.equal(f.calls.length, before);
    out.length = 0;
  });
});

test('autos notes and autos show display pins', async () => {
  await withCli(async ({ run, out }) => {
    await run('tier', 'NEW-7', 'med:xhigh'); await run('tier', 'NEW-7', 'xl', '--role', 'qa');
    out.length = 0; assert.equal(await run('notes'), 0);
    assert.match(out[0]!, /^KEY\s+NOTES\s+HELD\s+TIER\s+STATUS/);
    assert.match(out.find((line) => line.startsWith('NEW-7'))!, /^NEW-7\s+0\s+no\s+swe=med:xhigh qa=xl\s+not seen/);
    out.length = 0; assert.equal(await run('notes', 'NEW-7'), 0);
    assert.match(out.join('\n'), /Tier pins \(starting step/); assert.match(out.join('\n'), /  swe: med:xhigh by operator at /);
    out.length = 0; assert.equal(await run('show', 'NEW-7'), 0);
    const text = out.join('\n');
    assert.match(text, /No attempts\./); assert.match(text, /Ticket notes \(NEW-7\)/); assert.match(text, /qa: xl by operator/);
  });
  const entry: TicketNotesSummary = { issue_key: 'ABC-1', notes: [], held: true, status: 'held', attempts: 0, dry_runs: 0, latest_job_id: null, latest_state: null, last_activity_at: null, attempts_with_current_notes: 0, tier_pins: [] };
  assert.match(formatTicketNotesTable([entry])[1]!, /^ABC-1\s+0\s+yes\s+-\s+held/);
  assert.equal(formatTicketDetail(entry).some((line) => line.startsWith('Tier pins')), false);
});

test('help documents autos tier and the --tier flags', async () => {
  const out: string[] = [];
  assert.equal(await main(['--help'], { stdout: (l) => out.push(l) }), 0);
  const text = out.join('\n');
  assert.match(text, /tier ISSUE-123 TIER\[:EFFORT\]/); assert.match(text, /--clear/); assert.match(text, /revise JOB_ID\|ISSUE-123 .*--tier TIER\[:EFFORT\]/); assert.match(text, /--tier TIER\[:EFFORT\] \[--effort LEVEL\]\] \[--url URL\]/);
});
