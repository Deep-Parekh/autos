import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { AutosError, ERROR_CODES, TOOLCHAIN_MOUNTS, branchNameSchema, checkCommandSchema, checksSchema, digestSchema, gitShaSchema, installedToolchainsSchema, issueKeySchema, jdkVersionSchema, jobIdSchema, parseProgressLine, progressUpdateSchema, providerRequestSchema, providerResultSchema, toolchainSelectionSchema, tomcatVersionSchema } from '@autos/contracts';
import type { CheckCommand, Checks, GitWorkspace, InstalledToolchains, ProgressUpdate, ProviderAuthSummary, ProviderRequest, ProviderResult, RunChecksOptions, RunnerHealth, RunnerPort, ToolchainSelection } from '@autos/contracts';
import { CODEX_AUTH_FILE, CODEX_STAGED_CONFIG, readCodexAuthFile, validateCodexAuthDirectory, validateCodexAuthJson, validateProviderAuthProfile } from './auth.js';
import type { ProviderAuthProfile } from './auth.js';

export * from './auth.js';

export interface DockerProcessOptions { timeoutMs: number; maxOutputBytes?: number; killGraceMs?: number; onStderrLine?: (line: string) => void }
export interface DockerProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputLimit: boolean }
export interface DockerExecutor {
  run(binary: string, args: string[], options: DockerProcessOptions, signal?: AbortSignal): Promise<DockerProcessResult>;
}
export interface DockerRunnerOptions {
  /** Images are built and reviewed by the operator. They must provide the fixed entrypoint contract documented in docker/README.md. */
  workerImage: string;
  checksImage: string;
  dockerBinary?: string;
  workspaceRoot: string;
  promptRoot: string;
  outputRoot: string;
  authRoot?: string;
  dependencyCacheRoot?: string;
  /**
   * Operator-installed JDK/Tomcat toolchains (`<root>/jdk/<major>`, `<root>/tomcat/<version>`), mounted read-only into role and
   * check containers on request. Must be disjoint from the workspace, output, authentication and dependency cache roots.
   */
  toolchainRoot?: string;
  authProfiles?: (profile: string, provider: ProviderRequest['provider']) => Promise<ProviderAuthProfile>;
  /** Explicitly approved outbound provider network. Defaults to Docker's isolated `none` network. */
  providerNetwork?: { name: string; approved: true };
  /** Bind owner identity; must be a non-root host UID/GID with access to the selected job workspace. */
  uid?: number;
  gid?: number;
  executor?: DockerExecutor;
  /** Parent for short-lived provider env-file directories (default: the OS temp dir). Keep it private to the supervisor user. */
  envRoot?: string;
  /**
   * Resource limits. `memory`/`cpus` apply to role containers; `checkMemory`/`checkCpus` apply to check containers
   * (default: more memory, because builds are heavier than a CLI worker). Sizes use Docker syntax such as `256m` or `2g`.
   */
  limits?: Partial<{ memory: string; cpus: string; checkMemory: string; checkCpus: string; pids: number; maxOutputBytes: number; killGraceMs: number; tmpSize: string; homeSize: string; maxPromptBytes: number; maxTranscriptBytes: number }>;
  /**
   * Parent for per-run private Codex auth staging directories (default: `envRoot`, else the OS temp dir). Must be private to the
   * supervisor user and disjoint from workspace, output, prompt and cache roots (each staging directory is checked per run).
   */
  authStagingRoot?: string;
  /** Configured profiles for health reporting (profile, provider, mode only). */
  authSummary?: ProviderAuthSummary[];
  /** Refuse every profile whose mode is not subscription (AUTOS_REQUIRE_SUBSCRIPTION), per run and in health. */
  requireSubscription?: boolean;
  /** Set only by tests that never launch a real Docker process. */
  testOnly?: true;
}

const safeImage = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const envName = /^[A-Z][A-Z0-9_]{0,127}$/;
const envValue = /^[^\0\r\n]{0,8192}$/;
const defaultLimits = { memory: '2g', cpus: '2', checkMemory: '4g', checkCpus: '2', pids: 256, maxOutputBytes: 2_000_000, killGraceMs: 750, tmpSize: '128m', homeSize: '256m', maxPromptBytes: 262_144, maxTranscriptBytes: 5_242_880 } as const;
const sizePattern = /^[1-9][0-9]{0,5}(m|g)$/;
const INFRA_EXIT_CODES: readonly (number | null)[] = [125, 126, 127];
const OOM_EXIT_CODE = 137;
const OOM_EXCERPT = 'killed (exit 137): likely out of memory; raise AUTOS_CHECK_MEMORY';
const ROLE_OOM_REASON = 'worker killed (exit 137): likely out of memory; raise AUTOS_ROLE_MEMORY';
const INFRA_REASON = 'container runtime could not start the worker (docker daemon, image or executable problem)';

