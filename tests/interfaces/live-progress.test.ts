import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfigYaml, type JobEvent } from '@autos/contracts';
import { main, formatEvent } from '../../apps/cli/src/index.js';
import { emptyActivity, makeEvent } from './monitor-fake.js';

const canonical = await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
const TOKEN = 'live-progress-token-0123456789';
const WEBHOOK = 'https://prod-01.westus.logic.azure.com/workflows/x?sig=secret';
const JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const configYaml = (notify?: string) => `${canonical}\nnotifications:\n  teams:\n    webhook_url_env: AUTOS_TEAMS_WEBHOOK_URL\n${notify ? `    notify: [${notify}]\n` : ''}`;
const activeJob = { job_id: JOB_ID, issue_key: 'SAMPLE-1', state: 'IMPLEMENTATION' as const, dry_run: false, repair_round: 0, stage: 'implementation' as const, stage_started_at: '2026-11-07T12:00:00.000Z', role: 'swe' as const, provider: 'claude' as const, started_at: '2026-11-07T12:00:00.000Z' };

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('condition not met'); await new Promise((r) => setTimeout(r, 10)); }
}
function progress(id: number, message: string): JobEvent {
  return makeEvent(id, { type: 'role_progress', message, count: id, at: `2026-11-07T12:00:${String(id).padStart(2, '0')}.000Z` });
}
const config = parseConfigYaml(configYaml());
const statusBody = { controller: { version: '0.1.0', started_at: '2026-11-07T12:00:00.000Z', uptime_s: 60, poll_interval_s: 60, poll_loop: { running: true, next_poll_at: null, consecutive_failures: 0, auto_poll: false, last_discovery_at: null } }, runner: { status: 'unknown' }, activity: { ...emptyActivity, active_jobs: [activeJob], active: activeJob, last_event_id: 0 }, active_jobs: [{ ...activeJob, active_elapsed_s: 60, stage_elapsed_s: 60 }] };
const fakeApi = (streams: JobEvent[][] = []) => async (url: URL) => {
  if (url.pathname === '/v1/status') return Response.json(statusBody);
  if (url.pathname.endsWith('/events') && !url.pathname.endsWith('/stream')) {
    const event = progress(1, 'edited src/main.ts'); return Response.json({ events: [event], next_after: event.event_id });
  }
  if (url.pathname.endsWith('/stream')) {
    const batch = streams.shift() ?? [];
    const data = batch.map((e) => `id: ${e.event_id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
  }
  return Response.json({ code: 'NOT_FOUND', message: 'missing' }, { status: 404 });
};

test('role_progress watch line includes issue, role/provider and the workflow message (which carries any count); quiet flag hides only progress', async () => {
  const event = progress(2, 'ran rg -n assocType');
  assert.equal(formatEvent(event), '12:00:02 SAMPLE-1 swe/claude: ran rg -n assocType');
  for (const quiet of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'autos-live-watch-'));
    const stop = new AbortController(); const output: string[] = [];
    try {
      const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, configYaml());
      const start = makeEvent(1); const args = ['--config', configPath, 'watch', '--url', 'http://controller', ...(quiet ? ['--quiet-progress'] : [])];
      const done = main(args, { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, signal: stop.signal, stdout: (line) => { output.push(line); if (output.length >= (quiet ? 1 : 2)) stop.abort(); }, stderr: () => undefined, controllerFetch: fakeApi([[start, event]]) });
      await until(() => output.length >= (quiet ? 1 : 2)); await done;
      assert.equal(output.some((line) => line.includes('ran rg -n')), !quiet);
      assert.ok(output.some((line) => line.includes('role_started')), 'ordinary events remain visible');
    } finally { stop.abort(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('status reads persisted events and displays the latest action age under the active job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autos-live-status-'));
  try {
    const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, configYaml());
    const output: string[] = [];
    assert.equal(await main(['--config', configPath, 'status', '--url', 'http://controller'], { cwd: dir, env: { [config.api.operator_token_env]: TOKEN }, now: () => Date.parse('2026-11-07T12:01:01Z'), stdout: (line) => output.push(line), stderr: () => undefined, controllerFetch: fakeApi() }), 0);
    assert.match(output.join('\n'), /Last action: edited src\/main\.ts \(1m00s ago\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Teams AGENT_PROGRESS is opt-in and rate limited to one card per job per ten minutes', async () => {
  for (const enabled of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'autos-live-teams-'));
    const stop = new AbortController(); const posted: unknown[] = []; let now = Date.parse('2026-11-07T12:00:00Z');
    try {
      const configPath = join(dir, 'autos.yaml'); await writeFile(configPath, configYaml(enabled ? 'AGENT_PROGRESS' : undefined));
      const batches = [[makeEvent(1, { type: 'role_started', at: '2026-11-07T12:00:00.000Z' }), progress(2, 'ran npm test'), progress(3, 'edited src/main.ts')], [progress(4, 'ran npm run typecheck')]];
      const done = main(['--config', configPath, 'teams', 'relay', '--url', 'http://controller'], { cwd: dir, env: { [config.api.operator_token_env]: TOKEN, AUTOS_TEAMS_WEBHOOK_URL: WEBHOOK }, signal: stop.signal, now: () => now, stdout: () => undefined, stderr: () => undefined, reconnectDelayMs: 100, controllerFetch: fakeApi(batches), teamsFetch: async (_url, init) => { posted.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); } });
      const progressCards = () => posted.filter((card) => JSON.stringify(card).includes('Latest action'));
      if (enabled) await until(() => progressCards().length === 1);
      await new Promise((r) => setTimeout(r, 20));
      now += 10 * 60_000;
      if (enabled) await until(() => progressCards().length === 2);
      else await new Promise((r) => setTimeout(r, 30));
      assert.equal(progressCards().length, enabled ? 2 : 0);
      if (enabled) {
        const payload = JSON.stringify(progressCards()[0]);
        assert.match(payload, /SAMPLE-1/); assert.match(payload, /swe\/claude/); assert.match(payload, /ran npm test/); assert.match(payload, /running 2s/);
        assert.doesNotMatch(JSON.stringify(progressCards()[1]), /edited src\/main\.ts/);
        assert.match(JSON.stringify(progressCards()[1]), /ran npm run typecheck/);
      }
      stop.abort(); assert.equal(await done, 0);
    } finally { stop.abort(); await rm(dir, { recursive: true, force: true }); }
  }
});
