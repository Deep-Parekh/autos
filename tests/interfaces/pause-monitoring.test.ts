// CLI rendering of paused attempts (status, watch/events lines, show) and the API job serializer.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobRecord } from '@autos/contracts';
import { formatEvent, formatIssue, formatStatus } from '../../apps/cli/src/index.js';
import { safeJob } from '../../apps/controller/src/index.js';
import { emptyActivity, makeEvent } from './monitor-fake.js';

const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('watch/events lines for job_paused and job_resumed carry role, code, resume time and round', () => {
  assert.equal(formatEvent(makeEvent(3, { type: 'job_paused', role: 'qa', provider: undefined, code: 'RATE_LIMIT', resume_at: '2026-11-07T13:15:00.000Z', count: 2, repair_round: 1, stage: undefined })),
    '12:01:03 SAMPLE-1 paused: every QA provider limited (RATE_LIMIT) resumes 2026-11-07 13:15Z pause 2 (round 1)');
  assert.equal(formatEvent(makeEvent(4, { type: 'job_resumed', role: 'swe', provider: undefined, code: 'RATE_LIMIT', repair_round: 0 })), '12:01:04 SAMPLE-1 resumed swe at its primary provider after RATE_LIMIT (round 0)');
});

test('status lists paused attempts with their resume time and holds no slot', () => {
  const text = formatStatus({
    controller: { version: '0.1.0', started_at: '2026-11-07T12:00:00.000Z', uptime_s: 60, poll_interval_s: 60, poll_loop: { running: true, next_poll_at: null, consecutive_failures: 0, auto_poll: false, last_discovery_at: null } },
    runner: { status: 'ready', version: 1, docker: 'available' },
    activity: { ...emptyActivity, paused_jobs: [{ job_id: JOB, issue_key: 'SAMPLE-1', repair_round: 0, role: 'swe', code: 'RATE_LIMIT', resume_at: '2026-11-07T12:30:00.000Z', paused_since: '2026-11-07T12:00:00.000Z', pause_count: 1 }] },
    active_jobs: [],
  } as never, Date.parse('2026-11-07T12:10:00.000Z'));
  assert.match(text, /Active: idle/);
  assert.match(text, /Paused: SAMPLE-1 swe RATE_LIMIT round 0 pause 1  resumes 2026-11-07T12:30:00.000Z \(in 20m00s\)  \(no slot held\)/);
});

test('show explains a paused attempt; the API exposes pause fields only while PAUSED', () => {
  const paused: JobRecord = { job_id: JOB, issue_key: 'SAMPLE-1', repository_id: 'example/sample-app', base_sha: 'b'.repeat(40), state: 'PAUSED', dry_run: false, repair_round: 1, created_at: '2026-11-07T12:00:00.000Z', updated_at: '2026-11-07T12:05:00.000Z',
    resume_at: '2026-11-07T12:20:00.000Z', pause_code: 'RATE_LIMIT', paused_role: 'reviewer', paused_since: '2026-11-07T12:05:00.000Z', pause_count: 1 };
  assert.match(formatIssue({ issue_key: 'SAMPLE-1', closure: null, jobs: [paused] }), /Paused cccccccc-cccc-4ccc-8ccc-cccccccccccc: every reviewer provider limited \(RATE_LIMIT\); resumes at 2026-11-07T12:20:00.000Z/);
  const api = safeJob(paused);
  assert.equal(api.resume_at, paused.resume_at); assert.equal(api.paused_role, 'reviewer'); assert.equal(api.pause_count, 1);
  const finished = safeJob({ ...paused, state: 'CANCELLED' });
  assert.equal(finished.resume_at, undefined); assert.equal(finished.pause_code, undefined);
});

test('status and watch show the provider limit gate', () => {
  const text = formatStatus({
    controller: { version: '0.1.0', started_at: '2026-11-07T12:00:00.000Z', uptime_s: 60, poll_interval_s: 60, poll_loop: { running: true, next_poll_at: null, consecutive_failures: 0, auto_poll: false, last_discovery_at: null } },
    runner: { status: 'ready', version: 1, docker: 'available' },
    activity: { ...emptyActivity, provider_limits: { providers: [{ provider: 'codex', until: '2026-11-07T12:30:00.000Z' }, { provider: 'claude', until: '2026-11-07T13:00:00.000Z' }], gate_active: true, gate_until: '2026-11-07T12:30:00.000Z' } },
    active_jobs: [],
  } as never, Date.parse('2026-11-07T12:10:00.000Z'));
  assert.match(text, /Provider limits: codex until 2026-11-07T12:30:00.000Z, claude until 2026-11-07T13:00:00.000Z; new tickets wait until 2026-11-07T12:30:00.000Z/);
  assert.equal(formatEvent(makeEvent(5, { type: 'provider_gate_opened', job_id: null, issue_key: null, role: undefined, provider: undefined, stage: undefined, repair_round: undefined, resume_at: '2026-11-07T12:30:00.000Z' })), '12:01:05 service provider limit gate opened: new tickets wait until 2026-11-07 12:30Z');
  assert.equal(formatEvent(makeEvent(6, { type: 'provider_gate_closed', job_id: null, issue_key: null })), '12:01:06 service provider limit gate lifted: new tickets may start');
});
