import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AutosError,
  CURSOR_MODEL,
  providerRequestSchema,
  providerResultSchema,
  type AgentRole,
  type ErrorCode,
  type Provider,
  type ProviderAdapterPort,
  type ProviderRequest,
  type ProviderResult,
} from '@autos/contracts';

export interface CliAdapterOptions {
  /** Executable paths or command names; each call still uses spawn(argv), never a shell. */
  binaries?: Partial<Record<Provider, string>>;
  /** Only this profile's credentials may be added to the child environment. */
  resolveAuth?: (profile: string, provider: Provider) => Promise<Record<string, string>> | Record<string, string>;
  /** Non-secret baseline. Defaults to PATH only; controller credentials are never inherited. */
  baseEnv?: Record<string, string>;
  maxOutputBytes?: number;
  maxPromptBytes?: number;
  /** Claude SWE Bash allow-prefixes (e.g. 'mvn', 'git status'); replaces DEFAULT_SWE_BASH_PREFIXES. Deny rules always still apply. */
  sweBashPrefixes?: readonly string[];
  maxTranscriptBytes?: number;
  killGraceMs?: number;
  spawnProcess?: typeof spawn;
  /** Clock for rate-limit reset windows and relative retry fields; defaults to `() => new Date()`. */
  now?: () => Date;
}

type Invocation = { binary: string; args: string[]; stdin?: string };

/** Fixed, non-secret variables that stop update checks, telemetry, and nonessential network calls in headless runs. */
const providerEnvOptOuts: Record<Provider, Readonly<Record<string, string>>> = {
  claude: {
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
  // codex 0.162.1 documents no env opt-outs in --help; none are invented here.
  codex: {},
  cursor: {},
};
type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; outputLimit: boolean; cancelled: boolean; timedOut: boolean; spawnErrorCode?: string };

const defaults: Record<Provider, string> = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent' };
/** Must exceed the transcript cap: stream-json stdout is the transcript source and an output-limit hit discards it. */
const defaultMaxOutput = 67_108_864;
/** Transcripts hold the full redacted provider stream (tool calls, edits, reasoning) for dataset capture. */
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 5_242_880;
export const MAX_TRANSCRIPT_BYTES_LIMIT = 52_428_800;
const defaultMaxTranscript = DEFAULT_MAX_TRANSCRIPT_BYTES;
/** Workflow budgets prompts to ~180 KiB; prompts travel on stdin (Claude, Codex), so this is not bounded by argv limits. */
export const DEFAULT_MAX_PROMPT_BYTES = 262_144;
const defaultMaxPrompt = DEFAULT_MAX_PROMPT_BYTES;
const secretEnvNames = /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|^ANTHROPIC_AUTH_TOKEN$)/i;

const TRUNCATION_MARKER = '[transcript truncated]';

/** Keeps at most `max` bytes, cutting on a line boundary when possible and never inside a UTF-8 sequence; appends the marker line. */
export function clampText(value: string, max: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= max) return value;
  let end = max;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  let kept = buffer.subarray(0, end);
  if (buffer[end] !== 0x0a) {
    const lastNewline = kept.lastIndexOf(0x0a);
    if (lastNewline >= 0) kept = kept.subarray(0, lastNewline);
  }
  const text = kept.toString('utf8').replace(/\r?\n$/, '');
  return `${text}\n${TRUNCATION_MARKER}`;
}

function makeRedactor(auth: Record<string, string>): (text: string) => string {
  const secrets = Object.entries(auth)
    .filter(([key, value]) => secretEnvNames.test(key) && value.length > 0)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return (input) => {
    let result = input;
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:access_token|token|key|api_key|password|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoSymlinkTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new AutosError('INVALID_INPUT', 'Provider artifact paths cannot use symlink targets');
  } catch (error) {
    if (error instanceof AutosError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AutosError('INVALID_INPUT', 'Provider artifact path is not accessible');
  }
}

async function validateArtifactPaths(request: ProviderRequest): Promise<void> {
  if (![request.cwd, request.prompt_path, request.transcript_path].every(isAbsolute)) {
    throw new AutosError('INVALID_INPUT', 'Provider workspace and artifact paths must be absolute');
  }
  let cwd: string;
  try { cwd = await realpath(request.cwd); } catch { throw new AutosError('INVALID_INPUT', 'Provider workspace is unavailable'); }
  const prompt = resolve(request.prompt_path);
  const transcript = resolve(request.transcript_path);
  if (isInside(cwd, prompt) || isInside(cwd, await canonicalDestination(prompt)) || isInside(cwd, transcript) || isInside(cwd, await canonicalDestination(transcript))) {
    throw new AutosError('POLICY', 'Prompt and transcript files must be outside the ticket workspace');
  }
  if (prompt === transcript) throw new AutosError('INVALID_INPUT', 'Prompt and transcript paths must be distinct');
  await Promise.all([assertNoSymlinkTarget(prompt), assertNoSymlinkTarget(transcript)]);
  try {
    const promptReal = await realpath(prompt);
    if (isInside(cwd, promptReal)) throw new AutosError('POLICY', 'Prompt files must be outside the ticket workspace');
    const promptInfo = await lstat(prompt);
    if (!promptInfo.isFile()) throw new AutosError('INVALID_INPUT', 'Prompt path must identify a regular file');
  } catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_INPUT', 'Prompt file is unavailable');
  }
}

