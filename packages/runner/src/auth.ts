import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AutosError, PROVIDER_AUTH_MODES } from '@autos/contracts';
import type { ProviderAuthMode, ProviderAuthSummary } from '@autos/contracts';

/**
 * One provider profile entry as parsed from provider-profiles.json (`mode` is required).
 * Only codex/subscription uses `directory`: a `codex login` directory that is staged per run, never mounted.
 */
export interface ProviderAuthProfile { mode: ProviderAuthMode; env?: Record<string, string>; directory?: string }
export type AuthProvider = ProviderAuthSummary['provider'];

export const AUTH_PROVIDERS = ['claude', 'codex', 'cursor'] as const satisfies readonly AuthProvider[];
export const CODEX_AUTH_FILE = 'auth.json';
/** Runner-generated Codex config for the staged CODEX_HOME. Forces the ChatGPT (subscription) login and a file credential store. */
export const CODEX_STAGED_CONFIG = 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n';

const envName = /^[A-Z][A-Z0-9_]{0,127}$/;
const envValue = /^[^\0\r\n]{1,8192}$/;
const MAX_AUTH_JSON_BYTES = 1_000_000;

function refuse(subject: string, reason: string): never {
  throw new AutosError('INVALID_CONFIG', `Provider profile ${subject}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkEnv(subject: string, env: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!envName.test(name)) refuse(subject, 'environment variable names must be upper-case identifiers');
    if (!required.includes(name) && !optional.includes(name)) refuse(subject, `environment variable ${name} is not permitted in this mode`);
    if (typeof value !== 'string' || !envValue.test(value) || value.trim() === '') refuse(subject, `environment variable ${name} must be a non-empty single-line string`);
    result[name] = value;
  }
  for (const name of required) if (result[name] === undefined) refuse(subject, `environment variable ${name} is required`);
  return result;
}

/** Pure Codex auth.json rules: a JSON object with a non-empty `tokens` object and no non-empty OPENAI_API_KEY. */
export function validateCodexAuthJson(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return false;
    if (!isRecord(value.tokens) || Object.keys(value.tokens).length === 0) return false;
    const key = value.OPENAI_API_KEY;
    if (key !== undefined && key !== null && key !== '') return false;
    return true;
  } catch { return false; }
}

/** Reads a regular, non-symlink auth.json below `directory`. `private` additionally requires no group/world permission bits. */
export async function readCodexAuthFile(directory: string, options: { private: boolean }): Promise<string | undefined> {
  const path = join(directory, CODEX_AUTH_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_AUTH_JSON_BYTES) return undefined;
    if (options.private && (info.mode & 0o077) !== 0) return undefined;
    return await readFile(path, 'utf8');
  } catch { return undefined; }
}

export async function validateCodexAuthDirectory(subject: string, directory: string): Promise<void> {
  const text = await readCodexAuthFile(directory, { private: true });
  if (text === undefined) refuse(subject, 'directory must hold a regular auth.json that is not group/world accessible (chmod 600)');
  if (!validateCodexAuthJson(text)) refuse(subject, 'auth.json must be a ChatGPT login (JSON object with tokens) and must not contain an OPENAI_API_KEY');
}

/**
 * Shape rules per provider and mode. Throws INVALID_CONFIG naming `subject` and the violated rule; never echoes values.
 * Filesystem checks for the codex directory are separate (validateCodexAuthDirectory).
 */
export function validateProviderAuthProfile(subject: string, provider: string, profile: unknown, options: { requireSubscription?: boolean } = {}): ProviderAuthProfile {
  if (!isRecord(profile)) refuse(subject, 'entry must be an object');
  if (!(AUTH_PROVIDERS as readonly string[]).includes(provider)) refuse(subject, 'provider must be claude, codex or cursor');
  for (const key of Object.keys(profile)) if (!['mode', 'env', 'directory'].includes(key)) refuse(subject, 'only mode, env and directory are supported');
  const mode = profile.mode;
  if (mode === undefined) refuse(subject, `mode is required (${PROVIDER_AUTH_MODES.join(', ')})`);
  if (typeof mode !== 'string' || !(PROVIDER_AUTH_MODES as readonly string[]).includes(mode)) refuse(subject, `mode must be one of ${PROVIDER_AUTH_MODES.join(', ')}`);
  const authMode = mode as ProviderAuthMode;
  if (options.requireSubscription && authMode !== 'subscription') refuse(subject, 'mode must be subscription because AUTOS_REQUIRE_SUBSCRIPTION is set');
  if (profile.env !== undefined && !isRecord(profile.env)) refuse(subject, 'env must be an object of strings');
  if (profile.directory !== undefined && (typeof profile.directory !== 'string' || profile.directory === '' || /[\0\r\n]/.test(profile.directory))) refuse(subject, 'directory must be a non-empty relative path');
  const env = profile.env ?? {};
  const directory = profile.directory as string | undefined;
  const noDirectory = () => { if (directory !== undefined) refuse(subject, 'directory is not permitted in this mode'); };
  let checked: Record<string, string> = {};
  const key = `${provider}/${authMode}`;
  switch (key) {
    case 'claude/subscription':
      noDirectory();
      checked = checkEnv(subject, env, ['CLAUDE_CODE_OAUTH_TOKEN']);
      break;
    case 'claude/api':
      noDirectory();
      checked = checkEnv(subject, env, ['ANTHROPIC_API_KEY']);
      break;
    case 'claude/local': {
      noDirectory();
      checked = checkEnv(subject, env, ['ANTHROPIC_BASE_URL'], ['ANTHROPIC_AUTH_TOKEN']);
      let url: URL;
      try { url = new URL(checked.ANTHROPIC_BASE_URL!); } catch { refuse(subject, 'ANTHROPIC_BASE_URL must be an http or https URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') refuse(subject, 'ANTHROPIC_BASE_URL must be an http or https URL without credentials');
      break;
    }
    case 'codex/subscription':
      if (directory === undefined) refuse(subject, 'directory (a codex login directory) is required');
      if (Object.keys(env).length > 0) refuse(subject, 'env is not permitted in subscription mode');
      break;
    case 'codex/api':
      noDirectory();
      checked = checkEnv(subject, env, ['OPENAI_API_KEY']);
      break;
    case 'cursor/subscription':
      noDirectory();
      checked = checkEnv(subject, env, ['CURSOR_API_KEY']);
      break;
    default:
      refuse(subject, `${provider} mode ${authMode} is not supported yet`);
  }
  return { mode: authMode, ...(Object.keys(checked).length ? { env: checked } : {}), ...(directory === undefined ? {} : { directory }) };
}

/** Resolves a profile `directory` against the auth root; it must stay strictly inside it. */
export function resolveProfileDirectory(authRoot: string, directory: string): string {
  const resolved = resolve(authRoot, directory);
  const rel = relative(resolve(authRoot), resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AutosError('INVALID_CONFIG', 'Provider profile directory must be a subdirectory of the profile file directory');
  return resolved;
}

export interface ParsedProviderProfiles {
  profiles: Map<string, Map<AuthProvider, ProviderAuthProfile>>;
  /** Sorted by profile then provider; safe to expose (no secrets, no paths). */
  summary: ProviderAuthSummary[];
}

/**
 * Validates the whole provider-profiles.json value at supervisor startup (fail fast).
 * Shape: `{ "<profile>": { "claude"|"codex"|"cursor": { mode, env?, directory? } } }`. Codex subscription directories
 * are checked on disk (private regular auth.json). Returned directories are absolute.
 */
export async function parseProviderProfiles(value: unknown, options: { authRoot: string; requireSubscription?: boolean }): Promise<ParsedProviderProfiles> {
  if (!isRecord(value)) throw new AutosError('INVALID_CONFIG', 'Invalid provider profile file');
  const profiles: ParsedProviderProfiles['profiles'] = new Map();
  const summary: ProviderAuthSummary[] = [];
  for (const [name, providers] of Object.entries(value)) {
    if (!isRecord(providers)) throw new AutosError('INVALID_CONFIG', `Provider profile "${name}": entry must map providers to settings`);
    const entries = new Map<AuthProvider, ProviderAuthProfile>();
    for (const [provider, entry] of Object.entries(providers)) {
      const subject = `"${name}" (${provider})`;
      const parsed = validateProviderAuthProfile(subject, provider, entry, { ...(options.requireSubscription === undefined ? {} : { requireSubscription: options.requireSubscription }) });
      let directory: string | undefined;
      if (parsed.directory !== undefined) {
        try { directory = resolveProfileDirectory(options.authRoot, parsed.directory); } catch { refuse(subject, 'directory must be a subdirectory of the profile file directory'); }
        await validateCodexAuthDirectory(subject, directory);
      }
      entries.set(provider as AuthProvider, { mode: parsed.mode, ...(parsed.env ? { env: parsed.env } : {}), ...(directory === undefined ? {} : { directory }) });
      summary.push({ profile: name, provider: provider as AuthProvider, mode: parsed.mode });
    }
    profiles.set(name, entries);
  }
  summary.sort((a, b) => a.profile.localeCompare(b.profile) || a.provider.localeCompare(b.provider));
  return { profiles, summary };
}
