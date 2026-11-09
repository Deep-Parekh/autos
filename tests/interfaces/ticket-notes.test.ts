import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AutosError, MAX_TICKET_NOTES, parseConfigYaml, type JobRecord, type OperatorNoteRequest, type TicketNote, type TicketNotesSummary, type WorkflowServicePort } from '@autos/contracts';
import { createController, type ControllerOptions } from '../../apps/controller/src/index.js';
import { formatTicketNotesTable, main } from '../../apps/cli/src/index.js';
import { makeEvent, monitorPort } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const config = parseConfigYaml(canonical);
const TOKEN = 'ticket-notes-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const now = '2026-11-07T12:00:00.000Z';
const SECRET = 'ZEBRA-MARKER only touch InvoiceService';
const job: JobRecord = { job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', issue_key: 'SAMPLE-1', repository_id: null, base_sha: null, state: 'READY_FOR_HUMAN', dry_run: false, repair_round: 0, created_at: now, updated_at: now };

/** In-memory ticket notes with the documented error semantics (400 wrong project, 404 unknown note, 409 closed / too many). */
function setup(jiraExists?: (key: string) => Promise<boolean>) {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const notes = new Map<string, TicketNote[]>(); const held = new Set<string>();
  const logs: string[] = [];
  const summary = (key: string): TicketNotesSummary => {
    const own = notes.get(key) ?? [];
    return key === 'SAMPLE-1'
      ? { issue_key: key, notes: own, held: held.has(key), status: 'awaiting_review', attempts: 2, dry_runs: 1, latest_job_id: job.job_id, latest_state: 'READY_FOR_HUMAN', last_activity_at: '2026-11-07T09:55:00.000Z', attempts_with_current_notes: own.length ? 1 : 0, tier_pins: [] }
      : { issue_key: key, notes: own, held: held.has(key), status: held.has(key) ? 'held' : 'not_seen', attempts: 0, dry_runs: 0, latest_job_id: null, latest_state: null, last_activity_at: null, attempts_with_current_notes: 0, tier_pins: [] };
  };
  const monitor = monitorPort([makeEvent(1)]);
  const workflow: WorkflowServicePort = {
    ...monitor,
    submit: async () => job, execute: async () => job, cancel: async () => job, retry: async () => job, poll: async () => undefined, revise: async () => job,
    list: async () => [job], get: async () => job,
    addTicketNote: async (key: string, note: OperatorNoteRequest, author: string) => {
      calls.push({ kind: 'add', args: [key, note, author] });
      if (key.startsWith('BAD-')) throw new AutosError('INVALID_INPUT', `project not allowed ${SECRET}`);
      if (key === 'DONE-1') throw new AutosError('CONFLICT', `closed ${SECRET}`);
      const own = notes.get(key) ?? [];
      if (own.length >= MAX_TICKET_NOTES) throw new AutosError('CONFLICT', 'too many');
      const stored: TicketNote = { note_id: randomUUID(), issue_key: key, instructions: note.instructions, roles: note.roles ?? ['swe'], author, created_at: now };
      notes.set(key, [...own, stored]);
      return stored;
    },
    removeTicketNotes: async (key: string, noteId?: string) => {
      calls.push({ kind: 'remove', args: [key, noteId] });
      const own = notes.get(key) ?? [];
      if (noteId === undefined) { notes.delete(key); return own.length; }
      if (!own.some((note) => note.note_id === noteId)) throw new AutosError('NOT_FOUND', 'no such note');
      notes.set(key, own.filter((note) => note.note_id !== noteId)); return 1;
    },
    setTicketHold: async (key: string, value: boolean, author: string) => { calls.push({ kind: 'hold', args: [key, value, author] }); if (value) held.add(key); else held.delete(key); },
    ticketNotes: async (key?: string) => key !== undefined ? [summary(key)] : [...new Set([...notes.keys(), ...held])].sort().map(summary),
  };
  const options: ControllerOptions = {
    config, workflow, operatorToken: TOKEN, runnerHealthTimeoutMs: 100,
    logStream: { write: (line) => logs.push(line) },
    ...(jiraExists ? { diagnostics: { jiraFilter: async () => ({ matching_issues: 0 }), resolveBase: async () => ({ base_sha: 'a', development_branch: 'develop' }), jiraIssueExists: jiraExists } } : {}),
    artifacts: { write: async () => undefined, prepareRole: async () => ({ prompt_path: 'p', transcript_path: 't' }), manifest: async () => { throw new Error('none'); } },
    providers: async () => [], projects: async () => [], testProviders: async () => [], close: async () => undefined,
  };
  return { options, calls, logs, notes };
}
const call = (app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, extra: { payload?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({ method, url, headers: extra.headers ?? auth, ...(extra.payload !== undefined ? { payload: extra.payload as object } : {}) });

// ---- Routes ----

test('ticket note routes require the bearer token', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    for (const [method, url, payload] of [['POST', '/v1/issues/SAMPLE-9/notes', { instructions: 'x' }], ['DELETE', '/v1/issues/SAMPLE-9/notes', undefined], ['PUT', '/v1/issues/SAMPLE-9/hold', undefined], ['DELETE', '/v1/issues/SAMPLE-9/hold', undefined], ['GET', '/v1/notes', undefined], ['GET', '/v1/issues/SAMPLE-9/notes', undefined]] as const) {
      assert.equal((await call(app, method, url, { headers: {}, ...(payload ? { payload } : {}) })).statusCode, 401, `${method} ${url}`);
    }
    assert.equal(f.calls.length, 0);
  } finally { await app.close(); }
});

test('POST notes stores a note for an unseen issue (201), defaults roles and author, and never echoes it into logs', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const created = await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: SECRET } });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.issue_key, 'NEW-5'); assert.deepEqual(body.roles, ['swe']); assert.equal(body.author, 'operator'); assert.equal(body.instructions, SECRET); assert.equal(body.jira, 'unchecked');
    assert.deepEqual(f.calls[0]!.args, ['NEW-5', { instructions: SECRET, roles: ['swe'] }, 'operator']);
    const labelled = await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: 'qa one', roles: ['qa', 'reviewer'] }, headers: { ...auth, 'x-autos-operator': 'alice@example.com' } });
    assert.equal(labelled.statusCode, 201); assert.equal(labelled.json().author, 'alice@example.com'); assert.deepEqual(labelled.json().roles, ['qa', 'reviewer']);
    assert.equal((await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: 'x' }, headers: { ...auth, 'x-autos-operator': 'bad label!' } })).statusCode, 400);
    for (const payload of [{ instructions: '' }, { instructions: 'x'.repeat(4001) }, { instructions: 'x', roles: ['root'] }, { instructions: 'x', extra: 1 }, {}]) {
      const response = await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload });
      assert.equal(response.statusCode, 400); assert.doesNotMatch(response.body, /ZEBRA/);
    }
    assert.equal((await call(app, 'POST', '/v1/issues/not-a-key/notes', { payload: { instructions: 'x' } })).statusCode, 400);
    assert.equal(f.calls.length, 2);
    const audit = f.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === 'audit');
    assert.equal(audit.length, 2); assert.equal(audit[0]!.action, 'ticket_note_add'); assert.equal(audit[1]!.actor, 'alice@example.com'); assert.equal(audit[0]!.issue_key, 'NEW-5');
    assert.equal(f.logs.join('').includes('ZEBRA'), false);
  } finally { await app.close(); }
});