/** Docker itself failed (125 daemon/flags, 126 not executable, 127 not found) or the docker binary could not be spawned. */
function isInfrastructureFailure(result: DockerProcessResult): boolean {
  if (result.timedOut || result.cancelled || result.outputLimit) return false;
  return INFRA_EXIT_CODES.includes(result.code) || (result.code === null && result.stdout === '');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonical(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new AutosError('INVALID_INPUT', 'Runner paths must be absolute');
  try { return await realpath(path); } catch { throw new AutosError('INVALID_INPUT', 'Runner path is unavailable'); }
}

async function contained(root: string, path: string, label: string): Promise<string> {
  const [base, target] = await Promise.all([canonical(root), canonical(path)]);
  if (!isInside(base, target)) throw new AutosError('POLICY', `${label} must be inside its configured directory`);
  return target;
}

async function assertDisjoint(first: string, second: string, label: string): Promise<void> {
  const [a, b] = await Promise.all([canonical(first), canonical(second)]);
  if (isInside(a, b) || isInside(b, a)) throw new AutosError('POLICY', `${label} must be outside job data`);
}

function mount(path: string, target: string, mode: 'ro' | 'rw'): string[] {
  if (/[\0-\x1f\x7f,]/.test(path)) throw new AutosError('POLICY', 'Filesystem mount path contains unsupported characters');
  // Docker's --mount has no `rw` field: read-write is the default and read-only is spelled `readonly`.
  return ['--mount', `type=bind,src=${path},dst=${target}${mode === 'ro' ? ',readonly' : ''}`];
}

/** PATH of the Debian-based worker and checks images; toolchain PATHs prepend to it so image tools keep working. */
const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const MAVEN_BIN = '/opt/maven/bin';
const JAVA_VERSION_PATTERN = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;

interface ResolvedToolchain { jdkDir: string; tomcatDir?: string; javaVersion?: string }

function releaseValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(?:"([^"\\r\\n]*)"|([^\\s"]*))\\s*$`, 'm').exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** A real directory (not a symlink) inside `parent`; returns its canonical path or undefined. */
async function realDirectoryInside(parent: string, name: string): Promise<string | undefined> {
  const path = join(parent, name);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    const real = await realpath(path);
    return real !== parent && isInside(parent, real) ? real : undefined;
  } catch { return undefined; }
}

async function regularFileInside(directory: string, relativePath: string): Promise<string | undefined> {
  try {
    const real = await realpath(join(directory, relativePath));
    if (!isInside(directory, real) || !(await stat(real)).isFile()) return undefined;
    return real;
  } catch { return undefined; }
}

/** Validates a JDK directory; returns its release JAVA_VERSION (possibly unsuitable for evidence) or undefined when invalid. */
async function inspectJdk(jdkParent: string, major: string): Promise<{ dir: string; javaVersion: string } | undefined> {
  if (!jdkVersionSchema.safeParse(major).success) return undefined;
  const dir = await realDirectoryInside(jdkParent, major);
  if (!dir || !(await regularFileInside(dir, 'bin/java'))) return undefined;
  const release = await regularFileInside(dir, 'release');
  if (!release) return undefined;
  try {
    if ((await stat(release)).size > 65_536) return undefined;
    const text = await readFile(release, 'utf8');
    const version = releaseValue(text, 'JAVA_VERSION');
    if (!version || version.split(/[.+_-]/)[0] !== major || releaseValue(text, 'OS_NAME') !== 'Linux') return undefined;
    return { dir, javaVersion: version };
  } catch { return undefined; }
}

async function inspectTomcat(tomcatParent: string, version: string): Promise<string | undefined> {
  if (!tomcatVersionSchema.safeParse(version).success) return undefined;
  const dir = await realDirectoryInside(tomcatParent, version);
  if (!dir) return undefined;
  for (const required of ['bin/catalina.sh', 'lib/catalina.jar', 'conf/server.xml']) if (!(await regularFileInside(dir, required))) return undefined;
  return dir;
}

async function toolchainParents(root: string): Promise<{ jdk: string | undefined; tomcat: string | undefined }> {
  const base = await canonical(root);
  return { jdk: await realDirectoryInside(base, 'jdk'), tomcat: await realDirectoryInside(base, 'tomcat') };
}

/** Lists the validated toolchains installed under `root` (names only, sorted). Invalid, symlinked or foreign-OS entries are ignored. */
export async function listInstalledToolchains(root: string): Promise<InstalledToolchains> {
  const parents = await toolchainParents(root).catch(() => ({ jdk: undefined, tomcat: undefined }));
  const jdk: string[] = [];
  const tomcat: string[] = [];
  const jdkParent = parents.jdk;
  const tomcatParent = parents.tomcat;
  if (jdkParent) for (const name of await readdir(jdkParent).catch(() => [] as string[])) if (await inspectJdk(jdkParent, name)) jdk.push(name);
  if (tomcatParent) for (const name of await readdir(tomcatParent).catch(() => [] as string[])) if (await inspectTomcat(tomcatParent, name)) tomcat.push(name);
  jdk.sort((x, y) => Number(x) - Number(y));
  tomcat.sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  return installedToolchainsSchema.parse({ jdk, tomcat });
}

/** Resolves a selection to canonical host paths. Anything missing or invalid is a non-retryable configuration error. */
async function resolveToolchain(root: string | undefined, untrusted: unknown): Promise<ResolvedToolchain> {
  const parsed = toolchainSelectionSchema.safeParse(untrusted);
  if (!parsed.success) throw new AutosError('INVALID_INPUT', 'Toolchain selection is invalid');
  const selection: ToolchainSelection = parsed.data;
  const missing = (what: string) => new AutosError('INVALID_CONFIG', `Required toolchain is not installed on the runner: ${what}`, { retryable: false });
  if (!root) throw missing(`JDK ${selection.jdk}`);
  const parents = await toolchainParents(root).catch(() => ({ jdk: undefined, tomcat: undefined }));
  const jdk = parents.jdk ? await inspectJdk(parents.jdk, selection.jdk) : undefined;
  if (!jdk) throw missing(`JDK ${selection.jdk}`);
  let tomcatDir: string | undefined;
  if (selection.tomcat) {
    tomcatDir = parents.tomcat ? await inspectTomcat(parents.tomcat, selection.tomcat) : undefined;
    if (!tomcatDir) throw missing(`Tomcat ${selection.tomcat}`);
  }
  return { jdkDir: jdk.dir, ...(tomcatDir ? { tomcatDir } : {}), ...(JAVA_VERSION_PATTERN.test(jdk.javaVersion) ? { javaVersion: jdk.javaVersion } : {}) };
}

function toolchainMounts(resolved: ResolvedToolchain): string[] {
  return [...mount(resolved.jdkDir, TOOLCHAIN_MOUNTS.jdk, 'ro'), ...(resolved.tomcatDir ? mount(resolved.tomcatDir, TOOLCHAIN_MOUNTS.tomcat, 'ro') : [])];
}

function envArgs(values: [string, string][]): string[] {
  return values.flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

function containerName(jobId: string, role: string): string {
  return `autos-${jobId.toLowerCase()}-${role}-${randomUUID().slice(0, 8)}`;
}

export const defaultDockerExecutor: DockerExecutor = {
  run(binary, args, options, signal) {
    return new Promise((resolvePromise) => {
      let child: ReturnType<typeof spawn>;
      let stdout = '';
      let stderr = '';
      let stderrPending = '';
      const stderrDecoder = new StringDecoder('utf8');
      let bytes = 0;
      let timedOut = false;
      let cancelled = false;
      let outputExceeded = false;
      let finished = false;
      let stopping = false;
      let timer: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const outputLimit = options.maxOutputBytes ?? defaultLimits.maxOutputBytes;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise({ code, stdout, stderr, timedOut, cancelled, outputLimit: outputExceeded });
      };
      const signalGroup = (target: NodeJS.Signals) => {
        if (!child?.pid) return;
        try { process.kill(-child.pid, target); } catch { try { child.kill(target); } catch { /* exited */ } }
      };
      const cleanupGroup = async () => {
        if (!child?.pid || process.platform === 'win32') return;
        try { process.kill(-child.pid, 0); } catch { return; }
        signalGroup('SIGTERM');
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        try { process.kill(-child.pid, 0); signalGroup('SIGKILL'); } catch { /* no group remains */ }
      };
      const stop = (kind: 'timeout' | 'cancel' | 'output') => {
        if (stopping) return;
        stopping = true;
        if (kind === 'timeout') timedOut = true;
        else if (kind === 'cancel') cancelled = true;
        else outputExceeded = true;
        signalGroup('SIGTERM');
        escalation = setTimeout(() => signalGroup('SIGKILL'), options.killGraceMs ?? defaultLimits.killGraceMs);
        escalation.unref();
      };
      const onAbort = () => stop('cancel');
      if (signal?.aborted) { cancelled = true; finish(null); return; }
      try {
        child = spawn(binary, args, { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch { finish(null); return; }
      timer = setTimeout(() => stop('timeout'), options.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
        const text = target === 'stderr' ? stderrDecoder.write(chunk) : chunk.toString('utf8');
        if (target === 'stdout') {
          bytes += chunk.byteLength;
          if (bytes > outputLimit) { stop('output'); return; }
          stdout += text; return;
        }
        stderrPending += text;
        let newline: number;
        while ((newline = stderrPending.indexOf('\n')) >= 0) {
          const rawLine = stderrPending.slice(0, newline);
          const line = rawLine.replace(/\r$/, '');
          stderrPending = stderrPending.slice(newline + 1);
          try { options.onStderrLine?.(line); } catch { /* progress listeners are best effort */ }
          if (parseProgressLine(line) === null) {
            bytes += Buffer.byteLength(rawLine, 'utf8') + 1;
            if (bytes > outputLimit) { stop('output'); return; }
            stderr += `${rawLine}\n`;
          }
        }
      };
      child.stdout?.on('data', collect('stdout'));
      child.stderr?.on('data', collect('stderr'));
      child.on('error', () => { stderr += stderrPending; stderrPending = ''; finish(null); });
      child.on('close', (code) => {
        if (stderrPending) {
          const decodedTail = stderrDecoder.end();
          stderrPending += decodedTail;
          const line = stderrPending.replace(/\r$/, '');
          try { options.onStderrLine?.(line); } catch { /* progress listeners are best effort */ }
          if (parseProgressLine(line) === null) {
            bytes += Buffer.byteLength(stderrPending, 'utf8');
            if (bytes > outputLimit) stop('output');
            else stderr += stderrPending;
          }
          stderrPending = '';
        }
        if (escalation) clearTimeout(escalation); void cleanupGroup().finally(() => finish(code));
      });
      if (signal?.aborted) onAbort();
    });
  },
};

function validateOptions(options: DockerRunnerOptions): void {
  if (!safeImage.test(options.workerImage) || !safeImage.test(options.checksImage)) throw new AutosError('INVALID_CONFIG', 'Runner images must use valid image references');
  const limits = { ...defaultLimits, ...options.limits };
  const cpuValid = (value: string) => /^[0-9]+(?:\.[0-9]+)?$/.test(value) && Number(value) > 0 && Number(value) <= 256;
  if (![limits.memory, limits.checkMemory, limits.tmpSize, limits.homeSize].every((value) => sizePattern.test(value)) || !cpuValid(limits.cpus) || !cpuValid(limits.checkCpus) || !Number.isInteger(limits.maxPromptBytes) || limits.maxPromptBytes < 1024 || limits.maxPromptBytes > 1_000_000 || !Number.isInteger(limits.maxTranscriptBytes) || limits.maxTranscriptBytes < 65_536 || limits.maxTranscriptBytes > 52_428_800 || !Number.isInteger(limits.pids) || limits.pids < 16 || limits.pids > 4096 || !Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1024 || !Number.isInteger(limits.killGraceMs) || limits.killGraceMs < 50) {
    throw new AutosError('INVALID_CONFIG', 'Runner resource limits are invalid');
  }
  if (options.testOnly && options.executor === undefined) throw new AutosError('INVALID_CONFIG', 'Test-only runner mode requires an injected executor');
  if (options.executor !== undefined && !options.testOnly) throw new AutosError('INVALID_CONFIG', 'Injected executors are available only through the explicit test-only mode');
  if (options.providerNetwork && (!options.providerNetwork.approved || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(options.providerNetwork.name) || ['host', 'container'].includes(options.providerNetwork.name))) throw new AutosError('POLICY', 'Provider egress network is not explicitly approved');
  if (!Number.isInteger(options.uid ?? 10001) || (options.uid ?? 10001) <= 0 || !Number.isInteger(options.gid ?? 10001) || (options.gid ?? 10001) <= 0) throw new AutosError('INVALID_CONFIG', 'Runner user must be a non-root UID and GID');
}

function validateEnvironment(provider: ProviderRequest['provider'], values: Record<string, string> = {}): string {
  const allowed: Record<ProviderRequest['provider'], ReadonlySet<string>> = {
    claude: new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
    codex: new Set(['OPENAI_API_KEY']),
    cursor: new Set(['CURSOR_API_KEY']),
  };
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!allowed[provider].has(key) || !envName.test(key) || !envValue.test(value)) throw new AutosError('AUTH', 'Provider authentication profile is invalid');
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n');
}

function parseCheckOutput(stdout: string): { exit_code: number | null; timed_out: boolean; output_excerpt: string } | undefined {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!(record.exit_code === null || (typeof record.exit_code === 'number' && Number.isInteger(record.exit_code))) || typeof record.timed_out !== 'boolean' || typeof record.output_excerpt !== 'string' || record.output_excerpt.length > 12_000) return undefined;
    return { exit_code: record.exit_code, timed_out: record.timed_out, output_excerpt: record.output_excerpt };
  } catch { return undefined; }
}

const authLocks = new Map<string, Promise<void>>();

/** In-process FIFO lock keyed by canonical profile directory; waiting honours the abort signal. */
async function acquireAuthLock(key: string, signal?: AbortSignal): Promise<() => void> {
  const previous = authLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.then(() => mine);
  authLocks.set(key, tail);
  void tail.then(() => { if (authLocks.get(key) === tail) authLocks.delete(key); });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      if (signal?.aborted) { reject(new AutosError('CANCELLED', 'Runner operation was cancelled')); return; }
      const onAbort = () => reject(new AutosError('CANCELLED', 'Runner operation was cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      void previous.then(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); });
    });
  } catch (error) { release(); throw error; }
  return release;
}

export class DockerRunner implements RunnerPort {
  private readonly options: DockerRunnerOptions;
  private readonly executor: DockerExecutor;
  private readonly active = new Map<string, Set<string>>();
  private readonly limits;

  constructor(options: DockerRunnerOptions) {
    validateOptions(options);
    assertRunnerPaths(options);
    assertToolchainRootDisjointLexically(options);
    this.options = options;
    this.executor = options.executor ?? defaultDockerExecutor;
    this.limits = { ...defaultLimits, ...options.limits };
  }

  async runRole(untrustedRequest: ProviderRequest, signal?: AbortSignal, onProgress?: (update: ProgressUpdate) => void): Promise<ProviderResult> {
    const request = providerRequestSchema.parse(untrustedRequest);
    if ((request.role === 'swe' && request.source_access !== 'write') || (request.role !== 'swe' && request.source_access !== 'read')) throw new AutosError('POLICY', 'Runner role and source permissions do not match');
    const [workspaceRoot, promptRoot, outputRoot, cwd, prompt] = await Promise.all([
      canonical(this.options.workspaceRoot), canonical(this.options.promptRoot), canonical(this.options.outputRoot), canonical(request.cwd), canonical(request.prompt_path),
    ]);
    if (promptRoot !== outputRoot || isInside(workspaceRoot, outputRoot) || isInside(outputRoot, workspaceRoot)) throw new AutosError('POLICY', 'Workspace and private artifact roots must be canonical and disjoint');
    if (this.options.authRoot) await Promise.all([assertDisjoint(workspaceRoot, this.options.authRoot, 'Authentication directory'), assertDisjoint(outputRoot, this.options.authRoot, 'Authentication directory')]);
    if (request.toolchain || this.options.toolchainRoot) await this.assertToolchainRootDisjoint(workspaceRoot, outputRoot);
    if (!isInside(workspaceRoot, cwd) || !isInside(promptRoot, prompt) || isInside(workspaceRoot, prompt) || isInside(workspaceRoot, resolve(request.transcript_path))) throw new AutosError('POLICY', 'Provider paths violate the configured workspace boundary');
    const outputDir = await contained(outputRoot, dirname(request.transcript_path), 'Transcript output');
    if (resolve(request.transcript_path) !== resolve(outputDir, 'transcript.jsonl')) throw new AutosError('POLICY', 'Provider transcript must use the private transcript filename');
    const invocationRoot = resolve(outputRoot, request.job_id, '_private', request.role);
    const outputParts = relative(invocationRoot, outputDir).split(sep);
    const invocationId = outputParts.length === 2 && outputParts[1] === 'output' ? outputParts[0] ?? '' : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId) || outputDir !== resolve(invocationRoot, invocationId, 'output')) throw new AutosError('POLICY', 'Provider output must use its private invocation directory');
    const expectedPrompt = resolve(invocationRoot, invocationId, 'input', 'prompt.md');
    if (prompt !== expectedPrompt) throw new AutosError('POLICY', 'Provider prompt must use its private invocation directory');
    const gitDir = await canonical(resolve(cwd, '.git')).catch(() => { throw new AutosError('POLICY', 'Git metadata must be present and protected'); });
    if (!isInside(cwd, gitDir)) throw new AutosError('POLICY', 'Git metadata must remain inside the workspace');
    const promptInfo = await stat(prompt);
    if (!promptInfo.isFile() || promptInfo.size > 1_000_000) throw new AutosError('INVALID_INPUT', 'Provider prompt is not a bounded regular file');
    if (signal?.aborted) return { provider: request.provider, role: request.role, status: 'CANCELLED', exit_code: null, elapsed_ms: 0, transcript_path: request.transcript_path, result: null, error_code: 'CANCELLED', ...(request.model ? { model: request.model } : {}) };
    // Resolve before any container work: an uninstalled toolchain must fail without starting anything.
    const toolchain = request.toolchain ? await resolveToolchain(this.options.toolchainRoot, request.toolchain) : undefined;
    let rawProfile: unknown;
    try { rawProfile = await this.options.authProfiles?.(request.auth_profile, request.provider); } catch { throw new AutosError('AUTH', 'Provider authentication profile is unavailable'); }
    let profile: ProviderAuthProfile | undefined;
    if (this.options.authProfiles !== undefined) {
      // The supervisor validated every profile at startup; validate again so a changed file or a buggy callback cannot widen auth.
      try { profile = validateProviderAuthProfile(`"${request.auth_profile}" (${request.provider})`, request.provider, rawProfile, { requireSubscription: this.options.requireSubscription === true }); }
      catch { throw new AutosError('AUTH', 'Provider authentication profile is invalid'); }
    }
    let authDirectory: string | undefined;
    if (profile?.directory !== undefined) {
      if (!this.options.authRoot) throw new AutosError('AUTH', 'Provider authentication directory is not configured');
      authDirectory = await contained(this.options.authRoot, profile.directory, 'Provider authentication directory');
      if (authDirectory === await canonical(this.options.authRoot)) throw new AutosError('POLICY', 'A provider profile cannot mount the shared authentication root');
      await Promise.all([assertDisjoint(workspaceRoot, authDirectory, 'Authentication directory'), assertDisjoint(outputRoot, authDirectory, 'Authentication directory')]);
      if (!(await stat(authDirectory)).isDirectory()) throw new AutosError('AUTH', 'Provider authentication directory is unavailable');
      try { await validateCodexAuthDirectory(`"${request.auth_profile}" (codex)`, authDirectory); } catch { throw new AutosError('AUTH', 'Provider authentication directory is invalid'); }
    }
    const profileEnv = validateEnvironment(request.provider, profile?.env ?? {});
    const cancelled = (): ProviderResult => ({ provider: request.provider, role: request.role, status: 'CANCELLED', exit_code: null, elapsed_ms: 0, transcript_path: request.transcript_path, result: null, error_code: 'CANCELLED', ...(request.model ? { model: request.model } : {}) });
    const cacheRoot = toolchain && this.options.dependencyCacheRoot ? await canonical(this.options.dependencyCacheRoot) : undefined;
    const launch = async (stagedAuth: string | undefined): Promise<ProviderResult> => {
      const envText = [`AUTOS_JOB_ID=${request.job_id}`, `AUTOS_ISSUE_KEY=${request.issue_key}`, `AUTOS_TIMEOUT_MS=${request.timeout_ms}`, `AUTOS_MAX_PROMPT_BYTES=${this.limits.maxPromptBytes}`, `AUTOS_MAX_TRANSCRIPT_BYTES=${this.limits.maxTranscriptBytes}`, 'HOME=/home/worker', ...(stagedAuth ? ['CODEX_HOME=/run/autos/auth'] : []),
        // Read-only knowledge tools: the gateway URL and this run's token (validated by the request schema; no newlines possible).
        ...(request.knowledge ? [`AUTOS_KNOWLEDGE_URL=${request.knowledge.url}`, `AUTOS_KNOWLEDGE_TOKEN=${request.knowledge.token}`] : []), profileEnv].filter(Boolean).join('\n');
      const started = performance.now();
      const name = containerName(request.job_id, request.role);
      this.track(request.job_id, name);
      let envPath: string | undefined;
      let scratch: string | undefined;
      // SWE keeps one scratch per job (reused across fallbacks, repairs and resumes); QA/reviewer get a throwaway one.
      let removeScratch = false;
      try {
        if (toolchain) {
          if (request.role === 'swe') scratch = await this.ensureJobScratch(request.job_id);
          else { scratch = await this.createScratch(); removeScratch = true; }
        }
        const envDir = await mkdtemp(join(this.options.envRoot ?? tmpdir(), 'autos-auth-'));
        envPath = join(envDir, 'provider.env');
        await writeFile(envPath, `${envText}\n`, { mode: 0o600, flag: 'wx' });
        await chmod(envPath, 0o600);
      } catch (error) {
        this.untrack(request.job_id, name);
        if (scratch && removeScratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof AutosError) throw error;
        throw new AutosError('AUTH', 'Provider authentication profile is unavailable');
      }
      const args = [
        'run', '--rm', '--init', '--name', name, '--label', `autos.job_id=${request.job_id}`, '--network', this.options.providerNetwork?.name ?? 'none',
        // The knowledge gateway runs on the host; Docker Desktop resolves this name itself, Linux needs the mapping.
        ...(request.knowledge && this.options.providerNetwork ? ['--add-host', 'host.docker.internal:host-gateway'] : []), '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--user', `${this.options.uid ?? 10001}:${this.options.gid ?? 10001}`, '--memory', this.limits.memory, '--cpus', this.limits.cpus, '--pids-limit', String(this.limits.pids),
        '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.limits.tmpSize},uid=${this.options.uid ?? 10001},gid=${this.options.gid ?? 10001},mode=1777`, '--tmpfs', `/home/worker:rw,nosuid,nodev,size=${this.limits.homeSize},uid=${this.options.uid ?? 10001},gid=${this.options.gid ?? 10001},mode=0700`,
        ...mount(cwd, '/workspace', request.source_access === 'write' ? 'rw' : 'ro'),
        ...mount(gitDir, '/workspace/.git', 'ro'),
        ...mount(prompt, '/run/autos/prompt.txt', 'ro'), ...mount(outputDir, '/run/autos/output', 'rw'),
        // Only the per-run staged Codex login is mounted (read-write so token refresh works); never the profile directory.
        ...(stagedAuth ? mount(stagedAuth, '/run/autos/auth', 'rw') : []),
        ...(toolchain && scratch ? [...toolchainMounts(toolchain), ...mount(scratch, TOOLCHAIN_MOUNTS.scratch, 'rw'), ...(cacheRoot ? mount(cacheRoot, TOOLCHAIN_MOUNTS.mavenCache, 'ro') : []), ...envArgs(this.roleToolchainEnv(toolchain, request.toolchain!.tomcat !== null, cacheRoot !== undefined))] : []),
        ...(envPath ? ['--env-file', envPath] : []), '--workdir', '/workspace', this.options.workerImage,
        '--provider', request.provider, '--role', request.role,
        ...(request.model ? ['--model', request.model] : []), ...(request.effort ? ['--effort', request.effort] : []), '--auth-profile', request.auth_profile,
        '--prompt', '/run/autos/prompt.txt', '--transcript', `/run/autos/output/${request.transcript_path.split(sep).at(-1)}`,
      ];
      try {
        const result = await this.executor.run(this.options.dockerBinary ?? 'docker', args, {
          timeoutMs: request.timeout_ms,
          maxOutputBytes: this.limits.maxOutputBytes,
          killGraceMs: this.limits.killGraceMs,
          onStderrLine: (line) => {
            const update = parseProgressLine(line);
            if (!update) return;
            try { onProgress?.(update); } catch { /* progress is best effort */ }
          },
        }, signal);
        if (!result.timedOut && !result.cancelled && !result.outputLimit) {
          try {
            const envelope = JSON.parse(result.stdout) as { job_id?: unknown; issue_key?: unknown; result?: unknown };
            if (!envelope || envelope.job_id !== request.job_id || envelope.issue_key !== request.issue_key || !Object.hasOwn(envelope, 'result')) throw new AutosError('INVALID_OUTPUT', 'Runner returned mismatched invocation data');
            const normalized = providerResultSchema.parse(envelope.result);
            const expectedTranscript = `/run/autos/output/${request.transcript_path.split(sep).at(-1)}`;
            const exitConsistent = (normalized.status === 'SUCCEEDED' && result.code === 0 && normalized.exit_code === 0) || (normalized.status === 'FAILED' && result.code === 1 && normalized.error_code !== undefined);
            if (normalized.provider === request.provider && normalized.role === request.role && normalized.model === request.model && normalized.transcript_path === expectedTranscript && exitConsistent) {
              // A worker that failed before running the provider may legitimately have no transcript; success always needs one.
              if (normalized.status === 'SUCCEEDED' && !(await isSafeTranscript(request.transcript_path, outputDir))) throw new AutosError('INVALID_OUTPUT', 'Runner did not create a valid private transcript');
              const { model: returnedModel, error_code: returnedError, retry_at: retryAt, ...fields } = normalized;
              return { ...fields, transcript_path: request.transcript_path, elapsed_ms: performance.now() - started, ...(returnedModel === undefined ? {} : { model: returnedModel }), ...(returnedError === undefined ? {} : { error_code: returnedError }), ...(retryAt === undefined ? {} : { retry_at: retryAt }) };
            }
          } catch { /* Generic tool failure below; never return raw process output. */ }
        }
        const status = result.timedOut ? 'TIMED_OUT' : result.cancelled ? 'CANCELLED' : 'FAILED';
        const infrastructure = status === 'FAILED' && isInfrastructureFailure(result);
        const killed = status === 'FAILED' && result.code === OOM_EXIT_CODE;
        const errorCode = status === 'TIMED_OUT' ? 'TIMEOUT' as const : status === 'CANCELLED' ? 'CANCELLED' as const : infrastructure ? 'UNAVAILABLE' as const : 'TOOL' as const;
        return { provider: request.provider, role: request.role, status, exit_code: result.code, elapsed_ms: performance.now() - started, transcript_path: request.transcript_path, result: infrastructure ? { reason: INFRA_REASON } : killed ? { reason: ROLE_OOM_REASON } : null, error_code: errorCode, ...(request.model ? { model: request.model } : {}) };
      } finally {
        try { await this.removeContainer(name); }
        finally { if (scratch && removeScratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined); if (envPath) await rm(dirname(envPath), { recursive: true, force: true }); this.untrack(request.job_id, name); }
      }
    };
    if (authDirectory === undefined) return await launch(undefined);
    // Codex subscription: one run at a time per login (refresh-token rotation), each on a private staged copy.
    let release: () => void;
    try { release = await acquireAuthLock(authDirectory, signal); } catch { return cancelled(); }
    let staged: { dir: string; original: string } | undefined;
    try {
      staged = await this.stageCodexAuth(authDirectory, workspaceRoot, outputRoot);
      return await launch(staged.dir);
    } finally {
      try {
        if (staged) {
          try { await this.writeBackCodexAuth(authDirectory, staged.dir, staged.original); }
          finally { await rm(staged.dir, { recursive: true, force: true }); }
        }
      } finally { release(); }
    }
  }

  /** Copies the validated login into a private per-run directory and adds the runner's own config.toml. Nothing else from the profile is exposed. */
  private async stageCodexAuth(authDirectory: string, workspaceRoot: string, outputRoot: string): Promise<{ dir: string; original: string }> {
    const parent = this.options.authStagingRoot ?? this.options.envRoot ?? tmpdir();
    let dir: string | undefined;
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      dir = await mkdtemp(join(parent, 'autos-stage-'));
      await chmod(dir, 0o700);
      const roots = [workspaceRoot, outputRoot, ...(this.options.dependencyCacheRoot ? [this.options.dependencyCacheRoot] : [])];
      for (const root of roots) await assertDisjoint(root, dir, 'Authentication staging directory');
      const original = await readCodexAuthFile(authDirectory, { private: true });
      if (original === undefined || !validateCodexAuthJson(original)) throw new AutosError('AUTH', 'Provider authentication directory is invalid');
      await writeFile(join(dir, CODEX_AUTH_FILE), original, { mode: 0o600, flag: 'wx' });
      await writeFile(join(dir, 'config.toml'), CODEX_STAGED_CONFIG, { mode: 0o600, flag: 'wx' });
      // The container runs as uid:gid; when the supervisor is root it can hand the private directory over. Otherwise the uid must match.
      const uid = this.options.uid ?? 10001;
      const gid = this.options.gid ?? 10001;
      if (process.getuid?.() === 0) for (const path of [dir, join(dir, CODEX_AUTH_FILE), join(dir, 'config.toml')]) await chown(path, uid, gid);
      return { dir, original };
    } catch (error) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AutosError) throw error;
      throw new AutosError('AUTH', 'Provider authentication staging failed');
    }
  }

  /** Persists a refreshed login only when it changed and still passes validation; everything else in the staging directory is discarded. */
  private async writeBackCodexAuth(authDirectory: string, stagingDir: string, original: string): Promise<void> {
    const text = await readCodexAuthFile(stagingDir, { private: false });
    if (text === undefined || text === original || !validateCodexAuthJson(text)) return;
    const temporary = join(authDirectory, `.auth.json.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, join(authDirectory, CODEX_AUTH_FILE));
    } catch { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async runChecks(workspace: GitWorkspace, candidateDigest: string, commands: CheckCommand[], signal?: AbortSignal, options?: RunChecksOptions): Promise<Checks> {
    if (!jobIdSchema.safeParse(workspace.job_id).success || !issueKeySchema.safeParse(workspace.issue_key).success || !gitShaSchema.safeParse(workspace.base_sha).success || !branchNameSchema.safeParse(workspace.development_branch).success || !branchNameSchema.safeParse(workspace.feature_branch).success || !digestSchema.safeParse(candidateDigest).success || !Array.isArray(commands) || commands.length === 0 || commands.length > 32) throw new AutosError('INVALID_INPUT', 'Check request is invalid');
    const validatedCommands = commands.map((command) => {
      const parsed = checkCommandSchema.safeParse(command);
      if (!parsed.success) throw new AutosError('INVALID_INPUT', 'Check command is invalid');
      return parsed.data;
    });
    if (!validatedCommands.length || validatedCommands.length > 32) throw new AutosError('INVALID_INPUT', 'Check request is invalid');
    const workspaceRoot = await canonical(this.options.workspaceRoot);
    const outputRoot = await canonical(this.options.outputRoot);
    await assertDisjoint(workspaceRoot, outputRoot, 'Check source and artifact roots');
    if (options?.toolchain || this.options.toolchainRoot) await this.assertToolchainRootDisjoint(workspaceRoot, outputRoot);
    const toolchain = options?.toolchain ? await resolveToolchain(this.options.toolchainRoot, options.toolchain) : undefined;
    if (this.options.dependencyCacheRoot) {
      await Promise.all([assertDisjoint(workspaceRoot, this.options.dependencyCacheRoot, 'Dependency cache'), assertDisjoint(outputRoot, this.options.dependencyCacheRoot, 'Dependency cache')]);
      if (this.options.authRoot) await assertDisjoint(this.options.authRoot, this.options.dependencyCacheRoot, 'Dependency and authentication caches');
    }
    const source = await contained(workspaceRoot, workspace.directory, 'Source workspace');
    const checks: Checks['checks'] = [];
    for (const [index, command] of validatedCommands.entries()) {
      if (signal?.aborted) {
        checks.push({ name: `check-${index + 1}`, command: [command.executable, ...command.args], status: 'NOT_RUN', exit_code: null, timed_out: false, required: command.required, report_paths: [] });
        continue;
      }
      const scratch = resolve(this.options.outputRoot, '.checks', randomUUID());
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      await this.handOver(scratch);
      const name = containerName(workspace.job_id, 'checks');
      this.track(workspace.job_id, name);
      const args = [
        'run', '--rm', '--init', '--name', name, '--label', `autos.job_id=${workspace.job_id}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--user', `${this.options.uid ?? 10001}:${this.options.gid ?? 10001}`, '--memory', this.limits.checkMemory, '--cpus', this.limits.checkCpus, '--pids-limit', String(this.limits.pids),
        '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.limits.tmpSize},uid=${this.options.uid ?? 10001},gid=${this.options.gid ?? 10001},mode=1777`, ...mount(source, '/source', 'ro'), ...mount(scratch, '/scratch', 'rw'),
        ...(this.options.dependencyCacheRoot ? mount(await canonical(this.options.dependencyCacheRoot), '/opt/autos/m2/repository', 'ro') : []),
        ...(toolchain && options?.toolchain ? [...toolchainMounts(toolchain), ...envArgs(this.checksToolchainEnv(toolchain, options.toolchain.tomcat !== null))] : []),
        this.options.checksImage, '--source', '/source', '--scratch', '/scratch', '--timeout-ms', String(command.timeout_ms), '--command-json', JSON.stringify([command.executable, ...command.args]),
      ];
      try {
        const result = await this.executor.run(this.options.dockerBinary ?? 'docker', args, { timeoutMs: command.timeout_ms, maxOutputBytes: this.limits.maxOutputBytes }, signal);
        const wrapper = parseCheckOutput(result.stdout);
        // The container never ran the command (daemon down, image missing, bad exec): that is infrastructure, not a failed check.
        if (wrapper === undefined && isInfrastructureFailure(result)) throw new AutosError('UNAVAILABLE', 'Checks container could not be started (docker daemon or checks image unavailable)', { retryable: true });
        const timedOut = result.timedOut || wrapper?.timed_out === true;
        const actualExit = wrapper?.exit_code ?? (result.code === 0 ? 0 : result.code);
        const status = result.cancelled ? 'NOT_RUN' : wrapper !== undefined && !timedOut && !result.outputLimit && result.code === 0 && actualExit === 0 ? 'PASS' : 'FAIL';
        const killed = !timedOut && !result.cancelled && actualExit === OOM_EXIT_CODE;
        const excerpt = killed ? `${OOM_EXCERPT}${wrapper?.output_excerpt ? `\n${wrapper.output_excerpt}` : ''}`.slice(0, 12_000) : wrapper?.output_excerpt;
        checks.push({ name: `check-${index + 1}`, command: [command.executable, ...command.args], status, exit_code: actualExit, timed_out: timedOut, required: command.required, report_paths: [], ...(excerpt ? { output_excerpt: excerpt } : {}) });
      } finally { try { await this.removeContainer(name); } finally { this.untrack(workspace.job_id, name); await rm(scratch, { recursive: true, force: true }); } }
    }
    return checksSchema.parse({ schema_version: 1, candidate_digest: candidateDigest, recorded_at: new Date().toISOString(), checks, ...(toolchain && options?.toolchain ? { toolchain: { jdk: options.toolchain.jdk, tomcat: options.toolchain.tomcat, ...(toolchain.javaVersion ? { java_version: toolchain.javaVersion } : {}) } } : {}) });
  }

  private roleToolchainEnv(resolved: ResolvedToolchain, tomcat: boolean, cache: boolean): [string, string][] {
    const javaHome = TOOLCHAIN_MOUNTS.jdk;
    return [
      ['JAVA_HOME', javaHome],
      ...(tomcat ? [['CATALINA_HOME', TOOLCHAIN_MOUNTS.tomcat], ['CATALINA_BASE', TOOLCHAIN_MOUNTS.catalinaBase]] as [string, string][] : []),
      ['PATH', `${javaHome}/bin:${MAVEN_BIN}:${IMAGE_PATH}`],
      ['MAVEN_ARGS', `-o -Dmaven.repo.local=${TOOLCHAIN_MOUNTS.mavenLocal}${cache ? ` -Dmaven.repo.local.tail=${TOOLCHAIN_MOUNTS.mavenCache} -Dmaven.repo.local.tail.ignoreAvailability=true` : ''}`],
    ];
  }

  private checksToolchainEnv(_resolved: ResolvedToolchain, tomcat: boolean): [string, string][] {
    return [
      ['JAVA_HOME', TOOLCHAIN_MOUNTS.jdk],
      ...(tomcat ? [['CATALINA_HOME', TOOLCHAIN_MOUNTS.tomcat]] as [string, string][] : []),
      ['PATH', `${TOOLCHAIN_MOUNTS.jdk}/bin:${IMAGE_PATH}`],
    ];
  }

  /**
   * Per-invocation disk scratch for QA/reviewer role containers; the caller removes it after the run. Names are bare
   * random UUIDs (hex and dashes only), so they can never collide with the `swe-<job_id>` job scratch names.
   */
  private async createScratch(): Promise<string> {
    const parent = await this.scratchParent();
    const scratch = join(parent, randomUUID());
    await mkdir(scratch, { mode: 0o700 });
    try { await this.handOver(scratch); } catch (error) { await rm(scratch, { recursive: true, force: true }).catch(() => undefined); throw error; }
    return scratch;
  }

  /** Canonical `<outputRoot>/.scratch`, created private on first use; must be a real directory inside the output root. */
  private async scratchParent(): Promise<string> {
    const outputRoot = await canonical(this.options.outputRoot);
    const parent = join(outputRoot, '.scratch');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AutosError('POLICY', 'Role scratch directory must be a private directory');
    const real = await canonical(parent);
    if (real === outputRoot || !isInside(outputRoot, real)) throw new AutosError('POLICY', 'Role scratch directory must be inside its configured directory');
    return real;
  }

  /**
   * The SWE role's per-job scratch `<outputRoot>/.scratch/swe-<job_id>`: created on first use and reused by every later
   * SWE invocation of the same job (fallbacks, repair rounds, resumes) so build state survives. It is never mounted for
   * QA or review and is removed only by releaseJobScratch or the supervisor's startup sweep.
   */
  private async ensureJobScratch(jobId: string): Promise<string> {
    const id = jobIdSchema.parse(jobId);
    const parent = await this.scratchParent();
    const name = `swe-${id}`;
    try { await mkdir(join(parent, name), { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw new AutosError('UNAVAILABLE', 'Role scratch directory could not be created', { retryable: true }); }
    // A real directory (not a symlink) directly inside the canonical scratch parent.
    const scratch = await realDirectoryInside(parent, name);
    if (scratch === undefined || dirname(scratch) !== parent) throw new AutosError('POLICY', 'Role scratch directory must be a private directory');
    await this.handOver(scratch);
    return scratch;
  }

  /** Remove the SWE job scratch for a finished job. Idempotent; a symlink planted at the name is unlinked, never followed. */
  async releaseJobScratch(jobId: string): Promise<void> {
    if (!jobIdSchema.safeParse(jobId).success) throw new AutosError('INVALID_INPUT', 'Release scratch request is invalid');
    let parent: string;
    try {
      const outputRoot = await realpath(this.options.outputRoot);
      parent = join(outputRoot, '.scratch');
      const parentInfo = await lstat(parent);
      // Never act through a replaced scratch parent; only the runner-created private directory holds job scratch.
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw new AutosError('UNAVAILABLE', 'Role scratch directory could not be released', { retryable: true });
    }
    const path = join(parent, `swe-${jobId}`);
    let info;
    try { info = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw new AutosError('UNAVAILABLE', 'Role scratch directory could not be released', { retryable: true });
    }
    try {
      if (info.isDirectory()) await rm(path, { recursive: true, force: true });
      else await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw new AutosError('UNAVAILABLE', 'Role scratch directory could not be released', { retryable: true });
    }
  }

  /** When the supervisor runs as root it hands the private directory to the container user; otherwise the uids must already match. */
  private async handOver(path: string): Promise<void> {
    await chmod(path, 0o700);
    if (process.getuid?.() === 0) await chown(path, this.options.uid ?? 10001, this.options.gid ?? 10001);
  }

  private async assertToolchainRootDisjoint(workspaceRoot: string, outputRoot: string): Promise<void> {
    const root = this.options.toolchainRoot;
    if (!root) return;
    const others = [workspaceRoot, outputRoot, ...(this.options.authRoot ? [this.options.authRoot] : []), ...(this.options.dependencyCacheRoot ? [this.options.dependencyCacheRoot] : [])];
    for (const other of others) await assertDisjoint(root, other, 'Toolchain directory');
  }


  async stop(jobId: string): Promise<void> {
    if (!jobIdSchema.safeParse(jobId).success) throw new AutosError('INVALID_INPUT', 'Stop request is invalid');
    const names = new Set(this.active.get(jobId) ?? []);
    const listed = await this.executor.run(this.options.dockerBinary ?? 'docker', ['ps', '--all', '--quiet', '--filter', `label=autos.job_id=${jobId}`], { timeoutMs: 10_000, maxOutputBytes: 32_000 });
    const listFailed = listed.code !== 0 || listed.timedOut || listed.cancelled || listed.outputLimit;
    for (const id of listed.stdout.split(/\r?\n/).filter(Boolean)) {
      if (/^[a-f0-9]{12,64}$/i.test(id)) names.add(id);
    }
    await Promise.all([...names].map((name) => this.removeContainer(name)));
    if (listFailed) throw new AutosError('TOOL', 'Runner container cleanup could not list active containers', { retryable: true });
  }

  async health(): Promise<RunnerHealth> {
    const auth = [...(this.options.authSummary ?? [])].map(({ profile, provider, mode }) => ({ profile, provider, mode })).sort((x, y) => x.profile.localeCompare(y.profile) || x.provider.localeCompare(y.provider));
    const toolchains = this.options.toolchainRoot ? await listInstalledToolchains(this.options.toolchainRoot) : undefined;
    const base = { status: 'ready', version: 1, auth, require_subscription: this.options.requireSubscription === true, ...(toolchains ? { toolchains } : {}) } as const;
    if (this.options.testOnly) return { ...base, docker: 'test-only' };
    const docker = this.options.dockerBinary ?? 'docker';
    const ok = (result: DockerProcessResult) => !result.timedOut && !result.cancelled && !result.outputLimit && result.code === 0;
    const info = await this.executor.run(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5_000, maxOutputBytes: 2_000 });
    if (!ok(info)) return { ...base, docker: 'unavailable' };
    // Both reviewed images must be present locally: a missing image would fail every run with an infrastructure error.
    for (const image of new Set([this.options.workerImage, this.options.checksImage])) {
      const inspected = await this.executor.run(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 5_000, maxOutputBytes: 2_000 });
      if (!ok(inspected)) return { ...base, docker: 'unavailable' };
    }
    return { ...base, docker: 'available' };
  }

  /**
   * Startup recovery for a supervisor that crashed or was killed: force-remove every container carrying the autos job
   * label, delete stale check scratch directories, every role scratch directory under `.scratch` (per-invocation QA/review
   * scratch and the per-job `swe-<job_id>` SWE scratch alike, so a paused job resumed after a supervisor restart starts
   * with an empty SWE scratch) and stale provider env directories. Must run only when no other
   * supervisor owns the same Docker host (createSupervisorServer calls it after the socket is claimed).
   */
  async sweep(): Promise<{ containers: number; scratch: number; envDirs: number }> {
    const docker = this.options.dockerBinary ?? 'docker';
    let containers = 0;
    const listed = await this.executor.run(docker, ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=autos.job_id'], { timeoutMs: 15_000, maxOutputBytes: 256_000 });
    if (!listed.timedOut && !listed.cancelled && !listed.outputLimit && listed.code === 0) {
      for (const id of listed.stdout.split(/\r?\n/).filter((line) => /^[a-f0-9]{12,64}$/i.test(line))) {
        try { await this.removeContainer(id); containers += 1; } catch { /* reported by the next health/run; keep sweeping */ }
      }
    }
    let scratch = 0;
    const checksRoot = resolve(this.options.outputRoot, '.checks');
    for (const entry of await readdir(checksRoot).catch(() => [] as string[])) {
      await rm(join(checksRoot, entry), { recursive: true, force: true }).then(() => { scratch += 1; }).catch(() => undefined);
    }
    const scratchRoot = resolve(this.options.outputRoot, '.scratch');
    for (const entry of await readdir(scratchRoot).catch(() => [] as string[])) {
      await rm(join(scratchRoot, entry), { recursive: true, force: true }).then(() => { scratch += 1; }).catch(() => undefined);
    }
    let envDirs = 0;
    // Test-only runners never touch the shared OS temp dir unless a private envRoot is supplied.
    const envParent = this.options.envRoot ?? (this.options.testOnly ? undefined : tmpdir());
    // Leftover staged Codex logins (crash mid-run) are secrets too; the profile directory still holds the last written-back login.
    const stagingParent = this.options.authStagingRoot ?? envParent;
    for (const [parent, pattern] of [[envParent, /^autos-auth-[A-Za-z0-9]{6}$/], [stagingParent, /^autos-stage-[A-Za-z0-9]{6}$/]] as const) {
      for (const entry of parent ? await readdir(parent).catch(() => [] as string[]) : []) {
        if (!pattern.test(entry)) continue;
        await rm(join(parent!, entry), { recursive: true, force: true }).then(() => { envDirs += 1; }).catch(() => undefined);
      }
    }
    return { containers, scratch, envDirs };
  }

  private async removeContainer(name: string): Promise<void> {
    let last: DockerProcessResult | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await this.executor.run(this.options.dockerBinary ?? 'docker', ['rm', '--force', name], { timeoutMs: 10_000, maxOutputBytes: 32_000 });
      if (!last.timedOut && !last.cancelled && !last.outputLimit && last.code === 0) return;
      if (!last.timedOut && !last.cancelled && !last.outputLimit && /no such container/i.test(last.stderr)) return;
    }
    throw new AutosError('TOOL', 'Runner container cleanup failed', { retryable: true });
  }

  private track(jobId: string, name: string): void { const set = this.active.get(jobId) ?? new Set<string>(); set.add(name); this.active.set(jobId, set); }
  private untrack(jobId: string, name: string): void { const set = this.active.get(jobId); set?.delete(name); if (!set?.size) this.active.delete(jobId); }
}