async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  let parent = dirname(absolute);
  const tail: string[] = [];
  while (true) {
    try {
      const resolvedParent = await realpath(parent);
      return resolve(resolvedParent, ...tail.reverse(), absolute.slice(absolute.lastIndexOf(sep) + 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AutosError('INVALID_INPUT', 'Provider artifact path is not accessible');
      const next = dirname(parent);
      if (next === parent) throw new AutosError('INVALID_INPUT', 'Provider artifact path is not accessible');
      tail.push(parent.slice(next.length + 1));
      parent = next;
    }
  }
}

/**
 * Claude headless permissions (claude -p --help, 2.1.310). No blanket bypass flag is used:
 * - --tools restricts the built-in tool set; --allowedTools pre-approves exactly what each role may do;
 *   --permission-prompts none makes anything else an immediate denial instead of a hang.
 * - SWE: acceptEdits + Read/Grep/Glob/Edit/Write + project build/test Bash prefixes + read-only git inspection.
 *   Web tools and network/push-capable commands are denied. Commit/push belong to trusted Git code.
 * - QA/reviewer: dontAsk mode with Read/Grep/Glob only; no Edit/Write/Bash/web tools exist for the session.
 * Values are single comma-joined argv elements because these flags are variadic.
 */
const CLAUDE_SWE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash';
export const DEFAULT_SWE_BASH_PREFIXES: readonly string[] = [
  'npm', 'npx', 'node', 'pnpm', 'yarn', 'make',
  'mvn', './mvnw', 'gradle', './gradlew', 'java', 'javac',
  'ls', 'mkdir', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'git status', 'git diff', 'git log', 'git show', 'git ls-files',
];
const BASH_PREFIX_PATTERN = /^[A-Za-z0-9._/-]+(?: [A-Za-z0-9._-]+)*$/;
const CLAUDE_SWE_DISALLOWED = ['WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(curl:*)', 'Bash(wget:*)'].join(',');
const CLAUDE_READ_TOOLS = 'Read,Grep,Glob';
const CLAUDE_READ_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'].join(',');

function claudePermissionArgs(role: AgentRole, bashPrefixes: readonly string[]): string[] {
  if (role === 'swe') {
    const allowed = ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...bashPrefixes.map((prefix) => `Bash(${prefix}:*)`)].join(',');
    return ['--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--tools', CLAUDE_SWE_TOOLS, '--allowedTools', allowed, '--disallowedTools', CLAUDE_SWE_DISALLOWED];
  }
  return ['--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', CLAUDE_READ_TOOLS, '--allowedTools', CLAUDE_READ_TOOLS, '--disallowedTools', CLAUDE_READ_DISALLOWED];
}