test('POST notes reports the best-effort Jira lookup and tolerates failures and slow lookups', async () => {
  const lookups: string[] = [];
  const f = setup(async (key) => { lookups.push(key); if (key === 'THROW-1') throw new Error('upstream http://secret'); return key !== 'NEW-404'; });
  const app = await createController(f.options);
  try {
    const found = await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: 'x' } });
    assert.equal(found.json().jira, 'found');
    const missing = await call(app, 'POST', '/v1/issues/NEW-404/notes', { payload: { instructions: 'x' } });
    assert.equal(missing.statusCode, 201); assert.equal(missing.json().jira, 'not_found'); assert.equal(f.notes.get('NEW-404')!.length, 1);
    const failed = await call(app, 'POST', '/v1/issues/THROW-1/notes', { payload: { instructions: 'x' } });
    assert.equal(failed.statusCode, 201); assert.equal(failed.json().jira, 'unchecked'); assert.doesNotMatch(failed.body, /secret/);
    assert.deepEqual(lookups, ['NEW-5', 'NEW-404', 'THROW-1']);
  } finally { await app.close(); }
});

test('POST notes maps wrong project to 400, closed or too many to 409, without leaking the note', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const wrong = await call(app, 'POST', '/v1/issues/BAD-1/notes', { payload: { instructions: SECRET } });
    assert.equal(wrong.statusCode, 400); assert.equal(wrong.json().code, 'INVALID_INPUT'); assert.doesNotMatch(wrong.body, /ZEBRA/);
    const closed = await call(app, 'POST', '/v1/issues/DONE-1/notes', { payload: { instructions: SECRET } });
    assert.equal(closed.statusCode, 409); assert.equal(closed.json().code, 'CONFLICT'); assert.doesNotMatch(closed.body, /ZEBRA/);
    for (let i = 0; i < MAX_TICKET_NOTES; i++) assert.equal((await call(app, 'POST', '/v1/issues/FULL-1/notes', { payload: { instructions: `n${i}` } })).statusCode, 201);
    assert.equal((await call(app, 'POST', '/v1/issues/FULL-1/notes', { payload: { instructions: SECRET } })).statusCode, 409);
    assert.equal(f.logs.join('').includes('ZEBRA'), false);
  } finally { await app.close(); }
});