async function isSafeTranscript(path: string, outputRoot: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size <= 10_000_000 && isInside(await realpath(outputRoot), await realpath(path));
  } catch { return false; }
}

export function createDockerRunner(options: DockerRunnerOptions): DockerRunner { return new DockerRunner(options); }

export interface RunnerSupervisorOptions {
  socketPath: string;
  runner: RunnerPort;
  /** The only host filesystem subtree this API client can address. */
  clientRoot: string;
  hostRoot: string;
  /**
   * Called once per request outcome with a flat, secret-free record (action, job id, role, provider, status, code,
   * elapsed_ms). Never receives prompts, paths or environment values.
   */
  log?: (record: SupervisorLogRecord) => void;
  /** Run the runner's startup sweep (stale labelled containers and scratch) once the socket is claimed. Defaults to true. */
  sweepOnStart?: boolean;
}

export interface SupervisorLogRecord {
  event: 'request' | 'sweep' | 'shutdown';
  action?: string;
  job_id?: string;
  role?: string;
  provider?: string;
  status?: string;
  code?: string;
  http_status?: number;
  elapsed_ms?: number;
  [key: string]: string | number | boolean | undefined;
}

interface SupervisorState { inflight: Set<AbortController>; runner: RunnerPort; log: (record: SupervisorLogRecord) => void; socketPath: string }
const supervisorStates = new WeakMap<Server, SupervisorState>();

