import assert from 'node:assert/strict';
import test from 'node:test';
import { extractIssueKey, parseCardSubmit, parseCommandText } from '../../apps/cli/src/teams-bot/commands.js';
import type { ParseContext } from '../../apps/cli/src/teams-bot/types.js';

const ctx: ParseContext = { allowedProjects: ['SAMPLE', 'OPS'], jiraSiteUrl: 'https://example.atlassian.net', maxNoteChars: 120 };
const JOB = '123e4567-e89b-12d3-a456-426614174000';
const good = (text: string) => {
  const result = parseCommandText(text, ctx);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('expected command');
  return result.command;
};

test('extracts issue keys and only accepts browse links on the configured Jira host and projects', () => {
  assert.equal(extractIssueKey('sample-12', ctx), 'SAMPLE-12');
  assert.equal(extractIssueKey('https://example.atlassian.net/browse/OPS-9?focusedCommentId=1', ctx), 'OPS-9');
  assert.equal(extractIssueKey('https://evil.example/browse/SAMPLE-1', ctx), null);
  assert.equal(extractIssueKey('https://example.atlassian.net/browse/OTHER-1', ctx), null);
  assert.equal(extractIssueKey('SAMPLE-0', ctx), null);
  assert.equal(extractIssueKey('https://user:pass@example.atlassian.net/browse/SAMPLE-1', ctx), null);
  assert.equal(good('show https://example.atlassian.net/browse/sample-12?x=1').kind, 'show');
});

test('parses every text command and enforces typed destructive confirmations', () => {
  assert.deepEqual(good('help'), { kind: 'help' });
  assert.deepEqual(good('run'), { kind: 'run_form' });
  assert.deepEqual(good('run SAMPLE-1 --dry-run investigate\nsecond line'), { kind: 'run', issueKey: 'SAMPLE-1', dryRun: true, notes: { swe: 'investigate\nsecond line' } });
  assert.deepEqual(good('run SAMPLE-2 dry run'), { kind: 'run', issueKey: 'SAMPLE-2', dryRun: true, notes: {} });
  assert.deepEqual(good('run SAMPLE-2 qa: test it\nreviewer: check the plan'), { kind: 'run', issueKey: 'SAMPLE-2', dryRun: false, notes: { qa: 'test it', reviewer: 'check the plan' } });
  assert.deepEqual(good('status'), { kind: 'status' });
  assert.deepEqual(good('show SAMPLE-3'), { kind: 'show', issueKey: 'SAMPLE-3' });
  assert.deepEqual(good('release SAMPLE-4'), { kind: 'release', issueKey: 'SAMPLE-4' });
  assert.deepEqual(good(`retry ${JOB}`), { kind: 'retry', jobId: JOB });
  assert.deepEqual(good(`cancel ${JOB}`), { kind: 'cancel', jobId: JOB, confirmed: false });
  assert.deepEqual(good('close SAMPLE-5 merged'), { kind: 'close', issueKey: 'SAMPLE-5', resolution: 'merged', confirmed: false });
  assert.deepEqual(good('close SAMPLE-5 abandoned'), { kind: 'close', issueKey: 'SAMPLE-5', resolution: 'abandoned', confirmed: false });
});

test('role prefixes route note lines, hold is recognized, and revise roles are parsed', () => {
  assert.deepEqual(good('note SAMPLE-1 swe: fix the bug\nqa: check the edge\nreviewer: inspect API\nall: shared note hold'), {
    kind: 'note', issueKey: 'SAMPLE-1', hold: true,
    notes: { swe: 'fix the bug\nshared note', qa: 'check the edge\nshared note', reviewer: 'inspect API\nshared note' },
  });
  assert.deepEqual(good('note SAMPLE-2 plain text'), { kind: 'note', issueKey: 'SAMPLE-2', notes: { swe: 'plain text' }, hold: false });
  assert.deepEqual(good('revise SAMPLE-3 roles swe,qa Please update the tests'), { kind: 'revise', issueKey: 'SAMPLE-3', roles: ['swe', 'qa'], note: 'Please update the tests' });
  assert.deepEqual(good('revise SAMPLE-3 simplify this'), { kind: 'revise', issueKey: 'SAMPLE-3', roles: ['swe'], note: 'simplify this' });
});

test('cleans mentions, HTML, entities and controls while preserving note line breaks', () => {
  assert.deepEqual(good('<at>Autos</at> run SAMPLE-1 &lt;fix&gt; &amp; test'), { kind: 'run', issueKey: 'SAMPLE-1', dryRun: false, notes: { swe: '<fix> & test' } });
  assert.deepEqual(good('note SAMPLE-1 swe: first\nqa: second\u0001 line'), { kind: 'note', issueKey: 'SAMPLE-1', notes: { swe: 'first', qa: 'second line' }, hold: false });
});

test('refuses invalid grammar, job IDs, projects, roles and overlong notes with short sanitized messages', () => {
  for (const text of ['show https://foreign.invalid/browse/SAMPLE-1', 'show OTHER-1', 'cancel nope', 'close SAMPLE-1', 'revise SAMPLE-1 roles admin nope', 'run SAMPLE-1 ' + 'x'.repeat(121)]) {
    const result = parseCommandText(text, ctx);
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.ok(result.message.length < 100);
  }
  const hostile = parseCommandText('wat <b>' + 'x'.repeat(200) + '</b>', ctx);
  assert.equal(hostile.ok, false);
  if (!hostile.ok) assert.ok(hostile.message.length < 100);
});

test('card submits require Autos v1 and map validated fields to commands', () => {
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'run', issue: 'SAMPLE-7', swe: 'implement', qa: 'test', reviewer: 'review', dry_run: 'true' }, ctx), {
    ok: true, command: { kind: 'run', issueKey: 'SAMPLE-7', dryRun: true, notes: { swe: 'implement', qa: 'test', reviewer: 'review' } },
  });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'run_form', issue: 'OPS-8' }, ctx), { ok: true, command: { kind: 'run_form', issueKey: 'OPS-8' } });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'revise', issue: 'SAMPLE-9', note: 'update tests' }, ctx), { ok: true, command: { kind: 'revise', issueKey: 'SAMPLE-9', note: 'update tests', roles: ['swe'] } });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'cancel', job_id: JOB, confirmed: true }, ctx), { ok: true, command: { kind: 'cancel', jobId: JOB, confirmed: true } });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'close', issue: 'SAMPLE-9', resolution: 'abandoned', confirmed: true }, ctx), { ok: true, command: { kind: 'close', issueKey: 'SAMPLE-9', resolution: 'abandoned', confirmed: true } });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'retry', job_id: JOB }, ctx), { ok: true, command: { kind: 'retry', jobId: JOB } });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'show', issue: 'SAMPLE-9' }, ctx), { ok: true, command: { kind: 'show', issueKey: 'SAMPLE-9' } });
  assert.deepEqual(parseCardSubmit({ autos: 'v1', action: 'status' }, ctx), { ok: true, command: { kind: 'status' } });
  assert.equal(parseCardSubmit({ autos: 'other', action: 'status' }, ctx).ok, false);
  assert.equal(parseCardSubmit({ autos: 'v1', action: 'run', issue: 'SAMPLE-1', swe: 'x'.repeat(121) }, ctx).ok, false);
});