test('DELETE notes removes one or all, 404 for an unknown id; hold routes set and clear the hold', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    const a = (await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: 'a' } })).json().note_id as string;
    await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: 'b', roles: ['qa'] } });
    const missing = await call(app, 'DELETE', `/v1/issues/NEW-5/notes/${randomUUID()}`);
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'NOT_FOUND');
    assert.equal((await call(app, 'DELETE', '/v1/issues/NEW-5/notes/not-a-uuid')).statusCode, 400);
    const one = await call(app, 'DELETE', `/v1/issues/NEW-5/notes/${a}`); assert.equal(one.statusCode, 200); assert.deepEqual(one.json(), { removed: 1 });
    const all = await call(app, 'DELETE', '/v1/issues/NEW-5/notes'); assert.deepEqual(all.json(), { removed: 1 });
    assert.deepEqual((await call(app, 'DELETE', '/v1/issues/NEW-5/notes')).json(), { removed: 0 });
    const hold = await call(app, 'PUT', '/v1/issues/NEW-6/hold', { headers: { ...auth, 'x-autos-operator': 'bob' } });
    assert.equal(hold.statusCode, 200); assert.deepEqual(hold.json(), { held: true });
    assert.deepEqual(f.calls.filter((c) => c.kind === 'hold')[0]!.args, ['NEW-6', true, 'bob']);
    assert.equal((await call(app, 'PUT', '/v1/issues/NEW-6/hold', { headers: { ...auth, 'x-autos-operator': 'bad label!' } })).statusCode, 400);
    assert.deepEqual((await call(app, 'GET', '/v1/notes')).json().tickets.map((t: TicketNotesSummary) => [t.issue_key, t.held, t.status]), [['NEW-6', true, 'held']]);
    assert.deepEqual((await call(app, 'DELETE', '/v1/issues/NEW-6/hold')).json(), { held: false });
    assert.deepEqual((await call(app, 'GET', '/v1/notes')).json(), { tickets: [] });
    const actions = f.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === 'audit').map((line) => line.action);
    assert.deepEqual(actions.filter((action) => String(action).startsWith('ticket_note')).length, 5);
    assert.ok(actions.includes('ticket_hold') && actions.includes('ticket_release') && actions.includes('ticket_notes_clear') && actions.includes('ticket_note_remove'));
  } finally { await app.close(); }
});

