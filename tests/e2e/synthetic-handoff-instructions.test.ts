// Repository instructions and SWE handoff end to end: real adapters over fake provider executables, real GitRunner,
// real workflow, controller HTTP. The fakes log what they observed in their own prompt/workspace.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createController, createRuntime } from '@autos/controller';
import { createSyntheticScenario, NESTED_RULE, ROOT_RULE, regressionTestPath, taskServicePath, type SyntheticScenarioOptions } from '../fixtures/synthetic/index.js';

const token = 'synthetic-operator-token-0123456789';
const auth = { authorization: `Bearer ${token}` };
const terminal = new Set(['PLANNED', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED']);
type Job = { job_id: string; state: string; blocked_code?: string; commit_sha?: string; base_sha?: string | null };
type Attempt = { role: string; provider: string; error_code: string | null; fell_back: boolean; continued_from_handoff?: boolean; handoff_captured?: boolean };

async function run(options: SyntheticScenarioOptions) {
  const scenario = await createSyntheticScenario(options);
  const runtime = await createRuntime(scenario.runtimeOptions);
  const app = await createController({ ...runtime, operatorToken: token });
  try {
    const queued = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { issue_key: 'SAMPLE-123', dry_run: false } });
    assert.equal(queued.statusCode, 202, queued.body);
    const id = (queued.json() as Job).job_id;
    let job: Job;
    for (const deadline = Date.now() + 120_000; ; await new Promise((r) => setTimeout(r, 100))) {
      job = (await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: auth })).json() as Job;
      if (terminal.has(job.state)) break;
      assert.ok(Date.now() < deadline, `stuck in ${job.state}`);
    }
    const jobDirectory = join(runtime.config.storage.artifacts_dir, id);
    const rounds = JSON.parse(await readFile(join(jobDirectory, 'rounds.json'), 'utf8').catch(() => '{"rounds":[]}')) as { rounds: Array<{ provider_attempts?: Attempt[] }> };
    const manifest = (await app.inject({ method: 'GET', url: `/v1/jobs/${id}/artifacts`, headers: auth })).json() as { files: Array<{ name: string }> };
    return { scenario, job, jobDirectory, attempts: rounds.rounds.flatMap((round) => round.provider_attempts ?? []), manifest, invocations: await scenario.providerInvocations(), workspace: scenario.workspaces.get(id)!.directory };
  } finally { await app.close(); await runtime.close(); }
}

test('(a) rate-limited claude hands its partial work to codex, which only completes the pending items', { timeout: 300_000 }, async () => {
  const r = await run({ roleChains: { swe: { provider: 'claude', fallbacks: ['codex'] } }, providerBehavior: { claude: { swe: 'partial_then_rate_limit' } } });
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    const swe = r.invocations.filter((entry) => entry.role === 'swe');
    assert.deepEqual(swe.map((entry) => [entry.provider, entry.saw_handoff_section]), [['claude', false], ['claude', true], ['claude', true], ['codex', true]], 'retries and the next provider receive the handoff section');
    assert.deepEqual((await r.scenario.sweActions()).map((a) => [a.provider, a.action]), [['claude', 'partial'], ['claude', 'partial'], ['claude', 'partial'], ['codex', 'completed_pending']], 'codex only added the pending regression test');
    assert.equal((await r.scenario.sweActions()).at(-1)?.handoff_checklist_seen, true);
    // Commit has exactly the two files and never the handoff directory.
    const git = (args: string[]) => r.scenario.remote.git(args, r.workspace);
    assert.deepEqual((await git(['diff-tree', '--no-commit-id', '--name-only', '-r', r.job.commit_sha!])).split('\n').sort(), [taskServicePath, regressionTestPath].sort());
    assert.ok(!(await git(['ls-tree', '-r', '--name-only', r.job.commit_sha!])).includes('.autos-handoff'));
    // Evidence flags.
    const sweAttempts = r.attempts.filter((a) => a.role === 'swe');
    assert.equal(sweAttempts[0]?.handoff_captured, true);
    assert.equal(sweAttempts.at(-1)?.continued_from_handoff, true);
    assert.deepEqual(sweAttempts.map((a) => [a.provider, a.error_code]), [['claude', 'RATE_LIMIT'], ['codex', null]]);
    // QA/reviewer never see the handoff directory; it is gone after the job; the checklist is kept privately only.
    for (const entry of r.invocations.filter((e) => e.role !== 'swe')) assert.equal(entry.handoff_dir_present, false, `${entry.role} workspace start`);
    assert.ok(!existsSync(join(r.workspace, '.autos-handoff')));
    const privateFiles = await readdir(join(r.jobDirectory, '_private', 'swe'), { recursive: true });
    assert.ok(privateFiles.some((name) => name.endsWith('handoff.md')), 'private handoff.md exists');
    assert.ok(!r.manifest.files.some((file) => /handoff/i.test(file.name)), 'handoff is not a public artifact');
  } finally { await r.scenario.cleanup(); }
});

