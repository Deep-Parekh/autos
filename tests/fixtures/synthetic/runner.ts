/**
 * LOCAL FIXTURE RUNNER -- TEST ONLY, NOT AN ISOLATION BOUNDARY.
 *
 * This RunnerPort implementation runs roles by invoking the real CliProviderAdapter against FAKE provider
 * executables as ordinary host subprocesses, and runs configured check argv in a scratch copy of the workspace on
 * the host. It provides NO container, user, filesystem, network, or credential isolation. The only read-only
 * enforcement for QA/reviewer is after-the-fact detection: the working tree is digested before and after the role
 * and the invocation fails closed (POLICY) if it changed. Production job execution must use the trusted Docker
 * runner (packages/runner); this module must never be imported from product code or wired to a real provider.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createProviderAdapters, type CliProviderAdapter } from '@autos/cli-adapters';
import { checksSchema, type CheckCommand, type Checks, type GitWorkspace, type Provider, type ProviderRequest, type ProviderResult, type RunnerPort } from '@autos/contracts';

export interface LocalFixtureRunnerOptions {
  /** Absolute fake executable per provider (the real adapter spawns these with argv arrays, no shell). */
  binaries: Record<Provider, string>;
  /** Directory used as HOME for fake providers; the fake writes invocations.jsonl there. Outside every workspace. */
  providerHome: string;
  /** Scratch parent for check copies. Defaults to the OS temp directory. */
  scratchRoot?: string;
  /** Optional deterministic delay (ms) held inside each role / check call so concurrent jobs measurably overlap. */
  roleDelayMs?: number;
  checkDelayMs?: number;
  /** Extra non-secret PATH entries so `#!/usr/bin/env node` fakes and javac/java resolve. Defaults to process PATH. */
  path?: string;
}

export interface RoleInvocationRecord { job_id: string; issue_key: string; provider: Provider; role: ProviderRequest['role']; source_access: ProviderRequest['source_access']; status: ProviderResult['status'] }
export interface LocalFixtureRunner extends RunnerPort {
  readonly roleInvocations: RoleInvocationRecord[];
  readonly checkRuns: Array<{ job_id: string; candidate_digest: string; commands: number }>;
  readonly stopped: string[];
  /** Highest number of simultaneous runRole calls observed (should be 1 under the single-active-job rule). */
  readonly peak: { roles: number; checks: number };
}

/** SHA-256 over every non-.git file's path, mode, and content (symlinks by target) plus .git/HEAD and .git/config. */
export async function workspaceDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === '.git') continue;
      const full = join(directory, rel);
      const info = await lstat(full);
      if (info.isSymbolicLink()) hash.update(`L ${rel} ${await readlink(full)}\n`);
      else if (info.isDirectory()) { hash.update(`D ${rel}\n`); await walk(rel); }
      else hash.update(`F ${rel} ${info.mode & 0o777} ${createHash('sha256').update(await readFile(full)).digest('hex')}\n`);
    }
  }
  await walk('');
  for (const meta of ['HEAD', 'config']) hash.update(`G ${meta} ${await readFile(join(directory, '.git', meta), 'utf8').catch(() => '')}\n`);
  return hash.digest('hex');
}

function runArgv(command: CheckCommand, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    let output = ''; let timedOut = false; let settled = false;
    const child = spawn(command.executable, command.args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, command.timeout_ms);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunk: Buffer) => { if (output.length < 12_000) output += chunk.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolvePromise({ code, timedOut, output: output.slice(0, 2_000) }); };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

