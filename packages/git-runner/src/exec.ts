import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { AutosError } from '@autos/contracts';

/** Global options prepended to every trusted Git invocation: no hooks, no fsmonitor, pathspecs taken literally. */
export const SAFE_GIT_PREFIX = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--literal-pathspecs'] as const;

export interface TrustedGitCredentials { gitAskPassPath?: string; sshAuthSocket?: string }

/** Minimal, deterministic Git environment. Credentials only come from the trusted controller channel. */
export function buildGitEnv(cwd: string, options: { credentials?: TrustedGitCredentials | undefined; allowFileProtocol: boolean }, extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? '/usr/bin:/bin';
  return {
    PATH: path, HOME: homedir(), TMPDIR: tmpdir(), LANG: 'C.UTF-8', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: options.allowFileProtocol ? 'https:ssh:file' : 'https:ssh', GIT_CEILING_DIRECTORIES: dirname(cwd),
    ...(options.credentials?.gitAskPassPath ? { GIT_ASKPASS: options.credentials.gitAskPassPath } : {}),
    ...(options.credentials?.sshAuthSocket ? { SSH_AUTH_SOCK: options.credentials.sshAuthSocket } : {}),
    ...extras,
  };
}

/** Maps a failed Git process to a safe, authored error. Never includes stderr text, URLs or tokens. */
export function classifyGitFailure(e: { code?: number | string | null | undefined; killed?: boolean | undefined; signal?: string | null | undefined; stderr?: Buffer | string | undefined }, label?: string): AutosError {
  if (e.code === 'ENOENT') return new AutosError('UNAVAILABLE', 'Git executable is unavailable');
  if (e.code === 'ETIMEDOUT' || (e.killed === true && e.signal === 'SIGTERM')) return new AutosError('TIMEOUT', 'Git operation timed out', { retryable: true });
  const text = String(e.stderr ?? '');
  if (/authentication failed|\b40[13]\b|could not read (username|password)|permission denied \(publickey|terminal prompts disabled|invalid credentials/i.test(text)) {
    return new AutosError('AUTH', `Git authentication failed for ${label ?? 'the repository'}`);
  }
  if (/couldn't find remote ref|remote branch .* not found/i.test(text)) return new AutosError('MAPPING', 'Development branch not found on the remote');
  if (/repository .*not found|\b404\b/i.test(text)) return new AutosError('NOT_FOUND', 'Git repository not found on the remote');
  if (/could not resolve host|connection refused|connection timed out|operation timed out|network is unreachable|failed to connect|connection reset|temporary failure in name resolution|could not resolve hostname/i.test(text)) {
    return new AutosError('UPSTREAM', 'Git remote unreachable', { retryable: true });
  }
  return new AutosError('UPSTREAM', 'Git operation failed', { retryable: true });
}

/** True for the approved Bitbucket remote forms (HTTPS without embedded credentials, or SSH). */
export function isApprovedBitbucketRemote(remote: string): boolean {
  let parsed: URL | null = null;
  try { parsed = new URL(remote); } catch { /* checked below */ }
  if (parsed && parsed.protocol === 'https:' && parsed.hostname === 'bitbucket.org' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.git$/.test(parsed.pathname)) return true;
  return /^git@bitbucket\.org:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.git$/.test(remote);
}

export interface SpawnGitOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  /** Maximum stdout bytes kept. */
  maxBytes: number;
  /** When true, output beyond maxBytes is dropped and the process stopped (result.truncated); otherwise it is an error. */
  truncate?: boolean | undefined;
  input?: string | Buffer | undefined;
  allowExitCodes?: number[] | undefined;
  label?: string | undefined;
}
export interface SpawnGitResult { stdout: Buffer; stderr: string; code: number; truncated: boolean }

const STDERR_MAX_BYTES = 64 * 1024;

/**
 * Streams a trusted Git process with an argument array (never a shell), a timeout, an output cap and optional stdin.
 * Failures become sanitized AutosErrors (classifyGitFailure); raw stderr never leaves this function.
 */
export function spawnGit(args: readonly string[], options: SpawnGitOptions): Promise<SpawnGitResult> {
  if (options.signal?.aborted) return Promise.reject(new AutosError('CANCELLED', 'Git operation cancelled'));
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...SAFE_GIT_PREFIX, ...args], { cwd: options.cwd, env: options.env, windowsHide: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let truncated = false;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => { child.kill('SIGTERM'); finish(() => reject(new AutosError('CANCELLED', 'Git operation cancelled'))); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (truncated || overflow) return;
      if (size + chunk.length > options.maxBytes) {
        if (options.truncate) { chunks.push(chunk.subarray(0, options.maxBytes - size)); size = options.maxBytes; truncated = true; }
        else overflow = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString('utf8').slice(0, STDERR_MAX_BYTES - stderr.length); });
    child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(classifyGitFailure({ code: error.code }, options.label))));
    child.on('close', (code, signal) => finish(() => {
      if (timedOut) return reject(new AutosError('TIMEOUT', 'Git operation timed out', { retryable: true }));
      if (overflow) return reject(new AutosError('POLICY', 'Git output exceeds the size limit'));
      const stdout = Buffer.concat(chunks);
      if (truncated) return resolvePromise({ stdout, stderr, code: code ?? 0, truncated: true });
      const exit = code ?? 1;
      if (signal === null && (exit === 0 || options.allowExitCodes?.includes(exit))) return resolvePromise({ stdout, stderr, code: exit, truncated: false });
      reject(classifyGitFailure({ code: exit, signal, stderr }, options.label));
    }));
    if (options.input !== undefined) {
      child.stdin!.on('error', () => undefined); // EPIPE when Git stops reading early; the exit status decides.
      child.stdin!.end(options.input);
    }
  });
}