function buildInvocation(provider: Provider, role: AgentRole, request: ProviderRequest, prompt: string, binaries: Partial<Record<Provider, string>>, bashPrefixes: readonly string[] = DEFAULT_SWE_BASH_PREFIXES): Invocation {
  const binary = binaries[provider] ?? defaults[provider];
  const modelArgs = provider === 'cursor' ? ['--model', CURSOR_MODEL] : request.model ? ['--model', request.model] : [];
  // Reasoning effort is its own argv element (never interpolated into a shell): claude `--effort <level>` (claude --help);
  // codex `-c model_reasoning_effort="<level>"` (a documented -c TOML override; the level is a validated enum, so quoting is fixed).
  // Cursor has no effort control; the request schema refuses one for it.
  const effortArgs = request.effort === undefined ? [] : provider === 'claude' ? ['--effort', request.effort] : provider === 'codex' ? ['-c', `model_reasoning_effort="${request.effort}"`] : [];
  const mayWrite = request.source_access === 'write' && role === 'swe';
  switch (provider) {
    case 'claude':
      // `claude -p` reads the prompt from stdin when no prompt argument is given (help: "[prompt]" optional,
      // --input-format text default), which avoids the per-argument argv size limit.
      return { binary, args: ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...claudePermissionArgs(role, bashPrefixes), ...modelArgs, ...effortArgs], stdin: prompt };
    case 'codex':
      // Approval policy "never" (codex exec has no -a flag; -c is documented) so a run can never block on a prompt.
      // Sandbox stays workspace-write (SWE) / read-only (others). Tradeoff: inside a container with all capabilities
      // dropped, codex's own landlock sandbox may be unavailable and commands would then fail; the only alternative,
      // --dangerously-bypass-approvals-and-sandbox, is a blanket bypass forbidden by AGENTS.md, so it is not used.
      return {
        binary,
        args: ['exec', '--json', '--ephemeral', '--cd', request.cwd, '--sandbox', mayWrite ? 'workspace-write' : 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', ...modelArgs, ...effortArgs, '-'],
        stdin: prompt,
      };
    case 'cursor':
      // cursor-agent is unused by default and not installable here, so flags are unverified against a real binary.
      // --force (allow file edits/commands in print mode) is gated to SWE only; QA/reviewer never receive it.
      return { binary, args: ['-p', '--output-format', 'stream-json', ...modelArgs, ...(mayWrite ? ['--force'] : []), '--', prompt] };
  }
}

export interface InvocationDescription {
  provider: Provider;
  role: AgentRole;
  /** Argument vector with the prompt omitted. */
  args: string[];
  prompt_delivery: 'stdin' | 'argv';
  env_opt_outs: string[];
  /** Claude SWE only: Bash allow-prefixes in effect. */
  bash_prefixes?: string[];
}

/** Diagnostics only: flag summary without prompt or workspace paths. */
export function describeInvocation(provider: Provider, role: AgentRole, options: Pick<CliAdapterOptions, 'sweBashPrefixes'> = {}): InvocationDescription {
  const prefixes = options.sweBashPrefixes ?? DEFAULT_SWE_BASH_PREFIXES;
  const request = { source_access: role === 'swe' ? 'write' : 'read', cwd: '<workspace>' } as ProviderRequest;
  const invocation = buildInvocation(provider, role, request, '<prompt>', {}, prefixes);
  const viaStdin = invocation.stdin !== undefined;
  return {
    provider,
    role,
    args: viaStdin ? [...invocation.args] : invocation.args.slice(0, -1),
    prompt_delivery: viaStdin ? 'stdin' : 'argv',
    env_opt_outs: Object.keys(providerEnvOptOuts[provider]).sort(),
    ...(provider === 'claude' && role === 'swe' ? { bash_prefixes: [...prefixes] } : {}),
  };
}