/**
 * Graceful stop: abort every in-flight run (the executor stops the docker CLI, which stops the container, and the
 * runner removes it), stop accepting connections, wait up to `waitMs`, then force-close remaining connections and
 * remove any labelled container left behind.
 */
export async function shutdownSupervisor(server: Server, options: { waitMs?: number } = {}): Promise<void> {
  const state = supervisorStates.get(server);
  const waitMs = options.waitMs ?? 10_000;
  const started = performance.now();
  const aborted = state?.inflight.size ?? 0;
  for (const controller of state?.inflight ?? []) controller.abort();
  const closed = new Promise<void>((resolvePromise) => { if (!server.listening) resolvePromise(); else server.close(() => resolvePromise()); });
  // Connections that finish their aborted response become idle keep-alive sockets; close them as they appear.
  const idleSweep = setInterval(() => server.closeIdleConnections(), 50);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([closed.then(() => false), new Promise<boolean>((resolvePromise) => { timer = setTimeout(() => resolvePromise(true), waitMs); })]);
  if (timer) clearTimeout(timer);
  clearInterval(idleSweep);
  if (timedOut) { server.closeAllConnections(); await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))]); }
  const runner = state?.runner as { sweep?: () => Promise<unknown> } | undefined;
  if (typeof runner?.sweep === 'function') await runner.sweep().catch(() => undefined);
  state?.log({ event: 'shutdown', status: timedOut ? 'FORCED' : 'CLEAN', aborted, elapsed_ms: Math.round(performance.now() - started) });
}

