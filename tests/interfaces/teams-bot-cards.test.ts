import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobRecord } from '@autos/contracts';
import { cardSubmitSchema } from '../../apps/cli/src/teams-bot/types.js';
import { confirmCard, helpCard, jobCard, messageCard, runFormCard, statusCard } from '../../apps/cli/src/teams-bot/cards.js';
import type { AdaptiveCard } from '../../apps/cli/src/teams-bot/types.js';

const id = '11111111-2222-4333-8444-555555555555';
const job = (state: JobRecord['state'], patch: Partial<JobRecord> = {}): JobRecord => ({ job_id: id, issue_key: 'SAMPLE-12', repository_id: null, base_sha: null, state, dry_run: false, repair_round: 1, created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:01:00.000Z', ...patch });
const body = (card: AdaptiveCard): Array<Record<string, any>> => card.body as Array<Record<string, any>>;
const actions = (card: AdaptiveCard): Array<Record<string, any>> => (card.actions as Array<Record<string, any>> | undefined) ?? [];
function submits(value: unknown, found: unknown[] = []): unknown[] {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { for (const item of value) submits(item, found); return found; }
  const record = value as Record<string, unknown>;
  if (record.type === 'Action.Submit') found.push(record.data);
  for (const item of Object.values(record)) submits(item, found);
  return found;
}
function assertCard(card: AdaptiveCard): void {
  assert.equal(card.type, 'AdaptiveCard'); assert.equal(card.version, '1.4'); assert.equal((card.msteams as any).width, 'Full');
  for (const data of submits(card)) assert.equal(cardSubmitSchema.safeParse(data).success, true, JSON.stringify(data));
}

test('help, run form and message builders return Adaptive Card 1.4 and valid submit data', () => {
  const help = helpCard(); const form = runFormCard({ issueKey: 'SAMPLE-12' }); const message = messageCard('Done', ['All good'], 'good');
  for (const card of [help, form, message]) assertCard(card);
  assert.equal(body(form).find((item) => item.id === 'issue')?.value, 'SAMPLE-12');
  assert.deepEqual(body(form).filter((item) => item.type === 'Input.Text').map((item) => item.id), ['issue', 'swe', 'qa', 'reviewer']);
  assert.equal(body(form).find((item) => item.id === 'dry_run')?.valueOff, 'false');
  assert.equal(actions(form)[0]?.data.action, 'run');
});

test('job card provides state-appropriate controls and valid card submit payloads', () => {
  const ready = jobCard(job('READY_FOR_HUMAN', { feature_branch: 'deep/SAMPLE-12', commit_sha: 'abcdef0123456789abcdef0123456789abcdef01', blocked_reason: 'bad' }), { jiraSiteUrl: 'https://example.atlassian.net' });
  assertCard(ready);
  assert.deepEqual(actions(ready).map((item) => item.title), ['Open in Jira', 'Revise', 'Close as merged', 'Close as abandoned']);
  assert.equal(actions(ready)[0]?.url, 'https://example.atlassian.net/browse/SAMPLE-12');
  assert.equal(actions(ready)[1]?.card.actions[0].data.issue, 'SAMPLE-12');
  for (const state of ['BLOCKED', 'CANCELLED'] as const) {
    const card = jobCard(job(state), { jiraSiteUrl: 'https://example.atlassian.net' }); assertCard(card);
    assert.deepEqual(actions(card).map((item) => item.title), ['Open in Jira', 'Retry', 'Revise']);
  }
  for (const state of ['QUEUED', 'IMPLEMENTING', 'PAUSED'] as const) {
    const card = jobCard(job(state), { jiraSiteUrl: 'https://example.atlassian.net' }); assertCard(card);
    assert.deepEqual(actions(card).map((item) => item.title), ['Open in Jira', 'Cancel']);
  }
});

test('job card sanitizes untrusted text and limits displayed commit to 12 chars', () => {
  const card = jobCard(job('BLOCKED', { feature_branch: '[branch](https://evil) *wow* <bad>\u0000', commit_sha: '1234567890123456789012345678901234567890', blocked_reason: '[reason](https://evil) **bold** <x>\u0001' }), { jiraSiteUrl: 'https://example.atlassian.net' });
  const facts = body(card)[1]?.facts as Array<{ title: string; value: string }>;
  const displayed = facts.map(({ value }) => value).join(' ');
  assert.doesNotMatch(displayed, /\[|\]|\*|`|<|>|\u0000|\u0001/);
  assert.match(displayed, /branch\(https:\/\/evil\) wow/); assert.match(displayed, /123456789012/);
  assert.doesNotMatch(displayed, /1234567890123/);
});

test('status card reads known fields defensively, caps active jobs, and handles malformed payloads', () => {
  const jobs = Array.from({ length: 12 }, (_, index) => ({ issue_key: `SAMPLE-${index + 1}`, state: 'IMPLEMENTING' }));
  const card = statusCard({ activity: { counts: { QUEUED: 2, PAUSED: 1, IMPLEMENTING: 3 }, provider_limits: { gate_active: true } }, controller: { poll_loop: { auto_poll: true } }, active_jobs: jobs });
  assertCard(card); assert.match(JSON.stringify(card), /Running/); assert.match(JSON.stringify(card), /Active/);
  assert.match(JSON.stringify(card), /SAMPLE-10/); assert.doesNotMatch(JSON.stringify(card), /SAMPLE-11/);
  assert.match(JSON.stringify(statusCard({ active_jobs: 'malformed' })), /unavailable/);
  assert.match(JSON.stringify(statusCard(null)), /unavailable/);
});

test('only confirmation cards contain confirmed true; No submits status only', () => {
  const cards: AdaptiveCard[] = [helpCard(), runFormCard(), jobCard(job('READY_FOR_HUMAN'), { jiraSiteUrl: 'https://example.atlassian.net' }), statusCard({}), messageCard('x')];
  for (const card of cards) assert.ok(!JSON.stringify(submits(card)).includes('"confirmed":true'));
  const close = confirmCard({ kind: 'close', issueKey: 'SAMPLE-12', resolution: 'merged', confirmed: false }); assertCard(close);
  const cancel = confirmCard({ kind: 'cancel', jobId: id, confirmed: false }); assertCard(cancel);
  for (const card of [close, cancel]) {
    const data = actions(card).map((action) => action.data);
    assert.equal(data[0].confirmed, true); assert.deepEqual(data[1], { autos: 'v1', action: 'status' });
  }
});