function safeEnvironment(provider: Provider, base: Record<string, string>, auth: Record<string, string>, cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (/^(PATH|LANG|LC_ALL|LC_CTYPE|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR)$/i.test(name)) env[name] = value;
  }
  const allowedAuthEnv: Record<Provider, ReadonlySet<string>> = {
    claude: new Set(['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
    codex: new Set(['HOME', 'CODEX_HOME', 'OPENAI_API_KEY']),
    cursor: new Set(['HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_API_KEY']),
  };
  for (const [name, value] of Object.entries(auth)) {
    if (!allowedAuthEnv[provider].has(name)) continue;
    env[name] = value;
  }
  // Claude Code ranks API keys above the subscription token (and always uses a key in -p mode), so a subscription run must never carry one.
  if (provider === 'claude' && env.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  Object.assign(env, providerEnvOptOuts[provider]);
  env.PWD = cwd;
  return env;
}

function terminateTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function processGroupExists(child: ChildProcess): boolean {
  if (!child.pid || process.platform === 'win32') return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

async function cleanupRemainingGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (!processGroupExists(child)) return;
  terminateTree(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (processGroupExists(child) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  if (processGroupExists(child)) terminateTree(child, 'SIGKILL');
  const killDeadline = Date.now() + 1000;
  while (processGroupExists(child) && Date.now() < killDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function execute(invocation: Invocation, request: ProviderRequest, env: Record<string, string>, options: CliAdapterOptions, signal?: AbortSignal): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? defaultMaxOutput;
  const killGrace = options.killGraceMs ?? 750;
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let outputLimit = false;
    let cancelled = signal?.aborted ?? false;
    let timedOut = false;
    let stopping = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let groupCleanup: Promise<void> | undefined;
    const spawnProcess = options.spawnProcess ?? spawn;
    let child: ChildProcess;
    let spawnErrorCode: string | undefined;
    try {
      child = spawnProcess(invocation.binary, invocation.args, {
        cwd: request.cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      resolvePromise({ code: null, signal: null, stdout, stderr, outputLimit: false, cancelled: false, timedOut: false, ...(typeof errno === 'string' ? { spawnErrorCode: errno } : {}) });
      return;
    }
    const stop = (reason: 'cancelled' | 'timeout' | 'limit') => {
      if (stopping) return;
      stopping = true;
      if (reason === 'cancelled') cancelled = true;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'limit') outputLimit = true;
      terminateTree(child, 'SIGTERM');
      escalation = setTimeout(() => terminateTree(child, 'SIGKILL'), killGrace);
      escalation.unref();
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else {
      timer = setTimeout(() => stop('timeout'), request.timeout_ms);
      timer.unref();
    }
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) { stop('limit'); return; }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    const settle = async (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { await (groupCleanup ?? cleanupRemainingGroup(child, killGrace)); }
      finally {
        if (escalation) clearTimeout(escalation);
        signal?.removeEventListener('abort', onAbort);
      }
      resolvePromise({ code, signal: exitSignal, stdout, stderr, outputLimit, cancelled, timedOut, ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }) });
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      // Only a failed launch (no pid) is classified; later stream/kill errors are ignored.
      if (child.pid) return;
      spawnErrorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      void settle(null, null);
    });
    child.on('exit', () => { groupCleanup = cleanupRemainingGroup(child, killGrace); });
    child.on('close', (code, exitSignal) => { void settle(code, exitSignal); });
    if (invocation.stdin === undefined) child.stdin?.end();
    else {
      child.stdin?.on('error', () => { /* early child exit may close stdin */ });
      child.stdin?.end(invocation.stdin);
    }
  });
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function parseJsonLines(text: string): unknown[] | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return undefined;
  const parsed: unknown[] = [];
  for (const line of lines) {
    const value = parseJson(line);
    if (value === undefined) return undefined;
    parsed.push(value);
  }
  return parsed;
}

function parseStreamObjects(text: string): (Record<string, unknown> | undefined)[] | undefined {
  const events = parseJsonLines(text);
  return events?.map(object);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

type ParseFailure = { ok: false; kind: 'invalid' | 'tool'; code?: ErrorCode };

const CONTEXT_PATTERN = /\b(?:prompt is too long|input is too long|context[_ -]length(?:[_ ]exceeded)?|(?:exceeds?|exceeded|over) (?:the |this |your )?(?:model'?s? )?(?:maximum )?(?:context (?:window|length|limit)|token limit)|maximum context|context window)\b/i;
const AUTH_PATTERN = /\b(?:unauthori[sz]ed|authentication(?:_error)?|not authenticated|not logged in|invalid[ _](?:x-)?api[ _-]?key|invalid[ _]token|login required|please run \/login)\b|\b(?:http|status|error)[:= ]{1,3}401\b/i;
const RATE_PATTERN = /\b(?:rate[ _-]?limit(?:ed|_exceeded)?|too many requests|quota exceeded|insufficient_quota|usage limit(?: reached)?|credit balance is too low|insufficient[ _]credits?|billing|payment required)\b|\b(?:http|status|error)[:= ]{1,3}(?:429|402)\b/i;
const UPSTREAM_PATTERN = /\b(?:overloaded(?:_error)?|service unavailable|bad gateway|gateway time-?out|internal server error|server_error|api_error|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network error|connection (?:error|reset|refused|timed out)|fetch failed|temporarily unavailable)\b|\b(?:http|status|error)[:= ]{1,3}5\d\d\b/i;

/** Classifies only already-extracted error signals; callers must never pass assistant narrative. */
function classifyText(text: string): 'CONTEXT' | 'AUTH' | 'RATE_LIMIT' | 'UPSTREAM' | 'TOOL' {
  if (CONTEXT_PATTERN.test(text)) return 'CONTEXT';
  if (AUTH_PATTERN.test(text)) return 'AUTH';
  if (RATE_PATTERN.test(text)) return 'RATE_LIMIT';
  if (UPSTREAM_PATTERN.test(text)) return 'UPSTREAM';
  return 'TOOL';
}

function statusSignal(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? `HTTP ${value}` : '';
}

/** Collects structured error fields (message/code/type/status) from an envelope or event. */
function errorSignals(record: Record<string, unknown> | undefined): string {
  if (!record) return '';
  const nested = object(record.error);
  const parts: unknown[] = [record.message, record.code, record.error_code, nested?.message, nested?.code, nested?.type, typeof record.error === 'string' ? record.error : undefined];
  const strings = parts.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 2000));
  return [...strings, statusSignal(record.api_error_status), statusSignal(record.status), statusSignal(record.status_code), statusSignal(nested?.status)].filter(Boolean).join('\n');
}

function claudeLikeFailure(envelope: Record<string, unknown>): string {
  const resultText = typeof envelope.result === 'string' ? envelope.result.slice(0, 2000) : '';
  const errors = Array.isArray(envelope.errors) ? envelope.errors.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 500)).join('\n') : '';
  return [errorSignals(envelope), resultText, errors].filter(Boolean).join('\n');
}