test('GET notes lists summaries, GET issue includes ticket_notes and no longer 404s for notes or a hold alone', async () => {
  const f = setup(); const app = await createController(f.options);
  try {
    // Unknown issue with nothing stored: 404 for the issue view, an empty not_seen summary for the notes view.
    assert.equal((await call(app, 'GET', '/v1/issues/NEW-5')).statusCode, 404);
    const empty = await call(app, 'GET', '/v1/issues/NEW-5/notes'); assert.equal(empty.statusCode, 200); assert.equal(empty.json().status, 'not_seen'); assert.deepEqual(empty.json().notes, []);
    await call(app, 'POST', '/v1/issues/NEW-5/notes', { payload: { instructions: SECRET } });
    const seen = await call(app, 'GET', '/v1/issues/NEW-5');
    assert.equal(seen.statusCode, 200); assert.deepEqual(seen.json().jobs, []); assert.equal(seen.json().ticket_notes.notes[0].instructions, SECRET);
    await call(app, 'PUT', '/v1/issues/NEW-7/hold');
    assert.equal((await call(app, 'GET', '/v1/issues/NEW-7')).statusCode, 200);
    const withJobs = await call(app, 'GET', '/v1/issues/SAMPLE-1');
    assert.equal(withJobs.statusCode, 200); assert.equal(withJobs.json().jobs.length, 1); assert.equal(withJobs.json().ticket_notes.status, 'awaiting_review');
    const list = (await call(app, 'GET', '/v1/notes')).json().tickets as TicketNotesSummary[];
    assert.deepEqual(list.map((t) => t.issue_key), ['NEW-5', 'NEW-7']);
    assert.equal(f.logs.join('').includes('ZEBRA'), false);
    for (const url of ['/v1/events', '/v1/queue', '/v1/jobs']) assert.doesNotMatch((await call(app, 'GET', url)).body, /ZEBRA/);
  } finally { await app.close(); }
});

// ---- CLI ----

async function withCli<T>(run: (ctx: { f: ReturnType<typeof setup>; deps: { cwd: string; env: NodeJS.ProcessEnv; stdout(l: string): void; stderr(l: string): void; now(): number }; out: string[]; err: string[]; configPath: string; dir: string }) => Promise<T>, jiraExists?: (key: string) => Promise<boolean>): Promise<T> {
  const f = setup(jiraExists); const app = await createController(f.options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const dir = await mkdtemp(join(tmpdir(), 'autos-notes-'));
  const out: string[] = []; const err: string[] = [];
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, canonical.replace(/port: 8787/, `port: ${port}`));
    return await run({ f, out, err, configPath, dir, deps: { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, stdout: (l) => out.push(l), stderr: (l) => err.push(l), now: () => Date.parse('2026-11-07T12:00:00.000Z') } });
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}
type Added = { args: [string, OperatorNoteRequest, string] };
const added = (f: ReturnType<typeof setup>) => f.calls.filter((c) => c.kind === 'add').map((c) => (c as unknown as Added).args);

test('autos note shorthands create separate notes with the right roles in command-line order', async () => {
  await withCli(async ({ f, deps, out, configPath }) => {
    assert.equal(await main(['--config', configPath, 'note', 'XYZ-120', '--swe', 'Change only InvoiceService.java', '--qa', 'Verify the PDF totals', '--all', 'Do not touch the public API', '--swe', 'second swe', '--reviewer', 'check naming'], deps), 0);
    assert.deepEqual(added(f).map((a) => [a[0], a[1].instructions, a[1].roles]), [
      ['XYZ-120', 'Change only InvoiceService.java', ['swe']], ['XYZ-120', 'Verify the PDF totals', ['qa']], ['XYZ-120', 'Do not touch the public API', ['swe', 'qa', 'reviewer']],
      ['XYZ-120', 'second swe', ['swe']], ['XYZ-120', 'check naming', ['reviewer']],
    ]);
    assert.equal(out.filter((line) => line.startsWith('Stored note ')).length, 5);
    assert.match(out[0]!, /Stored note [0-9a-f-]{36} for XYZ-120 \(roles: swe\)/); assert.match(out[2]!, /roles: swe, qa, reviewer/);
    assert.ok(out.some((line) => /Jira: not checked/.test(line)));
    assert.doesNotMatch(out.join('\n'), /InvoiceService|ticket-notes-token/);
  });
});