async function prepareSocketPath(path: string): Promise<void> {
  let previous: Awaited<ReturnType<typeof lstat>>;
  try { previous = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new AutosError('INVALID_CONFIG', 'Supervisor socket path is unavailable'); }
  if (!previous.isSocket()) throw new AutosError('POLICY', 'Supervisor socket path already exists and is not a socket');
  const live = await new Promise<boolean>((resolvePromise, reject) => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolvePromise(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) resolvePromise(false);
      else reject(new AutosError('POLICY', 'Supervisor socket is unavailable'));
    });
  });
  if (live) throw new AutosError('CONFLICT', 'A runner supervisor is already listening');
  try {
    const current = await lstat(path);
    if (!current.isSocket() || current.dev !== previous.dev || current.ino !== previous.ino) throw new AutosError('CONFLICT', 'Supervisor socket changed during startup');
    await unlink(path);
  } catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('CONFLICT', 'Stale supervisor socket could not be removed');
  }
}

function translatePath(path: string, fromRoot: string, toRoot: string): string {
  if (!isAbsolute(path)) throw new AutosError('INVALID_INPUT', 'Supervisor paths must be absolute');
  const rel = relative(resolve(fromRoot), resolve(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AutosError('POLICY', 'Path is outside the supervisor workspace');
  return resolve(toRoot, rel);
}

function translateRequest(request: ProviderRequest, clientRoot: string, hostRoot: string): ProviderRequest {
  const { model, effort, ...fields } = request;
  return { ...fields, cwd: translatePath(request.cwd, clientRoot, hostRoot), prompt_path: translatePath(request.prompt_path, clientRoot, hostRoot), transcript_path: translatePath(request.transcript_path, clientRoot, hostRoot), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

function safeJson(value: unknown): string { return JSON.stringify(value); }

async function bodyJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new AutosError('INVALID_INPUT', 'Supervisor request is too large');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new AutosError('INVALID_INPUT', 'Supervisor request is invalid'); }
}

/** Fixed-operation local RPC. The controller receives no Docker socket or arbitrary command endpoint. */
export async function createSupervisorServer(options: RunnerSupervisorOptions): Promise<Server> {
  if (!isAbsolute(options.socketPath) || !isAbsolute(options.clientRoot) || !isAbsolute(options.hostRoot)) throw new AutosError('INVALID_CONFIG', 'Supervisor paths must be absolute');
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await prepareSocketPath(options.socketPath);
  const log = options.log ?? (() => undefined);
  const inflight = new Set<AbortController>();
  if (options.sweepOnStart !== false && typeof (options.runner as { sweep?: unknown }).sweep === 'function') {
    const sweptStarted = performance.now();
    try {
      const swept = await (options.runner as unknown as { sweep: () => Promise<{ containers: number; scratch: number; envDirs: number }> }).sweep();
      log({ event: 'sweep', status: 'OK', containers: swept.containers, scratch: swept.scratch, env_dirs: swept.envDirs, elapsed_ms: Math.round(performance.now() - sweptStarted) });
    } catch { log({ event: 'sweep', status: 'FAILED', code: 'UNAVAILABLE', elapsed_ms: Math.round(performance.now() - sweptStarted) }); }
  }
  const clientRoot = resolve(options.clientRoot);
  const hostRoot = resolve(options.hostRoot);
  const server = createServer(async (req, res) => {
    const cancellation = new AbortController();
    inflight.add(cancellation);
    const startedAt = performance.now();
    const record: SupervisorLogRecord = { event: 'request', action: 'unknown' };
    res.once('close', () => inflight.delete(cancellation));
    req.once('aborted', () => cancellation.abort());
    res.once('close', () => { if (!res.writableEnded) cancellation.abort(); });
    res.setHeader('content-type', 'application/json');
    let streamingRole = false;
    try {
      if (req.method === 'GET' && req.url === '/v1/health') {
        record.action = 'health';
        const health = 'health' in options.runner && typeof options.runner.health === 'function' ? await options.runner.health() : { status: 'ready', version: 1, docker: 'unavailable' };
        record.status = health.docker; res.end(safeJson(health)); return;
      }
      if (req.method !== 'POST') { res.statusCode = 404; res.end(safeJson({ error: 'NOT_FOUND' })); return; }
      const body = await bodyJson(req);
      if (req.url === '/v1/run-role') {
        if (!body || typeof body !== 'object') throw new AutosError('INVALID_INPUT', 'Runner request is invalid');
        record.action = 'run-role';
        const parsed = providerRequestSchema.parse(body);
        record.job_id = parsed.job_id; record.role = parsed.role; record.provider = parsed.provider;
        const { model, effort, ...requestFields } = parsed;
        const request: ProviderRequest = { ...requestFields, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
        streamingRole = req.headers.accept?.split(',').some((value) => value.trim().split(';')[0] === 'application/x-ndjson') ?? false;
        if (streamingRole) res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        const result = await options.runner.runRole(translateRequest(request, clientRoot, hostRoot), cancellation.signal, streamingRole ? (update) => {
          const valid = progressUpdateSchema.safeParse(update);
          if (valid.success && !res.destroyed && !res.writableEnded) res.write(`${safeJson({ progress: valid.data })}\n`);
        } : undefined);
        record.status = result.status; if (result.error_code) record.code = result.error_code;
        const response = { ...result, transcript_path: translatePath(result.transcript_path, hostRoot, clientRoot) };
        res.end(streamingRole ? `${safeJson({ result: response })}\n` : safeJson(response)); return;
      }
      if (req.url === '/v1/run-checks') {
        record.action = 'run-checks';
        const value = body as { workspace?: GitWorkspace; candidateDigest?: string; commands?: CheckCommand[]; options?: unknown };
        if (typeof value?.workspace?.job_id === 'string' && jobIdSchema.safeParse(value.workspace.job_id).success) record.job_id = value.workspace.job_id;
        if (!value || typeof value !== 'object' || !value.workspace || typeof value.candidateDigest !== 'string' || !Array.isArray(value.commands)) throw new AutosError('INVALID_INPUT', 'Check request is invalid');
        const workspace = { ...value.workspace, directory: translatePath(value.workspace.directory, clientRoot, hostRoot) };
        let toolchainOption: ToolchainSelection | undefined;
        if (value.options !== undefined) {
          const raw = value.options as Record<string, unknown> | null;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'toolchain')) throw new AutosError('INVALID_INPUT', 'Check request is invalid');
          if (raw.toolchain !== undefined) { const parsedToolchain = toolchainSelectionSchema.safeParse(raw.toolchain); if (!parsedToolchain.success) throw new AutosError('INVALID_INPUT', 'Check request is invalid'); toolchainOption = parsedToolchain.data; }
        }
        const result = await options.runner.runChecks(workspace, value.candidateDigest, value.commands, cancellation.signal, toolchainOption ? { toolchain: toolchainOption } : undefined);
        record.status = result.checks.some((check) => check.status === 'FAIL') ? 'FAIL' : result.checks.some((check) => check.status === 'NOT_RUN') ? 'NOT_RUN' : 'PASS';
        res.end(safeJson(result)); return;
      }
      if (req.url === '/v1/release-scratch') {
        record.action = 'release-scratch';
        const value = body as { jobId?: string };
        if (!jobIdSchema.safeParse(value?.jobId).success) throw new AutosError('INVALID_INPUT', 'Release scratch request is invalid');
        const jobId = jobIdSchema.parse(value.jobId);
        record.job_id = jobId;
        if (typeof options.runner.releaseJobScratch === 'function') await options.runner.releaseJobScratch(jobId);
        record.status = 'RELEASED';
        res.end(safeJson({ released: true })); return;
      }
      if (req.url === '/v1/stop') {
        record.action = 'stop';
        const value = body as { jobId?: string };
        if (!jobIdSchema.safeParse(value?.jobId).success) throw new AutosError('INVALID_INPUT', 'Stop request is invalid');
        const jobId = jobIdSchema.parse(value.jobId);
        record.job_id = jobId;
        await options.runner.stop(jobId);
        record.status = 'STOPPED';
        res.end(safeJson({ stopped: true })); return;
      }
      res.statusCode = 404; res.end(safeJson({ error: 'NOT_FOUND' }));
    } catch (error) {
      const code = error instanceof AutosError ? error.code : 'INVALID_INPUT';
      res.statusCode = code === 'NOT_FOUND' ? 404 : code === 'POLICY' ? 403 : code === 'UNAVAILABLE' ? 503 : 400;
      record.status = 'ERROR'; record.code = code;
      const body = { error: code, message: error instanceof AutosError ? error.message : 'Supervisor request failed' };
      res.end(streamingRole ? `${safeJson({ error: body })}\n` : safeJson(body));
    } finally {
      record.http_status = res.statusCode; record.elapsed_ms = Math.round(performance.now() - startedAt);
      try { log(record); } catch { /* logging must never fail a request */ }
    }
  });
  supervisorStates.set(server, { inflight, runner: options.runner, log, socketPath: options.socketPath });
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(options.socketPath, () => resolvePromise()); });
  await chmod(options.socketPath, 0o600);
  const identity = await lstat(options.socketPath);
  server.once('close', () => {
    void lstat(options.socketPath).then((current) => current.isSocket() && current.dev === identity.dev && current.ino === identity.ino ? unlink(options.socketPath) : undefined).catch(() => undefined);
  });
  return server;
}