function codexFailure(events: (Record<string, unknown> | undefined)[]): string {
  return events
    .filter((event) => event?.type === 'turn.failed' || event?.type === 'turn.error' || event?.type === 'error')
    .map(errorSignals)
    .join('\n');
}

/**
 * Claude/Cursor print mode emits either one result object (`--output-format json`, older fakes) or a
 * stream-json event sequence whose final line is the result envelope. Returns that envelope only when it
 * is the last non-blank line, so a stale mid-stream result can never be mistaken for the outcome.
 */
function resultEnvelope(output: string): Record<string, unknown> | undefined {
  const whole = object(parseJson(output));
  if (whole) return whole;
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  return last === undefined ? undefined : object(parseJson(last));
}

function parseProviderOutput(provider: Provider, output: string): { ok: true; result: unknown } | ParseFailure {
  if (provider === 'claude' || provider === 'cursor') {
    const envelope = resultEnvelope(output);
    if (!envelope || envelope.type !== 'result' || typeof envelope.subtype !== 'string') return { ok: false, kind: 'invalid' };
    if (envelope.subtype !== 'success' || envelope.is_error === true) return { ok: false, kind: 'tool', code: classifyText(claudeLikeFailure(envelope)) };
    if (!Object.hasOwn(envelope, 'result') || (typeof envelope.result !== 'string' && typeof envelope.result !== 'object')) return { ok: false, kind: 'invalid' };
    return { ok: true, result: envelope.result };
  }
  const events = parseJsonLines(output);
  if (!events) return { ok: false, kind: 'invalid' };
  const eventObjects = events.map(object);
  if (eventObjects.some((event) => event?.type === 'turn.failed' || event?.type === 'turn.error' || event?.type === 'error')) return { ok: false, kind: 'tool', code: classifyText(codexFailure(eventObjects)) };
  const failedCommand = eventObjects.some((event) => {
    if (event?.type !== 'item.completed') return false;
    const item = object(event.item);
    if (item?.type !== 'command_execution') return false;
    return (typeof item.exit_code === 'number' && item.exit_code !== 0) || (typeof item.status === 'string' && !['completed', 'succeeded'].includes(item.status));
  });
  if (failedCommand) return { ok: false, kind: 'tool' };
  const terminal = eventObjects.findLast((event) => event?.type === 'turn.completed');
  if (!terminal) return { ok: false, kind: 'invalid' };
  if (eventObjects.at(-1) !== terminal) return { ok: false, kind: 'invalid' };
  const turn = object(terminal.turn);
  if (turn && turn.status !== 'completed') return { ok: false, kind: 'tool' };
  const messages = eventObjects
    .filter((event) => event?.type === 'item.completed')
    .map((event) => object(event?.item))
    .filter((item) => item?.type === 'agent_message')
    .map((item) => item?.text)
    .filter((value): value is string => typeof value === 'string');
  if (!messages.length) return { ok: false, kind: 'invalid' };
  const terminalIndex = eventObjects.lastIndexOf(terminal);
  const finalMessageIndex = eventObjects.findLastIndex((event) => event?.type === 'item.completed' && object(event.item)?.type === 'agent_message');
  if (finalMessageIndex < 0 || finalMessageIndex >= terminalIndex) return { ok: false, kind: 'invalid' };
  return { ok: true, result: messages.at(-1) };
}