test('autos note --note applies the --roles that precede it; --note-file and --hold work; --roles must precede a note', async () => {
  await withCli(async ({ f, deps, out, err, configPath, dir }) => {
    await writeFile(join(dir, 'n.txt'), 'from file\n');
    const run = (...args: string[]) => main(['--config', configPath, ...args], deps);
    assert.equal(await run('note', 'XYZ-120', '--note', 'plain', '--roles', 'qa,reviewer', '--note', 'two roles', '--note-file', 'n.txt', '--roles', 'swe', '--note', 'back to swe', '--hold'), 0);
    assert.deepEqual(added(f).map((a) => [a[1].instructions, a[1].roles]), [['plain', ['swe']], ['two roles', ['qa', 'reviewer']], ['from file', ['qa', 'reviewer']], ['back to swe', ['swe']]]);
    assert.deepEqual(f.calls.filter((c) => c.kind === 'hold')[0]!.args, ['XYZ-120', true, 'operator']);
    assert.match(out.join('\n'), /XYZ-120 held/);
    assert.equal(await run('note', 'XYZ-121', '--hold'), 0); // hold without notes is allowed
    // --roles without a following note is an error (catches revise-style `--note X --roles qa`)
    const before = f.calls.length; err.length = 0;
    assert.equal(await run('note', 'XYZ-122', '--note', 'x', '--roles', 'qa'), 2); assert.match(err[0]!, /--roles applies to the --note/);
    assert.equal(f.calls.length, before);
  });
});

test('autos note validates arguments locally with exit code 2 and no controller call', async () => {
  await withCli(async ({ f, deps, configPath, dir }) => {
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(4001)); await writeFile(join(dir, 'empty.txt'), ' \n');
    const run = (...args: string[]) => main(['--config', configPath, 'note', ...args], deps);
    const id = randomUUID();
    const bad: string[][] = [
      [], ['not-a-key', '--note', 'x'], ['XYZ-1'], ['XYZ-1', '--note'], ['XYZ-1', '--note', ''], ['XYZ-1', '--note', 'x'.repeat(4001)], ['XYZ-1', '--roles', 'swe,admin', '--note', 'x'], ['XYZ-1', '--roles', 'swe,swe', '--note', 'x'],
      ['XYZ-1', '--note-file', 'big.txt'], ['XYZ-1', '--note-file', 'empty.txt'], ['XYZ-1', '--note-file', 'missing.txt'], ['XYZ-1', '--bogus'],
      ['XYZ-1', '--note', 'x', '--list'], ['XYZ-1', '--note', 'x', '--clear'], ['XYZ-1', '--note', 'x', '--release'], ['XYZ-1', '--note', 'x', '--remove', id],
      ['XYZ-1', '--list', '--clear'], ['XYZ-1', '--remove', id, '--clear'], ['XYZ-1', '--hold', '--release'], ['XYZ-1', '--hold', '--list'], ['XYZ-1', '--release', '--remove', id], ['XYZ-1', '--remove', 'not-a-uuid'],
      ['XYZ-1', ...Array.from({ length: MAX_TICKET_NOTES + 1 }, (_, i) => ['--swe', `n${i}`]).flat()],
    ];
    for (const args of bad) assert.equal(await run(...args), 2, args.join(' ').slice(0, 60));
    assert.equal(f.calls.length, 0);
  });
});