export interface DockerRunnerClientOptions { socketPath: string; requestTimeoutMs?: number }

export class DockerRunnerClient implements RunnerPort {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  constructor(options: DockerRunnerClientOptions) {
    if (!isAbsolute(options.socketPath)) throw new AutosError('INVALID_CONFIG', 'Runner supervisor socket path must be absolute');
    this.socketPath = options.socketPath;
    this.timeoutMs = options.requestTimeoutMs ?? 3_700_000;
  }
  private async call(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = this.timeoutMs, onProgress?: (update: ProgressUpdate) => void): Promise<unknown> {
    if (signal?.aborted) throw new AutosError('CANCELLED', 'Runner operation was cancelled');
    return await new Promise((resolvePromise, reject) => {
      let timedOut = false;
      let cancelled = false;
      const req = httpRequest({ socketPath: this.socketPath, path, method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(onProgress ? { accept: 'application/x-ndjson' } : {}) }, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const streaming = res.headers['content-type']?.includes('application/x-ndjson') === true;
        let pending = '';
        let streamedResult: unknown;
        let streamedError: unknown;
        let invalidStream = false;
        const consumeLine = (line: string) => {
          const lineBytes = Buffer.byteLength(line, 'utf8');
          if (lineBytes > 2_000_000) { invalidStream = true; return; }
          try {
            const value = JSON.parse(line) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            const record = value as Record<string, unknown>;
            if (Object.keys(record).length === 1 && Object.hasOwn(record, 'progress')) {
              if (lineBytes > 65_536) return;
              const parsed = progressUpdateSchema.safeParse(record.progress);
              if (parsed.success) { try { onProgress?.(parsed.data); } catch { /* progress is best effort */ } }
            } else if (Object.keys(record).length === 1 && Object.hasOwn(record, 'result')) streamedResult = record.result;
            else if (Object.keys(record).length === 1 && Object.hasOwn(record, 'error')) streamedError = record.error;
          } catch { /* malformed progress or unrelated lines are ignored */ }
        };
        res.on('data', (chunk: Buffer) => {
          if (!streaming) {
            size += chunk.length;
            if (size > 2_000_000) { req.destroy(new Error('response too large')); return; }
            chunks.push(chunk); return;
          }
          // Streaming: progress lines are consumed as they arrive, so only a single line is bounded (below).
          if (invalidStream) return;
          pending += chunk.toString('utf8');
          if (Buffer.byteLength(pending, 'utf8') > 2_000_000 && !pending.includes('\n')) { invalidStream = true; req.destroy(new Error('response line too large')); return; }
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); consumeLine(line); }
        });
        res.on('end', () => {
          try {
            if (streaming) {
              if (pending) consumeLine(pending);
              if (invalidStream || streamedResult === undefined && streamedError === undefined) throw new Error('invalid stream');
              if ((res.statusCode ?? 500) >= 400 || streamedError !== undefined) {
                const data = streamedError && typeof streamedError === 'object' ? streamedError as { error?: unknown } : {};
                const code = typeof data.error === 'string' && ERROR_CODES.includes(data.error as (typeof ERROR_CODES)[number]) ? data.error as (typeof ERROR_CODES)[number] : 'TOOL';
                reject(new AutosError(code, 'Runner supervisor rejected the operation', { retryable: code === 'TOOL' || code === 'TIMEOUT' || code === 'UNAVAILABLE' }));
                return;
              }
              resolvePromise(streamedResult); return;
            }
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if ((res.statusCode ?? 500) >= 400) {
              const data = parsed && typeof parsed === 'object' ? parsed as { error?: unknown } : {};
              const code = typeof data.error === 'string' && ERROR_CODES.includes(data.error as (typeof ERROR_CODES)[number]) ? data.error as (typeof ERROR_CODES)[number] : 'TOOL';
              reject(new AutosError(code, 'Runner supervisor rejected the operation', { retryable: code === 'TOOL' || code === 'TIMEOUT' || code === 'UNAVAILABLE' }));
            }
            else resolvePromise(parsed);
          } catch { reject(new AutosError('TOOL', 'Runner supervisor returned an invalid response')); }
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        // A missing, refused or inaccessible socket means the supervisor is not running: retryable infrastructure, not a tool failure.
        const unreachable = ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK', 'ECONNRESET', 'EPIPE'].includes(error?.code ?? '');
        if (cancelled) reject(new AutosError('CANCELLED', 'Runner operation was cancelled'));
        else if (timedOut) reject(new AutosError('TIMEOUT', 'Runner operation timed out', { retryable: true }));
        else if (unreachable) reject(new AutosError('UNAVAILABLE', 'Runner supervisor is unavailable', { retryable: true }));
        else reject(new AutosError('TOOL', 'Runner supervisor request failed', { retryable: false }));
      });
      req.on('timeout', () => { timedOut = true; req.destroy(); });
      const abort = () => { cancelled = true; req.destroy(); };
      signal?.addEventListener('abort', abort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', abort));
      if (body === undefined) req.end(); else req.end(safeJson(body));
    });
  }
  async health(): Promise<RunnerHealth> {
    const value = await this.call('/v1/health') as Record<string, unknown>;
    if (value?.status !== 'ready' || value.version !== 1 || !['available', 'unavailable', 'test-only'].includes(String(value.docker))) throw new AutosError('TOOL', 'Runner supervisor returned invalid health data');
    const health: RunnerHealth = { status: 'ready', version: 1, docker: value.docker as RunnerHealth['docker'] };
    // auth and require_subscription are absent from older supervisors; when present they must be well formed.
    if (value.auth !== undefined) {
      const entries = Array.isArray(value.auth) ? value.auth as unknown[] : undefined;
      const valid = entries?.every((entry) => isAuthSummary(entry));
      if (!entries || !valid) throw new AutosError('TOOL', 'Runner supervisor returned invalid health data');
      health.auth = entries.map((entry) => { const { profile, provider, mode } = entry as ProviderAuthSummary; return { profile, provider, mode }; });
    }
    if (value.require_subscription !== undefined) {
      if (typeof value.require_subscription !== 'boolean') throw new AutosError('TOOL', 'Runner supervisor returned invalid health data');
      health.require_subscription = value.require_subscription;
    }
    if (value.toolchains !== undefined) {
      const parsed = installedToolchainsSchema.safeParse(value.toolchains);
      if (!parsed.success) throw new AutosError('TOOL', 'Runner supervisor returned invalid health data');
      health.toolchains = parsed.data;
    }
    return health;
  }
  async runRole(request: ProviderRequest, signal?: AbortSignal, onProgress?: (update: ProgressUpdate) => void): Promise<ProviderResult> {
    const parsed = providerRequestSchema.parse(request);
    try {
      const response = providerResultSchema.parse(await this.call('/v1/run-role', parsed, signal, parsed.timeout_ms + 30_000, onProgress ?? (() => undefined)));
      if (response.provider !== parsed.provider || response.role !== parsed.role || response.model !== parsed.model || response.transcript_path !== parsed.transcript_path) throw new AutosError('INVALID_OUTPUT', 'Runner supervisor returned mismatched role evidence');
      const { model, error_code: errorCode, retry_at: retryAt, ...fields } = response;
      return { ...fields, ...(model === undefined ? {} : { model }), ...(errorCode === undefined ? {} : { error_code: errorCode }), ...(retryAt === undefined ? {} : { retry_at: retryAt }) };
    } catch (error) {
      if (!(error instanceof AutosError) || !['CANCELLED', 'TIMEOUT'].includes(error.code)) throw error;
      const status = error.code === 'CANCELLED' ? 'CANCELLED' : 'TIMED_OUT';
      return { provider: parsed.provider, role: parsed.role, status, exit_code: null, elapsed_ms: parsed.timeout_ms, transcript_path: parsed.transcript_path, result: null, error_code: error.code, ...(parsed.model === undefined ? {} : { model: parsed.model }) };
    }
  }
  async runChecks(workspace: GitWorkspace, candidateDigest: string, commands: CheckCommand[], signal?: AbortSignal, options?: RunChecksOptions): Promise<Checks> {
    const parsedCommands = commands.map((command) => checkCommandSchema.parse(command));
    try {
      const response = checksSchema.parse(await this.call('/v1/run-checks', { workspace, candidateDigest, commands: parsedCommands, ...(options?.toolchain ? { options: { toolchain: toolchainSelectionSchema.parse(options.toolchain) } } : {}) }, signal, parsedCommands.reduce((total, command) => total + command.timeout_ms, 60_000)));
      if (response.candidate_digest !== candidateDigest) throw new AutosError('INVALID_OUTPUT', 'Runner supervisor returned mismatched check evidence');
      return response;
    } catch (error) {
      if (!(error instanceof AutosError) || !['CANCELLED', 'TIMEOUT'].includes(error.code)) throw error;
      return checksSchema.parse({ schema_version: 1, candidate_digest: candidateDigest, recorded_at: new Date().toISOString(), checks: parsedCommands.map((command, index) => ({ name: `check-${index + 1}`, command: [command.executable, ...command.args], status: error.code === 'TIMEOUT' && index === 0 ? 'FAIL' : 'NOT_RUN', exit_code: null, timed_out: error.code === 'TIMEOUT' && index === 0, required: command.required, report_paths: [] })) });
    }
  }
  async stop(jobId: string): Promise<void> { if (!jobIdSchema.safeParse(jobId).success) throw new AutosError('INVALID_INPUT', 'Stop request is invalid'); await this.call('/v1/stop', { jobId }, undefined, 30_000); }
  async releaseJobScratch(jobId: string): Promise<void> { if (!jobIdSchema.safeParse(jobId).success) throw new AutosError('INVALID_INPUT', 'Release scratch request is invalid'); await this.call('/v1/release-scratch', { jobId }, undefined, 30_000); }
}