/**
 * Non-zero exit classification. Structured error signals from the provider envelope (never assistant
 * narrative) plus stderr are inspected; unparseable stdout is treated as error text only when no
 * envelope could be read.
 */
function classifyExit(provider: Provider, stdout: string, stderr: string): ErrorCode {
  let signals = '';
  if (provider === 'codex') {
    const events = parseJsonLines(stdout);
    signals = events ? codexFailure(events.map(object)) : stdout.slice(0, 4000);
  } else {
    const envelope = resultEnvelope(stdout);
    const streamed = parseStreamObjects(stdout);
    // Never classify raw stream lines (assistant narrative); only structured result/error events.
    signals = envelope?.type === 'result'
      ? (envelope.is_error === true || envelope.subtype !== 'success' ? claudeLikeFailure(envelope) : '')
      : streamed ? streamed.filter((event) => event?.type === 'error').map(errorSignals).join('\n') : stdout.slice(0, 4000);
  }
  const fromStructured = signals ? classifyText(signals) : 'TOOL';
  return fromStructured !== 'TOOL' ? fromStructured : classifyText(stderr.slice(0, 8000));
}

/**
 * Provider limit reset time, read ONLY from trusted structured fields of structured stdout events. Assistant
 * messages, agent_message/reasoning items, tool results and stderr are never inspected. Supported:
 * - claude/cursor stream-json: `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":..}}`
 *   (also `resets_at`; any other status is ignored), plus `type:"result"` envelopes and `type:"error"` events.
 * - codex exec --json: `type` `error`, `turn.failed` or `turn.error` events.
 * For result/error events the event itself, its `error` object and `error.error` are checked for absolute fields
 * `resetsAt` / `resets_at` (epoch seconds, epoch milliseconds when > 1e12, numeric strings, or Date-parseable
 * strings) and relative-seconds fields `resets_in_seconds` / `retry_after_seconds` / `retry_after` (a non-numeric
 * `retry_after` string is read as an HTTP date). Only values within (now, now + 7 days] count; the earliest wins.
 */
const RESET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_LINE_HINT = /resets|retry_after/i;
const ABSOLUTE_RESET_FIELDS = ['resetsAt', 'resets_at'] as const;
const RELATIVE_RESET_FIELDS = ['resets_in_seconds', 'retry_after_seconds', 'retry_after'] as const;

function absoluteResetMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return absoluteResetMs(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function relativeResetMs(value: unknown, nowMs: number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? nowMs + value * 1000 : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return relativeResetMs(Number(value), nowMs);
  return undefined;
}

function resetCandidates(source: Record<string, unknown> | undefined, nowMs: number, allowRetryAfterDate: boolean): number[] {
  if (!source) return [];
  const found: number[] = [];
  for (const key of ABSOLUTE_RESET_FIELDS) {
    const value = absoluteResetMs(source[key]);
    if (value !== undefined) found.push(value);
  }
  for (const key of RELATIVE_RESET_FIELDS) {
    const raw = source[key];
    const value = relativeResetMs(raw, nowMs) ?? (allowRetryAfterDate && key === 'retry_after' && typeof raw === 'string' && raw.length <= 64 && !/^\d/.test(raw) ? absoluteResetMs(raw) : undefined);
    if (value !== undefined) found.push(value);
  }
  return found;
}

function errorEventCandidates(event: Record<string, unknown>, nowMs: number): number[] {
  const nested = object(event.error);
  return [...resetCandidates(event, nowMs, true), ...resetCandidates(nested, nowMs, true), ...resetCandidates(object(nested?.error), nowMs, true)];
}

export function extractRateLimitReset(provider: Provider, stdout: string, now: Date): string | undefined {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return undefined;
  let earliest: number | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{') || !RESET_LINE_HINT.test(line)) continue;
    const event = object(parseJson(line));
    if (!event || typeof event.type !== 'string') continue;
    let candidates: number[] = [];
    if (provider === 'codex') {
      if (event.type === 'error' || event.type === 'turn.failed' || event.type === 'turn.error') candidates = errorEventCandidates(event, nowMs);
    } else if (event.type === 'rate_limit_event') {
      const info = object(event.rate_limit_info);
      if (info?.status === 'rejected') candidates = ABSOLUTE_RESET_FIELDS.map((key) => absoluteResetMs(info[key])).filter((value): value is number => value !== undefined);
    } else if (event.type === 'result' || event.type === 'error') {
      candidates = errorEventCandidates(event, nowMs);
    }
    for (const candidate of candidates) {
      if (candidate > nowMs && candidate <= nowMs + RESET_WINDOW_MS && (earliest === undefined || candidate < earliest)) earliest = candidate;
    }
  }
  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}

const UNAVAILABLE_SPAWN_CODES =new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'ENOEXEC', 'EISDIR', 'EPERM']);