export function createLocalFixtureRunner(options: LocalFixtureRunnerOptions): LocalFixtureRunner {
  const path = options.path ?? process.env.PATH ?? '/usr/bin:/bin';
  const adapters: Record<Provider, CliProviderAdapter> = createProviderAdapters({
    binaries: options.binaries,
    baseEnv: { PATH: `${dirname(process.execPath)}:${path}` },
    resolveAuth: () => ({ HOME: options.providerHome }),
  });
  const active = new Map<string, Set<AbortController>>();
  const roleInvocations: RoleInvocationRecord[] = [];
  const checkRuns: LocalFixtureRunner['checkRuns'] = [];
  const stopped: string[] = [];
  const peak = { roles: 0, checks: 0 };
  let running = 0;
  let runningChecks = 0;
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolvePromise) => { if (ms <= 0 || signal?.aborted) return resolvePromise(); const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', done); clearTimeout(timer); resolvePromise(); } signal?.addEventListener('abort', done, { once: true }); });

  return {
    roleInvocations, checkRuns, stopped, peak,
    async runRole(request, signal) {
      const controller = new AbortController();
      const set = active.get(request.job_id) ?? new Set<AbortController>(); set.add(controller); active.set(request.job_id, set);
      running += 1; peak.roles = Math.max(peak.roles, running);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        const readOnly = request.role !== 'swe';
        if (readOnly && request.source_access !== 'read') throw new Error('Read-only roles must request read access');
        if (!readOnly && request.source_access !== 'write') throw new Error('SWE must request write access');
        await sleep(options.roleDelayMs ?? 0, combined);
        const before = readOnly ? await workspaceDigest(request.cwd) : undefined;
        const result = await adapters[request.provider].run(request, combined);
        roleInvocations.push({ job_id: request.job_id, issue_key: request.issue_key, provider: request.provider, role: request.role, source_access: request.source_access, status: result.status });
        if (before !== undefined && (await workspaceDigest(request.cwd)) !== before) {
          // Fail closed: a read-only role changed the source tree or Git metadata.
          return { provider: request.provider, role: request.role, status: 'FAILED', exit_code: result.exit_code, elapsed_ms: result.elapsed_ms, transcript_path: request.transcript_path, result: null, error_code: 'POLICY', ...(request.model ? { model: request.model } : {}) };
        }
        return result;
      } finally { running -= 1; set.delete(controller); if (!set.size) active.delete(request.job_id); }
    },
    async runChecks(workspace: GitWorkspace, candidateDigest: string, commands: CheckCommand[], signal?: AbortSignal): Promise<Checks> {
      runningChecks += 1; peak.checks = Math.max(peak.checks, runningChecks);
      checkRuns.push({ job_id: workspace.job_id, candidate_digest: candidateDigest, commands: commands.length });
      const scratch = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'autos-local-checks-'));
      const records: Checks['checks'] = [];
      try {
        await sleep(options.checkDelayMs ?? 0, signal);
        // Copy without .git so checks cannot touch repository metadata; configured executables run on the host.
        await cp(workspace.directory, scratch, { recursive: true, filter: (source) => !source.split('/').includes('.git') });
        const env = { PATH: `${dirname(process.execPath)}:${path}`, HOME: scratch, LANG: 'C', TMPDIR: scratch };
        for (const [index, command] of commands.entries()) {
          const name = `${basename(command.executable)} ${command.args.join(' ')}`.trim() || `check-${index + 1}`;
          const argv = [command.executable, ...command.args];
          if (signal?.aborted) { records.push({ name, command: argv, status: 'NOT_RUN', exit_code: null, timed_out: false, required: command.required, report_paths: [] }); continue; }
          const outcome = await runArgv(command, scratch, env, signal);
          const pass = outcome.code === 0 && !outcome.timedOut && !signal?.aborted;
          records.push({ name, command: argv, status: pass ? 'PASS' : 'FAIL', exit_code: outcome.code, timed_out: outcome.timedOut, required: command.required, report_paths: [], output_excerpt: outcome.output });
        }
        return checksSchema.parse({ schema_version: 1, candidate_digest: candidateDigest, recorded_at: new Date().toISOString(), checks: records });
      } finally { runningChecks -= 1; await rm(scratch, { recursive: true, force: true }); }
    },
    async stop(jobId) { stopped.push(jobId); for (const controller of active.get(jobId) ?? []) controller.abort(); },
  };
}

