import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { datasetRecordSchema, parseConfigYaml } from '@autos/contracts';
import { main } from '../../apps/cli/src/index.js';
import { SqliteJobStore } from '../../packages/workflow/src/index.js';

const canonical = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'autos-export-'));
  const config = { ...canonical, storage: { data_dir: join(dir, 'data'), artifacts_dir: join(dir, 'artifacts'), workspaces_dir: join(dir, 'workspaces') } };
  const path = join(dir, 'autos.yaml'); await writeFile(path, stringify(config));
  new SqliteJobStore(join(dir, 'data', 'autos.sqlite')).close();
  const db = new DatabaseSync(join(dir, 'data', 'autos.sqlite'));
  const rows: Array<[number, string, string]> = [[1, 'SAMPLE-1', 'READY_FOR_HUMAN'], [2, 'SAMPLE-2', 'BLOCKED'], [3, 'SAMPLE-2', 'CANCELLED']];
  for (const [id, key, state] of rows) {
    const at = `2026-11-0${id}T10:00:00.000Z`;
    db.prepare('INSERT INTO jobs(job_id,issue_key,state,dry_run,repair_round,created_at,updated_at) VALUES(?,?,?,0,0,?,?)').run(uuid(id), key, state, at, at);
  }
  db.close();
  const dir1 = join(dir, 'artifacts', uuid(1), '_private', 'swe', uuid(9));
  await mkdir(join(dir1, 'input'), { recursive: true }); await mkdir(join(dir1, 'output'), { recursive: true });
  await writeFile(join(dir1, 'input', 'prompt.md'), 'PROMPT'); await writeFile(join(dir1, 'output', 'transcript.jsonl'), 'TRANSCRIPT');
  const run = async (args: string[], extra: { cwd?: string } = {}) => {
    const out: string[] = []; const err: string[] = [];
    const code = await main(['--config', path, ...args], { cwd: extra.cwd ?? dir, stdout: (l) => out.push(l), stderr: (l) => err.push(l), env: {} });
    return { code, out, err };
  };
  return { dir, run, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('export dataset writes validated JSON lines to stdout and a summary to stderr', async () => {
  const f = await fixture();
  try {
    const { code, out, err } = await f.run(['export', 'dataset']);
    assert.equal(code, 0); assert.equal(out.length, 3);
    const records = out.map((line) => datasetRecordSchema.parse(JSON.parse(line)));
    assert.deepEqual(records.map((r) => r.outcome), ['awaiting_review', 'blocked', 'cancelled']);
    assert.equal(records[0]!.calls[0]!.prompt, 'PROMPT'); assert.equal(records[0]!.calls[0]!.transcript, 'TRANSCRIPT');
    assert.equal(err.length, 1); assert.match(err[0]!, /Exported 3 records \(awaiting_review=1 blocked=1 cancelled=1\), 1 provider call, \d+ bytes/);
    assert.equal(out.join('').includes('\n'), false);
  } finally { await f.cleanup(); }
});

test('filters and include flags are passed through', async () => {
  const f = await fixture();
  try {
    const filtered = await f.run(['export', 'dataset', '--issue', 'SAMPLE-2', '--outcome', 'cancelled,blocked', '--since', '2026-11-03']);
    assert.equal(filtered.code, 0); assert.deepEqual(filtered.out.map((l) => JSON.parse(l).outcome), ['cancelled']);
    const lean = await f.run(['export', 'dataset', '--issue', 'SAMPLE-1', '--no-prompts', '--no-transcripts']);
    const call = JSON.parse(lean.out[0]!).calls[0]; assert.equal(call.prompt, null); assert.equal(call.transcript, null);
    const none = await f.run(['export', 'dataset', '--outcome', 'merged']);
    assert.equal(none.code, 0); assert.deepEqual(none.out, []); assert.match(none.err[0]!, /Exported 0 records/);
  } finally { await f.cleanup(); }
});

test('--out creates a new 0600 file, writes nothing to stdout and refuses to overwrite', async () => {
  const f = await fixture();
  try {
    const first = await f.run(['export', 'dataset', '--out', 'dataset.jsonl']);
    assert.equal(first.code, 0); assert.deepEqual(first.out, []); assert.match(first.err[0]!, /to dataset\.jsonl/);
    const file = join(f.dir, 'dataset.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const lines = (await readFile(file, 'utf8')).split('\n'); assert.equal(lines.length, 4); assert.equal(lines[3], ''); lines.slice(0, 3).forEach((l) => datasetRecordSchema.parse(JSON.parse(l)));
    const before = await readFile(file, 'utf8');
    const second = await f.run(['export', 'dataset', '--out', 'dataset.jsonl']);
    assert.equal(second.code, 1); assert.match(second.err.join(''), /does not overwrite/); assert.equal(await readFile(file, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('invalid export flags exit with code 2 and export nothing', async () => {
  const f = await fixture();
  try {
    for (const args of [['export'], ['export', 'other'], ['export', 'dataset', '--bogus'], ['export', 'dataset', '--outcome', 'merged,nope'], ['export', 'dataset', '--outcome', ''], ['export', 'dataset', '--since', 'yesterday'],
      ['export', 'dataset', '--issue', 'lower-1'], ['export', 'dataset', '--out'], ['export', 'dataset', '--no-prompts', '--no-prompts'], ['export', 'dataset', 'extra']]) {
      const result = await f.run(args);
      assert.equal(result.code, 2, args.join(' ')); assert.deepEqual(result.out, []); assert.match(result.err.join(''), /INVALID_INPUT/);
    }
    assert.equal((await f.run(['export', 'dataset', '--out', 'x.jsonl', '--since', 'bad'])).code, 2);
    await assert.rejects(() => stat(join(f.dir, 'x.jsonl'))); // flag errors never leave a file behind
  } finally { await f.cleanup(); }
});

test('help lists the dataset export', async () => {
  const out: string[] = []; await main(['--help'], { stdout: (l) => out.push(l), stderr: () => undefined });
  assert.match(out[0]!, /export dataset/); assert.match(out[0]!, /--no-transcripts/);
});