function isAuthSummary(value: unknown): value is ProviderAuthSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.profile === 'string' && entry.profile.length > 0 && entry.profile.length <= 256 && ['claude', 'codex', 'cursor'].includes(String(entry.provider)) && ['subscription', 'api', 'local'].includes(String(entry.mode));
}

export function assertRunnerPaths(options: Pick<DockerRunnerOptions, 'workspaceRoot' | 'promptRoot' | 'outputRoot'>): void {
  if ([options.workspaceRoot, options.promptRoot, options.outputRoot].some((path) => !isAbsolute(path))) throw new AutosError('INVALID_CONFIG', 'Runner roots must be absolute paths');
  if (resolve(options.workspaceRoot) === resolve(options.promptRoot) || resolve(options.workspaceRoot) === resolve(options.outputRoot)) throw new AutosError('INVALID_CONFIG', 'Runner workspace and artifact roots must be distinct');
}

/** Early, lexical refusal of overlapping roots; the per-run check repeats it on canonical paths. */
function assertToolchainRootDisjointLexically(options: DockerRunnerOptions): void {
  if (options.toolchainRoot === undefined) return;
  if (!isAbsolute(options.toolchainRoot)) throw new AutosError('INVALID_CONFIG', 'Toolchain root must be an absolute path');
  const root = resolve(options.toolchainRoot);
  for (const other of [options.workspaceRoot, options.outputRoot, options.promptRoot, options.authRoot, options.dependencyCacheRoot]) {
    if (other !== undefined && isAbsolute(other) && (isInside(root, resolve(other)) || isInside(resolve(other), root))) throw new AutosError('INVALID_CONFIG', 'Toolchain root must be disjoint from job data, authentication and cache roots');
  }
}