test('(b) every provider prompt carries the committed root rule; nested rule reaches QA and reviewer', { timeout: 300_000 }, async () => {
  const r = await run({});
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    assert.deepEqual(r.invocations.map((entry) => `${entry.role}:${entry.provider}`), ['swe:claude', 'qa:codex', 'reviewer:cursor']);
    for (const entry of r.invocations) assert.equal(entry.saw_root_rule, true, `${entry.provider} (${entry.role}) saw ${ROOT_RULE}`);
    for (const entry of r.invocations.filter((e) => e.role !== 'swe')) assert.equal(entry.saw_nested_rule, true, `${entry.role} saw ${NESTED_RULE}`);
  } finally { await r.scenario.cleanup(); }
});

test('(c) a SWE that edits an instruction file is blocked as FORBIDDEN while prompts carried the committed rule text', { timeout: 300_000 }, async () => {
  const r = await run({ providerBehavior: { claude: { swe: 'edit_agents_md' } } });
  try {
    assert.equal(r.job.state, 'BLOCKED', JSON.stringify(r.job));
    assert.equal(r.job.blocked_code, 'FORBIDDEN');
    // The workflow gives a path-policy violation bounded repair rounds; the fake SWE repeats the edit, so the job still blocks before QA or review.
    assert.ok(r.invocations.length >= 2 && r.invocations.every((entry) => entry.role === 'swe'), `only SWE repair rounds ran; QA and review never ran: ${r.invocations.map((entry) => entry.role).join()}`);
    assert.equal(r.invocations[0]?.saw_root_rule, true);
    assert.equal(await r.scenario.remote.git(['rev-parse', 'HEAD'], r.workspace), r.job.base_sha, 'nothing was committed');
    assert.ok((await readFile(join(r.workspace, 'AGENTS.md'), 'utf8')).includes('RULE-TAMPERED'), 'the tampered working-tree file was not used as a rule source');
    assert.ok(!(await r.scenario.remote.git(['show', `${r.job.base_sha}:AGENTS.md`], r.workspace)).includes('RULE-TAMPERED'));
  } finally { await r.scenario.cleanup(); }
});

test('(d) effective-instructions.md lists the committed blob shas', { timeout: 300_000 }, async () => {
  const r = await run({});
  try {
    assert.equal(r.job.state, 'READY_FOR_HUMAN', JSON.stringify(r.job));
    const text = await readFile(join(r.jobDirectory, 'effective-instructions.md'), 'utf8');
    for (const path of ['AGENTS.md', 'src/main/java/example/tasks/AGENTS.md']) {
      const blob = await r.scenario.remote.git(['rev-parse', `${r.job.base_sha}:${path}`], r.workspace);
      assert.ok(text.includes(`## ${path} (blob ${blob})`), `${path} blob ${blob} listed`);
    }
    assert.ok(text.includes(ROOT_RULE) && text.includes(NESTED_RULE));
  } finally { await r.scenario.cleanup(); }
});
