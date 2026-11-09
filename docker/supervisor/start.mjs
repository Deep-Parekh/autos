import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createDockerRunner, createSupervisorServer, parseProviderProfiles, shutdownSupervisor } from '@autos/runner';

const problems = [];

/** Empty strings count as unset, so `AUTOS_RUNNER_UID=` can never silently become uid 0. */
function env(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(name, { absolute = false } = {}) {
  const value = env(name);
  if (value === undefined) { problems.push(`${name} is required`); return ''; }
  if (absolute && !isAbsolute(value)) problems.push(`${name} must be an absolute path`);
  return value;
}

function optionalPath(name) {
  const value = env(name);
  if (value !== undefined && !isAbsolute(value)) problems.push(`${name} must be an absolute path`);
  return value;
}

function integer(name, fallback, { min, max }) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function size(name) {
  const value = env(name);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,5}(m|g)$/.test(value)) { problems.push(`${name} must look like 512m or 4g`); return undefined; }
  return value;
}

function cpus(name) {
  const value = env(name);
  if (value === undefined) return undefined;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value) || Number(value) <= 0 || Number(value) > 256) { problems.push(`${name} must be a positive number such as 1.5`); return undefined; }
  return value;
}

function log(record) { process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: 'autos-supervisor', ...record })}\n`); }

const socketPath = required('AUTOS_SUPERVISOR_SOCKET', { absolute: true });
const workspaceRoot = required('AUTOS_WORKSPACE_ROOT', { absolute: true });
required('AUTOS_PROMPT_ROOT', { absolute: true });
const outputRoot = required('AUTOS_OUTPUT_ROOT', { absolute: true });
const workerImage = required('AUTOS_WORKER_IMAGE');
const checksImage = required('AUTOS_CHECKS_IMAGE');
const profilesFile = required('AUTOS_PROVIDER_PROFILES_FILE', { absolute: true });
const mavenCache = optionalPath('AUTOS_MAVEN_CACHE_ROOT');
const hostRoot = optionalPath('AUTOS_HOST_ROOT') ?? process.cwd();
const clientRoot = optionalPath('AUTOS_CLIENT_ROOT') ?? '/app';
const uid = integer('AUTOS_RUNNER_UID', process.getuid?.() ?? 10001, { min: 1, max: 4_294_967_294 });
const gid = integer('AUTOS_RUNNER_GID', process.getgid?.() ?? 10001, { min: 1, max: 4_294_967_294 });
const shutdownWaitMs = integer('AUTOS_SHUTDOWN_WAIT_MS', 10_000, { min: 0, max: 120_000 });
const providerNetwork = env('AUTOS_PROVIDER_NETWORK');
const requireSubscription = env('AUTOS_REQUIRE_SUBSCRIPTION') === 'true';
if (env('AUTOS_REQUIRE_SUBSCRIPTION') !== undefined && !['true', 'false'].includes(env('AUTOS_REQUIRE_SUBSCRIPTION'))) problems.push('AUTOS_REQUIRE_SUBSCRIPTION must be true or false');
const authStagingRoot = optionalPath('AUTOS_AUTH_STAGING_ROOT');
const networkApproved = env('AUTOS_PROVIDER_NETWORK_APPROVED') === 'true';
if (providerNetwork && !networkApproved) problems.push('AUTOS_PROVIDER_NETWORK requires AUTOS_PROVIDER_NETWORK_APPROVED=true');
const limits = {
  ...(size('AUTOS_ROLE_MEMORY') ? { memory: size('AUTOS_ROLE_MEMORY') } : {}),
  ...(cpus('AUTOS_ROLE_CPUS') ? { cpus: cpus('AUTOS_ROLE_CPUS') } : {}),
  ...(size('AUTOS_CHECK_MEMORY') ? { checkMemory: size('AUTOS_CHECK_MEMORY') } : {}),
  ...(cpus('AUTOS_CHECK_CPUS') ? { checkCpus: cpus('AUTOS_CHECK_CPUS') } : {}),
  ...(env('AUTOS_PIDS_LIMIT') ? { pids: integer('AUTOS_PIDS_LIMIT', 256, { min: 16, max: 4096 }) } : {}),
  ...(size('AUTOS_TMP_SIZE') ? { tmpSize: size('AUTOS_TMP_SIZE') } : {}),
  ...(size('AUTOS_HOME_SIZE') ? { homeSize: size('AUTOS_HOME_SIZE') } : {}),
  ...(env('AUTOS_MAX_PROMPT_BYTES') ? { maxPromptBytes: integer('AUTOS_MAX_PROMPT_BYTES', 262_144, { min: 1024, max: 1_000_000 }) } : {}),
  ...(env('AUTOS_MAX_TRANSCRIPT_BYTES') ? { maxTranscriptBytes: integer('AUTOS_MAX_TRANSCRIPT_BYTES', 5_242_880, { min: 65_536, max: 52_428_800 }) } : {}),
};

if (problems.length) {
  for (const problem of problems) process.stderr.write(`autos-supervisor configuration error: ${problem}\n`);
  process.exit(2);
}

async function readProfiles(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Provider profiles must be a private regular file');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider profile file');
  return value;
}

let rawProfiles;
try { rawProfiles = await readProfiles(profilesFile); }
catch (error) {
  process.stderr.write(`autos-supervisor configuration error: ${error instanceof Error && /private regular|Invalid provider/.test(error.message) ? error.message : 'AUTOS_PROVIDER_PROFILES_FILE is unreadable or not valid JSON'}\n`);
  process.exit(2);
}
const authRoot = dirname(resolve(profilesFile));
// Validate every profile before serving anything: each needs an explicit mode and must satisfy that mode's rules.
let parsedProfiles;
try { parsedProfiles = await parseProviderProfiles(rawProfiles, { authRoot, requireSubscription }); }
catch (error) {
  process.stderr.write(`autos-supervisor configuration error: ${error && typeof error === 'object' && 'message' in error ? String(error.message) : 'invalid provider profiles'}\n`);
  process.exit(2);
}
let runner;
try {
  runner = createDockerRunner({
    workerImage,
    checksImage,
    dockerBinary: env('AUTOS_DOCKER_BINARY') ?? 'docker',
    workspaceRoot,
    authRoot,
    ...(mavenCache ? { dependencyCacheRoot: mavenCache } : {}),
    promptRoot: outputRoot,
    outputRoot,
    uid,
    gid,
    limits,
    ...(providerNetwork ? { providerNetwork: { name: providerNetwork, approved: networkApproved } } : {}),
    ...(authStagingRoot ? { authStagingRoot } : {}),
    requireSubscription,
    authSummary: parsedProfiles.summary,
    authProfiles: async (profile, provider) => {
      const selected = parsedProfiles.profiles.get(profile)?.get(provider);
      if (!selected) throw new Error('Profile not found');
      return selected;
    },
  });
} catch (error) {
  process.stderr.write(`autos-supervisor configuration error: ${error && typeof error === 'object' && 'message' in error ? String(error.message) : 'invalid runner configuration'}\n`);
  process.exit(2);
}

const server = await createSupervisorServer({ socketPath, runner, clientRoot, hostRoot, log });
log({ event: 'start', status: 'LISTENING', worker_image: workerImage, checks_image: checksImage, require_subscription: requireSubscription });
log({ event: 'auth', profiles: parsedProfiles.summary.map((entry) => `${entry.profile}/${entry.provider}/${entry.mode}`).join(',') });

let stopping = false;
const stop = (signal) => {
  if (stopping) { process.exit(1); return; }
  stopping = true;
  log({ event: 'signal', status: signal });
  void shutdownSupervisor(server, { waitMs: shutdownWaitMs }).catch(() => undefined).finally(() => process.exit(0));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