test('autos note manage flags: --list, --remove, --clear, --release', async () => {
  await withCli(async ({ f, deps, out, err, configPath }) => {
    const run = (...args: string[]) => main(['--config', configPath, ...args], deps);
    assert.equal(await run('note', 'XYZ-120', '--swe', 'first line\nsecond line', '--qa', 'qa note', '--hold'), 0);
    const [swe] = f.notes.get('XYZ-120')!;
    out.length = 0;
    assert.equal(await run('note', 'XYZ-120', '--list'), 0);
    const text = out.join('\n');
    assert.match(text, /XYZ-120: held, HELD from automatic discovery/); assert.match(text, /Notes \(2\/5\)/); assert.match(text, /\[swe\] .* by operator/); assert.match(text, /\n {4}first line\n {4}second line/); assert.match(text, /\[qa\]/);
    out.length = 0;
    assert.equal(await run('--json', 'note', 'XYZ-120', '--list'), 0);
    assert.equal(JSON.parse(out.join('\n')).notes.length, 2);
    out.length = 0;
    assert.equal(await run('note', 'XYZ-120', '--remove', swe!.note_id), 0); assert.match(out.join('\n'), /Removed 1 ticket note from XYZ-120/);
    assert.equal(f.notes.get('XYZ-120')!.length, 1);
    err.length = 0; assert.equal(await run('note', 'XYZ-120', '--remove', randomUUID()), 1); assert.match(err[0]!, /NOT_FOUND/);
    out.length = 0; assert.equal(await run('note', 'XYZ-120', '--clear'), 0); assert.match(out.join('\n'), /Removed 1 ticket note/);
    out.length = 0; assert.equal(await run('note', 'XYZ-120', '--release'), 0); assert.match(out.join('\n'), /XYZ-120 released/);
    assert.deepEqual(f.calls.filter((c) => c.kind === 'hold').map((c) => c.args), [['XYZ-120', true, 'operator'], ['XYZ-120', false, 'operator']]);
  });
});

test('autos note warns when Jira does not know the key, still keeps the note, and maps API errors', async () => {
  await withCli(async ({ deps, out, err, configPath, f }) => {
    const run = (...args: string[]) => main(['--config', configPath, ...args], deps);
    assert.equal(await run('note', 'NEW-404', '--swe', 'not yet'), 0);
    assert.match(out.join('\n'), /WARN NEW-404 is not in Jira yet — note kept; check the key for typos/);
    assert.equal(f.notes.get('NEW-404')!.length, 1);
    out.length = 0; assert.equal(await run('note', 'NEW-5', '--swe', 'ok'), 0); assert.match(out.join('\n'), /Jira: NEW-5 found/); assert.doesNotMatch(out.join('\n'), /WARN/);
    out.length = 0; assert.equal(await run('--json', 'note', 'NEW-404', '--qa', 'again'), 0);
    const printed = JSON.parse(out.join('\n')); assert.equal(printed.jira, 'not_found'); assert.deepEqual(printed.notes[0].roles, ['qa']);
    err.length = 0; assert.equal(await run('note', 'BAD-1', '--swe', SECRET), 2); assert.match(err[0]!, /INVALID_INPUT/); assert.doesNotMatch(err.join(''), /ZEBRA/);
    err.length = 0; assert.equal(await run('note', 'DONE-1', '--swe', SECRET), 1); assert.match(err[0]!, /CONFLICT/);
    assert.equal(await main(['--config', configPath, 'note', 'NEW-5', '--swe', 'x'], { ...deps, env: {} }), 1);
    assert.equal(await main(['--config', configPath, 'note', 'NEW-5', '--swe', 'x'], { ...deps, env: { [config.api.operator_token_env]: 'wrong-token-wrong-token' } }), 1);
    assert.match(err.at(-1)!, /AUTH/);
  }, async (key) => key !== 'NEW-404');
});

