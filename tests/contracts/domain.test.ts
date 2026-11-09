import test from 'node:test';
import assert from 'node:assert/strict';
import { branchNameSchema, canTransition, isTerminalState, issueKeySchema, relativePathSchema, providerRequestSchema, providerResultSchema } from '@autos/contracts';

test('paths and branch names reject traversal and Git argument/ref injection', () => {
  for (const path of ['../x', '/tmp/x', 'a/../../x', '.git/config', 'a/.GIT/config', 'C:/x', 'src\\x', 'src/./x']) assert.equal(relativePathSchema.safeParse(path).success, false, path);
  for (const branch of ['-x', '../main', 'a..b', 'a@{b', 'a.lock', 'a b', 'a\\b', 'a//b']) assert.equal(branchNameSchema.safeParse(branch).success, false, branch);
  assert.equal(relativePathSchema.safeParse('src/main/App.java').success, true);
  assert.equal(branchNameSchema.safeParse('deep/SAMPLE-123').success, true);
  assert.equal(issueKeySchema.safeParse('SAMPLE-123').success, true);
  assert.equal(issueKeySchema.safeParse('SAMPLE-123;echo').success, false);
});
test('dry-run and terminal states cannot become a successful fix or silently retry', () => {
  assert.equal(canTransition('INVESTIGATING', 'PLANNED'), true);
  assert.equal(canTransition('PLANNED', 'READY_FOR_HUMAN'), false);
  assert.equal(canTransition('QUEUED', 'READY_FOR_HUMAN'), false);
  assert.equal(canTransition('BLOCKED', 'IMPLEMENTING'), false);
  assert.equal(canTransition('CANCELLING', 'CANCELLED'), true);
  assert.equal(isTerminalState('READY_FOR_HUMAN'), true);
});
test('read-only roles and provider completion records are validated', () => {
  const request = { job_id: '432c5a6a-043a-4ad6-894c-5330ea7d06bc', issue_key: 'SAMPLE-123', provider: 'codex', role: 'qa', cwd: '/tmp/fixture', prompt_path: '/tmp/prompt', transcript_path: '/tmp/transcript', timeout_ms: 1000, source_access: 'read', auth_profile: 'fixture' };
  assert.equal(providerRequestSchema.safeParse(request).success, true);
  assert.equal(providerRequestSchema.safeParse({ ...request, source_access: 'write' }).success, false);
  assert.equal(providerRequestSchema.safeParse({ ...request, model: '--resume' }).success, false);
  assert.equal(providerRequestSchema.safeParse({ ...request, prompt_path: 'relative/prompt.md' }).success, false);
  assert.equal(providerResultSchema.safeParse({ provider: 'codex', role: 'qa', status: 'SUCCEEDED', exit_code: 1, elapsed_ms: 1, transcript_path: '/tmp/transcript', result: {} }).success, false);
});