function resultRecord(request: ProviderRequest, result: Omit<ProviderResult, 'provider' | 'role' | 'transcript_path' | 'model'>): ProviderResult {
  const { error_code, ...rest } = result;
  const candidate: ProviderResult = {
    provider: request.provider,
    role: request.role,
    transcript_path: request.transcript_path,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...rest,
    ...(error_code === undefined ? {} : { error_code }),
  };
  return providerResultSchema.parse(candidate) as ProviderResult;
}

async function writeTranscript(path: string, text: string, limit: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertNoSymlinkTarget(path);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(clampText(text, limit), 'utf8'); } finally { await file.close(); }
}

async function readPromptBounded(path: string, maxBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new AutosError('INVALID_INPUT', 'Provider prompt exceeds the configured size limit');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, maxBytes + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new AutosError('INVALID_INPUT', 'Provider prompt exceeds the configured size limit');
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof AutosError) throw error;
    throw new AutosError('INVALID_INPUT', 'Provider prompt file is unavailable');
  } finally {
    await handle?.close();
  }
}

function validateOptions(options: CliAdapterOptions): void {
  if (options.sweBashPrefixes && (options.sweBashPrefixes.length === 0 || !options.sweBashPrefixes.every((prefix) => BASH_PREFIX_PATTERN.test(prefix)))) {
    throw new AutosError('INVALID_CONFIG', 'SWE Bash prefixes must be non-empty command prefixes without shell metacharacters');
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new AutosError('INVALID_CONFIG', 'Provider adapter clock must be a function');
  const positive = [options.maxOutputBytes, options.maxTranscriptBytes, options.maxPromptBytes, options.killGraceMs]
    .filter((value): value is number => value !== undefined);
  if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new AutosError('INVALID_CONFIG', 'Provider adapter limits must be positive integers');
  if ((options.maxOutputBytes ?? defaultMaxOutput) > 100_000_000 || (options.maxTranscriptBytes ?? defaultMaxTranscript) > MAX_TRANSCRIPT_BYTES_LIMIT || (options.maxPromptBytes ?? defaultMaxPrompt) > 10_000_000 || (options.killGraceMs ?? 750) > 60_000) {
    throw new AutosError('INVALID_CONFIG', 'Provider adapter limits exceed supported bounds');
  }
}

export class CliProviderAdapter implements ProviderAdapterPort {
  private readonly options: CliAdapterOptions;
  private readonly provider: Provider;

  constructor(provider: Provider, options: CliAdapterOptions = {}) {
    validateOptions(options);
    this.provider = provider;
    this.options = options;
  }

  async run(untrustedRequest: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const parsedRequest = providerRequestSchema.parse(untrustedRequest);
    const { model, effort, ...requestBase } = parsedRequest;
    const request: ProviderRequest = { ...requestBase, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
    if (request.provider !== this.provider) throw new AutosError('INVALID_INPUT', 'Provider request does not match adapter');
    if (request.provider === 'cursor') {
      if (request.model !== undefined && request.model !== CURSOR_MODEL) throw new AutosError('INVALID_INPUT', 'Cursor supports only model "auto"');
      request.model = CURSOR_MODEL;
    }
    await validateArtifactPaths(request);
    const start = performance.now();
    if (signal?.aborted) {
      return await this.finish(request, start, { status: 'CANCELLED', exit_code: null, elapsed_ms: 0, result: null, error_code: 'CANCELLED' }, '[cancelled before launch]');
    }
    const prompt = await readPromptBounded(request.prompt_path, this.options.maxPromptBytes ?? defaultMaxPrompt);
    let auth: Record<string, string> = {};
    try {
      auth = await this.options.resolveAuth?.(request.auth_profile, this.provider) ?? {};
      if (!Object.entries(auth).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === 'string')) {
        throw new Error('invalid auth profile');
      }
    } catch {
      return await this.finish(request, start, { status: 'FAILED', exit_code: null, elapsed_ms: performance.now() - start, result: null, error_code: 'AUTH' }, '[auth profile unavailable]');
    }
    if (signal?.aborted) return await this.finish(request, start, { status: 'CANCELLED', exit_code: null, elapsed_ms: performance.now() - start, result: null, error_code: 'CANCELLED' }, '[cancelled before launch]');
    const invocation = buildInvocation(this.provider, request.role, request, prompt, this.options.binaries ?? {}, this.options.sweBashPrefixes ?? DEFAULT_SWE_BASH_PREFIXES);
    const processResult = await execute(invocation, request, safeEnvironment(this.provider, this.options.baseEnv ?? { PATH: process.env.PATH ?? '' }, auth, resolve(request.cwd)), this.options, signal);
    const redact = makeRedactor(auth);
    const transcript = redact(processResult.stdout + (processResult.stderr ? `\n[stderr]\n${processResult.stderr}` : ''));
    const elapsed = performance.now() - start;
    if (processResult.spawnErrorCode !== undefined) {
      const unavailable = UNAVAILABLE_SPAWN_CODES.has(processResult.spawnErrorCode);
      return await this.finish(request, start, { status: 'FAILED', exit_code: null, elapsed_ms: elapsed, result: null, error_code: unavailable ? 'UNAVAILABLE' : 'TOOL' }, unavailable ? '[provider executable unavailable]' : '[provider failed to start]');
    }
    if (processResult.timedOut) return await this.finish(request, start, { status: 'TIMED_OUT', exit_code: processResult.code, elapsed_ms: elapsed, result: null, error_code: 'TIMEOUT' }, transcript);
    if (processResult.cancelled) return await this.finish(request, start, { status: 'CANCELLED', exit_code: processResult.code, elapsed_ms: elapsed, result: null, error_code: 'CANCELLED' }, transcript);
    if (processResult.outputLimit) return await this.finish(request, start, { status: 'FAILED', exit_code: processResult.code, elapsed_ms: elapsed, result: null, error_code: 'TOOL' }, '[provider output limit exceeded]');
    if (processResult.code !== 0) {
      const code = classifyExit(this.provider, processResult.stdout, processResult.stderr);
      return await this.finish(request, start, { status: 'FAILED', exit_code: processResult.code, elapsed_ms: elapsed, result: null, error_code: code, ...this.retryAt(code, processResult.stdout) }, transcript);
    }
    const parsed = parseProviderOutput(this.provider, processResult.stdout);
    if (!parsed.ok) {
      const code = parsed.kind === 'tool' ? parsed.code ?? 'TOOL' : 'INVALID_OUTPUT';
      return await this.finish(request, start, { status: 'FAILED', exit_code: 0, elapsed_ms: elapsed, result: null, error_code: code, ...this.retryAt(code, processResult.stdout) }, transcript);
    }
    return await this.finish(request, start, { status: 'SUCCEEDED', exit_code: 0, elapsed_ms: elapsed, result: redactValue(parsed.result, redact) }, transcript);
  }

  /** RATE_LIMIT only: provider-reported reset time from structured stdout events; never raw output. */
  private retryAt(code: ErrorCode, stdout: string): { retry_at?: string } {
    if (code !== 'RATE_LIMIT') return {};
    let now: Date;
    try { now = (this.options.now ?? (() => new Date()))(); } catch { return {}; }
    if (!(now instanceof Date)) return {};
    const retryAt = extractRateLimitReset(this.provider, stdout, now);
    return retryAt === undefined ? {} : { retry_at: retryAt };
  }

  private async finish(request: ProviderRequest, started: number, fields: Omit<ProviderResult, 'provider' | 'role' | 'transcript_path' | 'model'>, transcript: string): Promise<ProviderResult> {
    try {
      await writeTranscript(request.transcript_path, transcript, this.options.maxTranscriptBytes ?? defaultMaxTranscript);
    } catch {
      if (fields.status === 'SUCCEEDED') {
        return resultRecord(request, { status: 'FAILED', exit_code: fields.exit_code, elapsed_ms: performance.now() - started, result: null, error_code: 'TOOL' });
      }
    }
    return resultRecord(request, { ...fields, elapsed_ms: performance.now() - started });
  }
}

export function createProviderAdapters(options: CliAdapterOptions = {}): Record<Provider, CliProviderAdapter> {
  return {
    claude: new CliProviderAdapter('claude', options),
    codex: new CliProviderAdapter('codex', options),
    cursor: new CliProviderAdapter('cursor', options),
  };
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact));
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [redact(key), redactValue(entry, redact)]));
}

export { parseProviderOutput, buildInvocation };
