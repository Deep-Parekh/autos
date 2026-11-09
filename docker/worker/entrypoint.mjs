import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CliProviderAdapter } from '@autos/cli-adapters';
import { ERROR_CODES } from '@autos/contracts';

const DEFAULT_TIMEOUT_MS = 3_600_000;
const MAX_TIMEOUT_MS = 86_400_000;
const DEFAULT_MAX_PROMPT_BYTES = 262_144;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 5_242_880;

/** Reads a positive integer from the environment; empty values count as unset. Throws a safe INVALID_INPUT error otherwise. */
function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${name} is invalid`);
    error.code = 'INVALID_INPUT';
    throw error;
  }
  return parsed;
}

/** Only contract error codes are surfaced; messages and stacks never leave the worker. */
function safeErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (typeof code === 'string' && ERROR_CODES.includes(code)) return code;
  if (error && typeof error === 'object' && error.name === 'ZodError') return 'INVALID_INPUT';
  if (error && typeof error === 'object' && ['ENOENT', 'EACCES', 'EPERM'].includes(code) && error.syscall === 'spawn') return 'UNAVAILABLE';
  return 'TOOL';
}

let invocation = {};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || Object.hasOwn(args, key.slice(2))) throw new Error('invalid request');
    args[key.slice(2)] = value;
  }
  return args;
}

/** Tomcat needs a writable CATALINA_BASE; the read-only CATALINA_HOME/conf is copied in (symlinks are copied as links, never followed). */
async function prepareCatalinaBase() {
  const home = process.env.CATALINA_HOME;
  const base = process.env.CATALINA_BASE;
  if (!home || !base) return;
  for (const directory of ['conf', 'logs', 'temp', 'work', 'webapps']) await mkdir(join(base, directory), { recursive: true });
  await cp(join(home, 'conf'), join(base, 'conf'), { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  invocation = { provider: args.provider, role: args.role, model: args.model, transcript: args.transcript };
  if (!['claude', 'codex', 'cursor'].includes(args.provider) || !['swe', 'qa', 'reviewer'].includes(args.role) || !args.prompt || !args.transcript || !args['auth-profile']) throw new Error('invalid request');
  const authNames = {
    claude: ['HOME', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
    codex: ['HOME', 'OPENAI_API_KEY', 'CODEX_HOME'],
    cursor: ['HOME', 'CURSOR_API_KEY', 'CURSOR_CONFIG_DIR'],
  };
  await prepareCatalinaBase();
  const timeoutMs = envInteger('AUTOS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const maxPromptBytes = envInteger('AUTOS_MAX_PROMPT_BYTES', DEFAULT_MAX_PROMPT_BYTES, 1_024, 10_000_000);
  const maxTranscriptBytes = envInteger('AUTOS_MAX_TRANSCRIPT_BYTES', DEFAULT_MAX_TRANSCRIPT_BYTES, 65_536, 52_428_800);
  const adapter = new CliProviderAdapter(args.provider, {
    // This worker always runs in the hardened Autos container, which is the command boundary for Codex
    // (Codex's own bubblewrap sandbox cannot create user namespaces under Docker's default seccomp profile).
    codexSandbox: 'container',
    maxPromptBytes,
    maxTranscriptBytes,
    resolveAuth: async (_profile, provider) => Object.fromEntries(authNames[provider].filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
  });
  const result = await adapter.run({
    job_id: process.env.AUTOS_JOB_ID,
    issue_key: process.env.AUTOS_ISSUE_KEY,
    provider: args.provider,
    role: args.role,
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    cwd: '/workspace',
    prompt_path: args.prompt,
    transcript_path: args.transcript,
    timeout_ms: timeoutMs,
    source_access: args.role === 'swe' ? 'write' : 'read',
    auth_profile: args['auth-profile'],
  });
  process.stdout.write(`${JSON.stringify({ job_id: process.env.AUTOS_JOB_ID, issue_key: process.env.AUTOS_ISSUE_KEY, result })}\n`);
  process.exitCode = result.status === 'SUCCEEDED' ? 0 : 1;
}

main().catch((error) => {
  const code = safeErrorCode(error);
  const valid = ['claude', 'codex', 'cursor'].includes(invocation.provider) && ['swe', 'qa', 'reviewer'].includes(invocation.role) && typeof invocation.transcript === 'string';
  if (valid && process.env.AUTOS_JOB_ID && process.env.AUTOS_ISSUE_KEY) {
    process.stdout.write(`${JSON.stringify({
      job_id: process.env.AUTOS_JOB_ID,
      issue_key: process.env.AUTOS_ISSUE_KEY,
      result: {
        provider: invocation.provider, role: invocation.role, status: 'FAILED', exit_code: 1, elapsed_ms: 0,
        transcript_path: invocation.transcript, result: null, error_code: code,
        ...(invocation.model ? { model: invocation.model } : {}),
      },
    })}\n`);
  }
  process.stderr.write(`worker failed: ${code}\n`);
  process.exitCode = 1;
});