test('autos notes prints the table and --json; autos notes KEY shows note texts', async () => {
  await withCli(async ({ f, deps, out, configPath }) => {
    const run = (...args: string[]) => main(['--config', configPath, ...args], deps);
    assert.equal(await run('notes'), 0); assert.equal(out.join('\n'), 'No issues with ticket notes, a hold or tier pins.');
    await run('note', 'NEW-9', '--swe', 'a', '--swe', 'b', '--qa', 'c', '--hold');
    await run('note', 'SAMPLE-1', '--all', 'for everyone');
    await run('note', 'ONLYHOLD-1', '--hold');
    out.length = 0;
    assert.equal(await run('notes'), 0);
    const lines = out.join('\n').split('\n');
    assert.match(lines[0]!, /^KEY\s+NOTES\s+HELD\s+TIER\s+STATUS\s+ATTEMPTS\s+LATEST\s+CURRENT NOTES USED$/);
    const row = (key: string) => lines.find((line) => line.startsWith(key))!;
    assert.match(row('NEW-9'), /^NEW-9\s+3 \(swe:2 qa:1\)\s+yes\s+-\s+held\s+0\s+-\s+n\/a$/);
    assert.match(row('SAMPLE-1'), /^SAMPLE-1\s+1 \(swe:1 qa:1 reviewer:1\)\s+no\s+-\s+awaiting review\s+2 \(\+1 dry\)\s+READY_FOR_HUMAN 2h05m ago\s+yes$/);
    assert.match(row('ONLYHOLD-1'), /^ONLYHOLD-1\s+0\s+yes\s+-\s+held\s+0\s+-\s+n\/a$/);
    assert.doesNotMatch(out.join('\n'), /for everyone/);
    out.length = 0; assert.equal(await run('--json', 'notes'), 0);
    assert.deepEqual(JSON.parse(out.join('\n')).tickets.map((t: TicketNotesSummary) => t.issue_key), ['NEW-9', 'ONLYHOLD-1', 'SAMPLE-1']);
    out.length = 0; assert.equal(await run('notes', 'SAMPLE-1'), 0);
    assert.match(out.join('\n'), /SAMPLE-1: awaiting review/); assert.match(out.join('\n'), /for everyone/); assert.match(out.join('\n'), /current notes used: yes/);
    out.length = 0; assert.equal(await run('notes', 'NEVER-1'), 0); assert.match(out.join('\n'), /NEVER-1: not seen/); assert.match(out.join('\n'), /No ticket notes/);
    assert.equal(await run('notes', 'bad key'), 2);
    assert.equal(await run('notes', '--bogus'), 2);
    assert.equal(f.calls.filter((c) => c.kind === 'add').length, 4);
  });
  // "no" when attempts exist but none used the current notes
  const entry: TicketNotesSummary = { issue_key: 'ABC-1', notes: [{ note_id: randomUUID(), issue_key: 'ABC-1', instructions: 'x', roles: ['swe'], author: 'operator', created_at: now }], held: false, status: 'blocked', attempts: 1, dry_runs: 0, latest_job_id: job.job_id, latest_state: 'BLOCKED', last_activity_at: now, attempts_with_current_notes: 0, tier_pins: [] };
  assert.match(formatTicketNotesTable([entry], Date.parse(now) + 90_000)[1]!, /blocked\s+1\s+BLOCKED 1m00s ago\s+no$/);
});

test('autos show includes a Ticket notes section and ticket_notes in --json', async () => {
  await withCli(async ({ deps, out, configPath }) => {
    const run = (...args: string[]) => main(['--config', configPath, ...args], deps);
    await run('note', 'SAMPLE-1', '--qa', 'Verify the PDF totals', '--hold');
    out.length = 0;
    assert.equal(await run('show', 'SAMPLE-1'), 0);
    const text = out.join('\n');
    assert.match(text, /SAMPLE-1 is open/); assert.match(text, /JOB\s+STATE/); assert.match(text, /Ticket notes \(SAMPLE-1\): awaiting review, HELD/); assert.match(text, /\[qa\]/); assert.match(text, /Verify the PDF totals/);
    out.length = 0; assert.equal(await run('--json', 'show', 'SAMPLE-1'), 0);
    assert.equal(JSON.parse(out.join('\n')).ticket_notes.notes[0].instructions, 'Verify the PDF totals');
    out.length = 0; await run('note', 'NEW-3', '--swe', 'only notes');
    out.length = 0; assert.equal(await run('show', 'NEW-3'), 0); assert.match(out.join('\n'), /No attempts\./); assert.match(out.join('\n'), /Ticket notes \(NEW-3\): not seen/);
    out.length = 0; assert.equal(await run('show', 'NEW-4'), 1); // nothing known: still 404 -> NOT_FOUND
  });
});

test('help documents the note commands', async () => {
  const out: string[] = [];
  assert.equal(await main(['--help'], { stdout: (l) => out.push(l) }), 0);
  assert.match(out.join('\n'), /autos notes|notes \[ISSUE-123\]/); assert.match(out.join('\n'), /note ISSUE-123 --note TEXT/);
});
