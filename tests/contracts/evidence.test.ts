import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFinalization } from '@autos/contracts';

const digest = 'a'.repeat(64);
function packet() {
  return {
    checks: { schema_version: 1, candidate_digest: digest, recorded_at: '2026-11-08T06:00:00Z', checks: [{ name: 'regression', command: ['mvn', 'test'], status: 'PASS', exit_code: 0, timed_out: false, required: true, report_paths: ['target/test-report.xml'] }] },
    qa: { schema_version: 1, candidate_digest: digest, status: 'PASS', evidence: ['Regression behavior and acceptance criteria checked'] },
    review: { schema_version: 1, candidate_digest: digest, status: 'PASS', findings: [] as object[] },
  };
}
test('valid current evidence permits finalization', () => {
  const p = packet(); assert.deepEqual(evaluateFinalization(digest, p.checks, p.qa, p.review), { ready: true, reasons: [] });
});
test('changed content invalidates all prior evidence', () => {
  const p = packet();
  assert.deepEqual(evaluateFinalization('b'.repeat(64), p.checks, p.qa, p.review).reasons, ['STALE_CHECKS', 'STALE_QA', 'STALE_REVIEW']);
});
test('missing, not-run, timed-out and contradictory evidence cannot pass', () => {
  const p = packet();
  assert.equal(evaluateFinalization(digest, 'tests passed', p.qa, p.review).ready, false);
  assert.equal(evaluateFinalization(digest, p.checks, { ...p.qa, status: 'NOT_RUN' }, p.review).ready, false);
  assert.equal(evaluateFinalization(digest, { ...p.checks, checks: [{ ...p.checks.checks[0], timed_out: true }] }, p.qa, p.review).ready, false);
  assert.equal(evaluateFinalization(digest, { ...p.checks, checks: [{ ...p.checks.checks[0], exit_code: 1 }] }, p.qa, p.review).ready, false);
  assert.equal(evaluateFinalization(digest, { ...p.checks, checks: [{ ...p.checks.checks[0], required: false }] }, p.qa, p.review).ready, false);
  assert.equal(evaluateFinalization(digest, p.checks, p.qa, { ...p.review, findings: [{ severity: 'BLOCKER', file: 'src/App.java', line: 1, issue: 'Regression', suggested_fix: 'Preserve behavior' }] }).ready, false);
});
