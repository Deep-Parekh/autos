/**
 * First scenario: synthetic end-to-end ticket run, driven through the real controller over loopback HTTP.
 *
 * Uses a fake read-only Jira/Confluence transport, a disposable local Git remote, fake provider executables
 * invoked through the real CLI adapters, and a TEST-ONLY local runner (not an isolation boundary). It contacts
 * no external service, runs no real coding provider, and pushes nothing.
 *
 *   npm run scenario:synthetic            # remove the temporary root afterwards
 *   npm run scenario:synthetic -- --keep  # keep it for inspection
 *   npm run scenario:synthetic -- --watch # also follow /v1/events/stream and snapshot /v1/status mid-run
 */
import { randomBytes } from 'node:crypto';
import { createController, createRuntime } from '@autos/controller';
import { exportDataset } from '@autos/workflow';
import { createSyntheticScenario } from '../tests/fixtures/synthetic/index.js';

const keep = process.argv.includes('--keep');
const watch = process.argv.includes('--watch');
const terminal = new Set(['PLANNED', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLED']);
const token = randomBytes(24).toString('hex');
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

const scenario = await createSyntheticScenario();
const runtime = await createRuntime(scenario.runtimeOptions);
const app = await createController({ ...runtime, operatorToken: token });
let failed = false;
const stream = new AbortController();
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
    return response.json() as Promise<Record<string, any>>;
  };
  let statusShown = false;
  const waitFor = async (jobId: string) => {
    for (let i = 0; i < 600; i++) {
      const job = await api('GET', `/v1/jobs/${jobId}`);
      if (watch && !statusShown && !job.dry_run && ['QA', 'REVIEW'].includes(job.state)) {
        statusShown = true;
        const status = await api('GET', '/v1/status');
        log('status_snapshot', { active: status.activity?.active, stage_elapsed_s: status.stage_elapsed_s, runner: status.runner, counts: status.activity?.counts });
      }
      if (terminal.has(job.state)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Job ${jobId} did not finish`);
  };
  const summarize = (job: Record<string, any>) => ({ issue: job.issue_key, state: job.state, dry_run: job.dry_run, base_sha: job.base_sha, feature_branch: job.feature_branch,
    commit_sha: job.commit_sha, repair_round: job.repair_round, push_status: job.push_status, blocked_code: job.blocked_code, blocked_reason: job.blocked_reason });

  log('controller_listening', { base, health: await (await fetch(`${base}/health`)).json() });
  if (watch) void (async () => {
    try {
      const response = await fetch(`${base}/v1/events/stream`, { headers: { authorization: `Bearer ${token}` }, signal: stream.signal });
      const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split; while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const e = JSON.parse(data.slice(6));
          console.log(`  [stream #${e.event_id}] ${e.at.slice(11, 19)} ${e.issue_key ?? 'service'} ${e.type}${e.state ? ` ${e.state}` : ''}${e.stage ? ` stage=${e.stage}` : ''}${e.role ? ` ${e.role}/${e.provider}` : ''}${e.outcome ? ` ${e.outcome}` : ''}${e.code ? ` code=${e.code}` : ''}${e.repair_round ? ` round=${e.repair_round}` : ''}`);
        }
      }
    } catch { /* stream closed */ }
  })();
  log('projects', { projects: await api('GET', '/v1/projects') });

  const dry = await waitFor((await api('POST', '/v1/jobs', { issue_key: 'SAMPLE-123', dry_run: true })).job_id);
  log('dry_run_finished', summarize(dry));
  const real = await waitFor((await api('POST', '/v1/jobs', { issue_key: 'SAMPLE-123', dry_run: false })).job_id);
  log('run_finished', summarize(real));
  const artifacts = await api('GET', `/v1/jobs/${real.job_id}/artifacts`);
  log('evidence', { files: (artifacts.files ?? []).map((file: { name: string }) => file.name) });

  // Continuous intake: one poll discovers the rest of the filter and drains it one job at a time.
  // Ticket notes added before Autos has seen SAMPLE-124: one for SWE, a different one for QA.
  const sweNote = await api('POST', '/v1/issues/SAMPLE-124/notes', { instructions: 'Synthetic note: keep the change minimal.', roles: ['swe'] });
  await api('POST', '/v1/issues/SAMPLE-124/notes', { instructions: 'Synthetic note: confirm the regression test exists.', roles: ['qa'] });
  const before124 = await api('GET', '/v1/issues/SAMPLE-124/notes');
  log('ticket_notes_added', { status: before124.status, notes: before124.notes.length, jira: sweNote.jira });
  await runtime.workflow.poll(new AbortController().signal);
  const queue = await api('GET', '/v1/queue');
  for (const job of queue.items ?? queue.jobs ?? []) log('queue_item', summarize(job));

  // Operator finishes the ticket after manual review: close as merged removes its workspace (unless --keep), keeps evidence.
  const before = await api('GET', '/v1/workspaces');
  log('workspaces_before', { count: before.workspaces.length, sample_123: before.workspaces.filter((w: { issue_key: string | null }) => w.issue_key === 'SAMPLE-123').map((w: { retained_because: string | null }) => w.retained_because) });
  let closeOk = true;
  if (!keep) {
    const closed = await api('POST', '/v1/issues/SAMPLE-123/close', { resolution: 'MERGED' });
    const after = await api('GET', '/v1/workspaces');
    const issue = await api('GET', '/v1/issues/SAMPLE-123');
    const reviseStatus = (await fetch(`${base}/v1/issues/SAMPLE-123/revisions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ instructions: 'more' }) })).status;
    const evidence = await api('GET', `/v1/jobs/${real.job_id}/artifacts`);
    closeOk = closed.removed.length >= 1 && closed.failed.length === 0 && !after.workspaces.some((w: { issue_key: string | null }) => w.issue_key === 'SAMPLE-123')
      && issue.closure?.resolution === 'MERGED' && reviseStatus === 409 && evidence.files.some((f: { name: string }) => f.name === 'closure.json');
    log('closed_as_merged', { removed: closed.removed.length, workspaces_after: after.workspaces.length, closed_as: issue.jobs[0]?.closed_as, revise_after_close: reviseStatus, evidence_kept: evidence.files.length });
  }

  // Dataset: one record per non-dry-run attempt with every agent call (prompt + full transcript) and the human outcome.
  const records = [];
  for await (const record of exportDataset({ config: runtime.config, options: {} })) records.push(record);
  const sample = records.find((record) => record.job_id === real.job_id);
  const streamLines = (text: string | null) => (text ?? '').split('\n').filter((line) => line.trim().startsWith('{')).length;
  const datasetOk = Boolean(sample) && sample!.outcome === (keep ? 'awaiting_review' : 'merged') && sample!.calls.length >= 3
    && sample!.calls.every((call) => call.call !== null && call.prompt !== null && call.transcript !== null) && sample!.final_diff !== null;
  log('dataset', { records: records.length, outcomes: records.map((record) => `${record.issue_key}:${record.outcome}`), sample_calls: sample?.calls.map((call) => `${call.role}/${call.call?.provider}/${call.call?.status}/${streamLines(call.transcript)} lines`) });
  const notesView = await api('GET', '/v1/notes');
  const t124 = notesView.tickets.find((ticket: { issue_key: string }) => ticket.issue_key === 'SAMPLE-124');
  const r124 = records.find((record) => record.issue_key === 'SAMPLE-124');
  const delivered = (r124?.operator_notes ?? []).filter((note) => note.source === 'ticket').map((note) => note.roles.join('+'));
  const notesOk = before124.status === 'not_seen' && t124?.attempts >= 1 && t124?.attempts_with_current_notes >= 1 && delivered.length === 2;
  log('ticket_notes_delivered', { status: t124?.status, attempts: t124?.attempts, current_notes_used: t124?.attempts_with_current_notes, delivered_roles: delivered });
  closeOk = closeOk && datasetOk && notesOk;

  const refs = (await scenario.remote.git(['for-each-ref', '--format=%(refname)'], scenario.remote.remotePath)).trim();
  log('safety', { atlassian_requests: scenario.fakeAtlassian.requests.length, atlassian_violations: scenario.violations.length, remote_refs: refs.split('\n') });
  failed = dry.state !== 'PLANNED' || real.state !== 'READY_FOR_HUMAN' || scenario.violations.length > 0 || !closeOk;
  log(failed ? 'scenario_failed' : 'scenario_passed', keep ? { root: scenario.root, workspace: scenario.workspaces.get(real.job_id)?.directory } : {});
} catch (error) {
  failed = true;
  log('scenario_error', { message: error instanceof Error ? error.message : String(error) });
} finally {
  await new Promise((r) => setTimeout(r, 200));
  stream.abort();
  await app.close();
  await runtime.close();
  if (!keep) await scenario.cleanup();
}
process.exit(failed ? 1 : 0);
