import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { AutosError } from '@autos/contracts';
import type { ProviderRequest } from '@autos/contracts';
import { DockerRunner, DockerRunnerClient, parseProviderProfiles, validateCodexAuthJson, validateProviderAuthProfile } from '@autos/runner';
import type { DockerExecutor, DockerProcessResult, ProviderAuthProfile } from '@autos/runner';

const OAUTH = 'sk-ant-oat01-FIXTURE-subscription-token-0000';
const API = 'sk-ant-api03-FIXTURE-api-key-0000';
const CODEX_AUTH = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'a.b.c', access_token: 'at-1', refresh_token: 'rt-1' }, last_refresh: '2026-11-01T00:00:00Z' });
const CODEX_REFRESHED = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'a.b.c', access_token: 'at-2', refresh_token: 'rt-2' }, last_refresh: '2026-11-02T00:00:00Z' });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const ok = (stdout = ''): DockerProcessResult => ({ code: 0, stdout, stderr: '', timedOut: false, cancelled: false, outputLimit: false });
const JOB = 'fcd7d177-3ea7-4e3f-a005-68288ea6c9d9';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-auth-modes-')));
  roots.push(root);
  const workspaceRoot = join(root, 'workspaces');
  const outputRoot = join(root, 'outputs');
  const workspace = join(workspaceRoot, 'job');
  const invocationRoot = join(outputRoot, JOB, '_private', 'swe', 'c66cbf42-1a04-4458-832a-41b7ef6aefb3');
  const prompt = join(invocationRoot, 'input', 'prompt.md');
  const output = join(invocationRoot, 'output');
  const authRoot = join(root, 'auth');
  const staging = join(root, 'staging');
  await Promise.all([mkdir(join(workspace, '.git'), { recursive: true }), mkdir(join(invocationRoot, 'input'), { recursive: true }), mkdir(output, { recursive: true }), mkdir(authRoot, { recursive: true, mode: 0o700 }), mkdir(staging, { recursive: true, mode: 0o700 })]);
  await writeFile(prompt, 'Check source carefully');
  return { root, workspaceRoot, outputRoot, workspace, prompt, output, authRoot, staging };
}
type Paths = Awaited<ReturnType<typeof fixture>>;

const request = (paths: Paths, provider: ProviderRequest['provider'] = 'codex'): ProviderRequest => ({
  job_id: JOB, issue_key: 'AUTO-17', provider, role: 'swe', cwd: paths.workspace, prompt_path: paths.prompt,
  transcript_path: join(paths.output, 'transcript.jsonl'), timeout_ms: 30_000, source_access: 'write', auth_profile: 'team',
});

async function codexDirectory(paths: Paths, name = 'codex', content = CODEX_AUTH): Promise<string> {
  const directory = join(paths.authRoot, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'auth.json'), content, { mode: 0o600 });
  await chmod(join(directory, 'auth.json'), 0o600);
  return directory;
}

interface Seen { args: string[]; env: string; authMount?: { src: string; readonly: boolean }; staged?: { files: string[]; config: string; auth: string } }

/** Fake Docker: records the run, inspects the staged auth mount while the "container" runs and lets a hook act as the provider. */
class Executor implements DockerExecutor {
  runs: Seen[] = [];
  active = 0;
  maxActive = 0;
  /** Runs inside the fake container, with the host staging directory (if any). */
  hook?: (stagingDir: string | undefined, seen: Seen) => Promise<Partial<DockerProcessResult> | void>;
  async run(_binary: string, args: string[]): Promise<DockerProcessResult> {
    if (args[0] !== 'run') return ok();
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const envFile = args[args.indexOf('--env-file') + 1]!;
      const seen: Seen = { args, env: await readFile(envFile, 'utf8') };
      const authArg = args.find((arg) => arg.includes('dst=/run/autos/auth'));
      let stagingDir: string | undefined;
      if (authArg) {
        stagingDir = authArg.match(/src=(.*?),dst=/)![1]!;
        seen.authMount = { src: stagingDir, readonly: authArg.endsWith(',readonly') };
        seen.staged = { files: (await readdir(stagingDir)).sort(), config: await readFile(join(stagingDir, 'config.toml'), 'utf8'), auth: await readFile(join(stagingDir, 'auth.json'), 'utf8') };
      }
      this.runs.push(seen);
      const override = await this.hook?.(stagingDir, seen);
      if (override && Object.keys(override).length) return { ...ok(), ...override };
      const hostOut = args.find((arg) => arg.endsWith(',dst=/run/autos/output'))!.match(/src=(.*),dst=/)![1]!;
      const transcript = args[args.indexOf('--transcript') + 1]!;
      await writeFile(join(hostOut, transcript.split('/').at(-1)!), '{"event":"fake"}\n');
      const provider = args[args.indexOf('--provider') + 1];
      return ok(JSON.stringify({ job_id: JOB, issue_key: 'AUTO-17', result: { provider, role: 'swe', status: 'SUCCEEDED', exit_code: 0, elapsed_ms: 1, transcript_path: transcript, result: { summary: 'done' } } }));
    } finally { this.active -= 1; }
  }
}

function runner(paths: Paths, executor: Executor, profile: ProviderAuthProfile | (() => ProviderAuthProfile), extra: Partial<ConstructorParameters<typeof DockerRunner>[0]> = {}) {
  return new DockerRunner({
    workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.outputRoot, outputRoot: paths.outputRoot,
    authRoot: paths.authRoot, authStagingRoot: paths.staging, authProfiles: async () => typeof profile === 'function' ? profile() : profile, executor, testOnly: true, ...extra,
  });
}

// ---------------------------------------------------------------------------------------------------- validator rules

const refused = (provider: string, profile: unknown, pattern: RegExp, options?: { requireSubscription?: boolean }) =>
  assert.throws(() => validateProviderAuthProfile('"team" (x)', provider, profile, options), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG' && pattern.test(error.message) && !error.message.includes('FIXTURE'));
const accepted = (provider: string, profile: unknown) => validateProviderAuthProfile('"team" (x)', provider, profile);

test('every profile requires an explicit, known mode', () => {
  refused('claude', { env: { ANTHROPIC_API_KEY: API } }, /mode is required/);
  refused('claude', { mode: 'free', env: {} }, /mode must be one of/);
  refused('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API }, extra: 1 }, /only mode, env and directory/);
  refused('gemini', { mode: 'api' }, /provider must be/);
});

test('claude/subscription accepts exactly CLAUDE_CODE_OAUTH_TOKEN and refuses API keys, base URL and directories', () => {
  assert.deepEqual(accepted('claude', { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } }), { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  refused('claude', { mode: 'subscription' }, /CLAUDE_CODE_OAUTH_TOKEN is required/);
  refused('claude', { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: '' } }, /non-empty/);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    refused('claude', { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, [name]: 'https://x.invalid' } }, new RegExp(`${name} is not permitted`));
  }
  refused('claude', { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, directory: 'claude' }, /directory is not permitted/);
});

test('claude/api requires ANTHROPIC_API_KEY and refuses subscription tokens, base URL and directories', () => {
  accepted('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API } });
  refused('claude', { mode: 'api' }, /ANTHROPIC_API_KEY is required/);
  refused('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API, CLAUDE_CODE_OAUTH_TOKEN: OAUTH } }, /CLAUDE_CODE_OAUTH_TOKEN is not permitted/);
  refused('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API, ANTHROPIC_AUTH_TOKEN: 'x' } }, /ANTHROPIC_AUTH_TOKEN is not permitted/);
  refused('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API, ANTHROPIC_BASE_URL: 'https://gateway.invalid' } }, /ANTHROPIC_BASE_URL is not permitted/);
  refused('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API }, directory: 'claude' }, /directory is not permitted/);
});

test('claude/local requires a credential-free http(s) base URL and allows only an optional auth token', () => {
  accepted('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } });
  accepted('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'https://llm.internal.invalid/v1', ANTHROPIC_AUTH_TOKEN: 'local-token' } });
  refused('claude', { mode: 'local', env: { ANTHROPIC_AUTH_TOKEN: 'x' } }, /ANTHROPIC_BASE_URL is required/);
  refused('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'ftp://host.invalid' } }, /http or https/);
  refused('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'not a url' } }, /http or https/);
  refused('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'https://user:FIXTURE-pw@host.invalid' } }, /without credentials/);
  refused('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: API } }, /ANTHROPIC_API_KEY is not permitted/);
  refused('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_OAUTH_TOKEN: OAUTH } }, /CLAUDE_CODE_OAUTH_TOKEN is not permitted/);
});

test('codex and cursor mode matrix', () => {
  assert.deepEqual(accepted('codex', { mode: 'subscription', directory: 'codex' }), { mode: 'subscription', directory: 'codex' });
  refused('codex', { mode: 'subscription' }, /directory .* is required/);
  refused('codex', { mode: 'subscription', directory: 'codex', env: { OPENAI_API_KEY: 'k' } }, /env is not permitted/);
  accepted('codex', { mode: 'api', env: { OPENAI_API_KEY: 'sk-fixture' } });
  refused('codex', { mode: 'api' }, /OPENAI_API_KEY is required/);
  refused('codex', { mode: 'api', env: { OPENAI_API_KEY: 'sk-fixture' }, directory: 'codex' }, /directory is not permitted/);
  refused('codex', { mode: 'local', env: {} }, /not supported yet/);
  accepted('cursor', { mode: 'subscription', env: { CURSOR_API_KEY: 'cursor-fixture' } });
  refused('cursor', { mode: 'subscription' }, /CURSOR_API_KEY is required/);
  refused('cursor', { mode: 'subscription', env: { CURSOR_API_KEY: 'k' }, directory: 'cursor' }, /directory is not permitted/);
  refused('cursor', { mode: 'api', env: { CURSOR_API_KEY: 'k' } }, /not supported yet/);
  refused('cursor', { mode: 'local' }, /not supported yet/);
});

test('require-subscription refuses every non-subscription mode', () => {
  refused('claude', { mode: 'api', env: { ANTHROPIC_API_KEY: API } }, /AUTOS_REQUIRE_SUBSCRIPTION/, { requireSubscription: true });
  refused('claude', { mode: 'local', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }, /AUTOS_REQUIRE_SUBSCRIPTION/, { requireSubscription: true });
  refused('codex', { mode: 'api', env: { OPENAI_API_KEY: 'k' } }, /AUTOS_REQUIRE_SUBSCRIPTION/, { requireSubscription: true });
  validateProviderAuthProfile('x', 'claude', { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } }, { requireSubscription: true });
});

test('codex auth.json content rules', () => {
  assert.equal(validateCodexAuthJson(CODEX_AUTH), true);
  assert.equal(validateCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: '', tokens: { a: 1 } })), true);
  assert.equal(validateCodexAuthJson('[]'), false);
  assert.equal(validateCodexAuthJson('not json'), false);
  assert.equal(validateCodexAuthJson('{}'), false);
  assert.equal(validateCodexAuthJson(JSON.stringify({ tokens: {} })), false);
  assert.equal(validateCodexAuthJson(JSON.stringify({ tokens: 'x' })), false);
  assert.equal(validateCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: 'sk-live', tokens: { a: 1 } })), false);
});

test('parseProviderProfiles validates codex directories on disk and returns a sorted secret-free summary', async () => {
  const paths = await fixture();
  await codexDirectory(paths);
  const good = { zeta: { claude: { mode: 'api', env: { ANTHROPIC_API_KEY: API } } }, team: { codex: { mode: 'subscription', directory: 'codex' }, claude: { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } } } };
  const parsed = await parseProviderProfiles(good, { authRoot: paths.authRoot });
  assert.deepEqual(parsed.summary, [{ profile: 'team', provider: 'claude', mode: 'subscription' }, { profile: 'team', provider: 'codex', mode: 'subscription' }, { profile: 'zeta', provider: 'claude', mode: 'api' }]);
  assert.equal(parsed.profiles.get('team')?.get('codex')?.directory, join(paths.authRoot, 'codex'));
  assert.ok(!JSON.stringify(parsed.summary).includes('FIXTURE'));
  await assert.rejects(() => parseProviderProfiles(good, { authRoot: paths.authRoot, requireSubscription: true }), /"zeta" \(claude\).*AUTOS_REQUIRE_SUBSCRIPTION/);

  const codex = (directory: string) => ({ team: { codex: { mode: 'subscription', directory } } });
  await assert.rejects(() => parseProviderProfiles(codex('missing'), { authRoot: paths.authRoot }), /"team" \(codex\).*auth\.json/);
  await assert.rejects(() => parseProviderProfiles(codex('../escape'), { authRoot: paths.authRoot }), /subdirectory/);
  await assert.rejects(() => parseProviderProfiles(codex('.'), { authRoot: paths.authRoot }), /subdirectory/);
  const open = await codexDirectory(paths, 'open'); await chmod(join(open, 'auth.json'), 0o644);
  await assert.rejects(() => parseProviderProfiles(codex('open'), { authRoot: paths.authRoot }), /not group\/world accessible/);
  await codexDirectory(paths, 'withkey', JSON.stringify({ OPENAI_API_KEY: 'sk-live-FIXTURE', tokens: { a: 1 } }));
  await assert.rejects(() => parseProviderProfiles(codex('withkey'), { authRoot: paths.authRoot }), (error: unknown) => error instanceof Error && /OPENAI_API_KEY/.test(error.message) && !error.message.includes('FIXTURE'));
  await codexDirectory(paths, 'notokens', JSON.stringify({ tokens: {} }));
  await assert.rejects(() => parseProviderProfiles(codex('notokens'), { authRoot: paths.authRoot }), /tokens/);
  const linked = join(paths.authRoot, 'linked'); await mkdir(linked);
  await symlink(join(paths.authRoot, 'codex', 'auth.json'), join(linked, 'auth.json'));
  await assert.rejects(() => parseProviderProfiles(codex('linked'), { authRoot: paths.authRoot }), /regular auth\.json/);
});

// ------------------------------------------------------------------------------------------------ startup (start.mjs)

const script = resolve('docker/supervisor/start.mjs');
const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--test'));

async function startEnv(paths: Paths, profiles: unknown, extra: Record<string, string> = {}) {
  const file = join(paths.authRoot, 'provider-profiles.json');
  await writeFile(file, JSON.stringify(profiles), { mode: 0o600 });
  await chmod(file, 0o600);
  return { PATH: process.env.PATH ?? '', AUTOS_SUPERVISOR_SOCKET: join(paths.root, 's.sock'), AUTOS_WORKSPACE_ROOT: paths.workspaceRoot, AUTOS_PROMPT_ROOT: paths.outputRoot, AUTOS_OUTPUT_ROOT: paths.outputRoot, AUTOS_WORKER_IMAGE: 'w:t', AUTOS_CHECKS_IMAGE: 'c:t', AUTOS_PROVIDER_PROFILES_FILE: file, AUTOS_DOCKER_BINARY: '/bin/false', ...extra };
}
const startOnce = (env: Record<string, string>) => spawnSync(process.execPath, [...execArgv, script], { encoding: 'utf8', timeout: 20_000, env });

test('supervisor startup fails fast on a missing mode, invalid rules and AUTOS_REQUIRE_SUBSCRIPTION without echoing secrets', async () => {
  const paths = await fixture();
  const missing = startOnce(await startEnv(paths, { team: { claude: { env: { ANTHROPIC_API_KEY: API } } } }));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /"team" \(claude\).*mode is required/);
  assert.ok(!missing.stderr.includes(API) && !missing.stdout.includes(API));

  const mixed = startOnce(await startEnv(paths, { team: { claude: { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: API } } } }));
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /ANTHROPIC_API_KEY is not permitted/);
  assert.ok(!mixed.stderr.includes(API) && !mixed.stderr.includes(OAUTH));

  const apiOnly = { team: { claude: { mode: 'api', env: { ANTHROPIC_API_KEY: API } } } };
  const required = startOnce(await startEnv(paths, apiOnly, { AUTOS_REQUIRE_SUBSCRIPTION: 'true' }));
  assert.equal(required.status, 2);
  assert.match(required.stderr, /"team" \(claude\).*AUTOS_REQUIRE_SUBSCRIPTION/);
  assert.ok(!required.stderr.includes(API));

  const badFlag = startOnce(await startEnv(paths, apiOnly, { AUTOS_REQUIRE_SUBSCRIPTION: 'yes' }));
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /AUTOS_REQUIRE_SUBSCRIPTION must be true or false/);
});

test('supervisor startup logs one secret-free line of profile/provider/mode and serves health with auth summaries', async (t) => {
  const paths = await fixture();
  await codexDirectory(paths);
  const env = await startEnv(paths, { team: { codex: { mode: 'subscription', directory: 'codex' }, claude: { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } } } }, { AUTOS_REQUIRE_SUBSCRIPTION: 'true' });
  const child = spawn(process.execPath, [...execArgv, script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolvePromise) => child.once('close', resolvePromise));
  try {
    const started = await Promise.race([
      new Promise<boolean>((resolvePromise) => { const timer = setInterval(() => { if (stdout.includes('"event":"auth"')) { clearInterval(timer); resolvePromise(true); } }, 25); timer.unref(); }),
      exited.then(() => false),
    ]);
    if (!started) { if (/EPERM|EACCES/.test(stderr)) { t.skip('environment blocks Unix socket creation'); return; } assert.fail(`supervisor did not start: ${stderr}`); }
    const authLine = stdout.split('\n').find((line) => line.includes('"event":"auth"'))!;
    assert.equal(JSON.parse(authLine).profiles, 'team/claude/subscription,team/codex/subscription');
    assert.equal(JSON.parse(stdout.split('\n').find((line) => line.includes('"event":"start"'))!).require_subscription, true);
    const health = await new DockerRunnerClient({ socketPath: env.AUTOS_SUPERVISOR_SOCKET! }).health();
    assert.deepEqual(health.auth, [{ profile: 'team', provider: 'claude', mode: 'subscription' }, { profile: 'team', provider: 'codex', mode: 'subscription' }]);
    assert.equal(health.require_subscription, true);
    for (const text of [stdout, stderr, JSON.stringify(health)]) { assert.ok(!text.includes(OAUTH)); assert.ok(!text.includes(paths.authRoot)); }
  } finally { child.kill('SIGTERM'); await exited; }
});

// ------------------------------------------------------------------------------------------------------- env file contents

test('subscription claude container env holds only the OAuth token, no API key, no config dir and no auth mount', async () => {
  const paths = await fixture();
  const executor = new Executor();
  const result = await runner(paths, executor, { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } }).runRole(request(paths, 'claude'));
  assert.equal(result.status, 'SUCCEEDED');
  const seen = executor.runs[0]!;
  assert.deepEqual(seen.env.split('\n').filter(Boolean).map((line) => line.split('=')[0]).sort(), ['AUTOS_ISSUE_KEY', 'AUTOS_JOB_ID', 'AUTOS_MAX_PROMPT_BYTES', 'AUTOS_MAX_TRANSCRIPT_BYTES', 'AUTOS_TIMEOUT_MS', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME']);
  assert.ok(!/ANTHROPIC|CLAUDE_CONFIG_DIR/.test(seen.env));
  assert.equal(seen.authMount, undefined, 'a claude auth directory is never mounted (a stale .credentials.json would shadow the token)');
  assert.ok(!seen.args.join(' ').includes(OAUTH), 'token never reaches docker argv');
  assert.ok(!JSON.stringify(result).includes(OAUTH));
});

test('api and local modes write only their own variables', async () => {
  const paths = await fixture();
  const executor = new Executor();
  await runner(paths, executor, { mode: 'api', env: { ANTHROPIC_API_KEY: API } }).runRole(request(paths, 'claude'));
  assert.match(executor.runs[0]!.env, /ANTHROPIC_API_KEY=/);
  assert.ok(!/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_BASE_URL/.test(executor.runs[0]!.env));
  await runner(paths, executor, { mode: 'local', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } }).runRole(request(paths, 'claude'));
  assert.ok(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:11434/.test(executor.runs[1]!.env) && !/ANTHROPIC_API_KEY|OAUTH/.test(executor.runs[1]!.env));
  await runner(paths, executor, { mode: 'subscription', env: { CURSOR_API_KEY: 'cursor-fixture' } }).runRole(request(paths, 'cursor'));
  assert.match(executor.runs[2]!.env, /CURSOR_API_KEY=cursor-fixture/);
  assert.ok(!executor.runs.some((seen) => seen.args.join(' ').includes(API) || seen.args.join(' ').includes('cursor-fixture')));
});

test('the runner re-validates every profile per run and refuses invalid, mode-less or non-subscription profiles', async () => {
  const paths = await fixture();
  const executor = new Executor();
  const authError = (error: unknown) => error instanceof AutosError && error.code === 'AUTH' && !error.message.includes('FIXTURE');
  await assert.rejects(() => runner(paths, executor, { env: { ANTHROPIC_API_KEY: API } } as never).runRole(request(paths, 'claude')), authError);
  await assert.rejects(() => runner(paths, executor, { mode: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: API } }).runRole(request(paths, 'claude')), authError);
  await assert.rejects(() => runner(paths, executor, { mode: 'api', env: { ANTHROPIC_API_KEY: API } }, { requireSubscription: true }).runRole(request(paths, 'claude')), authError);
  await assert.rejects(() => runner(paths, executor, { mode: 'subscription', env: { OPENAI_API_KEY: 'sk-x' } }).runRole(request(paths, 'codex')), authError);
  assert.equal(executor.runs.length, 0, 'no container is started for an invalid profile');
});

// ------------------------------------------------------------------------------------------------------- codex staging

test('codex subscription mounts a private staging directory read-write, never the profile directory', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const executor = new Executor();
  const result = await runner(paths, executor, { mode: 'subscription', directory }).runRole(request(paths));
  assert.equal(result.status, 'SUCCEEDED');
  const seen = executor.runs[0]!;
  assert.ok(seen.authMount && !seen.authMount.readonly, 'staging mount is read-write');
  assert.notEqual(seen.authMount.src, directory);
  assert.ok(seen.authMount.src.startsWith(`${paths.staging}/`), 'staging lives under the configured staging root');
  assert.ok(!seen.args.some((arg) => arg.includes(directory)), 'the profile directory is never in the docker command');
  assert.deepEqual(seen.staged!.files, ['auth.json', 'config.toml']);
  assert.equal(seen.staged!.config, 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n');
  assert.equal(seen.staged!.auth, CODEX_AUTH);
  assert.match(seen.env, /CODEX_HOME=\/run\/autos\/auth/);
  assert.ok(!/OPENAI_API_KEY/.test(seen.env), 'no API key variable in subscription mode');
  assert.ok(!seen.args.join(' ').includes('rt-1'));
  assert.deepEqual(await readdir(paths.staging), [], 'staging removed after the run');
  assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), CODEX_AUTH, 'unchanged login is not rewritten');
});

test('refreshed codex login is written back atomically with mode 0600; other staged files are discarded', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const executor = new Executor();
  executor.hook = async (dir) => {
    await writeFile(join(dir!, 'auth.json'), CODEX_REFRESHED);
    await writeFile(join(dir!, 'config.toml'), 'model = "tampered"\n');
    await mkdir(join(dir!, 'sessions'));
    await writeFile(join(dir!, 'sessions', 'log.jsonl'), 'session data');
  };
  await runner(paths, executor, { mode: 'subscription', directory }).runRole(request(paths));
  assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), CODEX_REFRESHED);
  assert.equal((await stat(join(directory, 'auth.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), ['auth.json'], 'no temp, config.toml or session files land in the profile directory');
  assert.deepEqual(await readdir(paths.staging), []);
});

test('invalid staged auth.json (API key, empty tokens, garbage, symlink) is never copied back', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const bad: ((dir: string) => Promise<void>)[] = [
    async (dir) => { await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-live-FIXTURE', tokens: { a: 1 } })); },
    async (dir) => { await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: {} })); },
    async (dir) => { await writeFile(join(dir, 'auth.json'), 'garbage'); },
    async (dir) => { await rm(join(dir, 'auth.json')); await symlink(join(paths.root, 'elsewhere.json'), join(dir, 'auth.json')); await writeFile(join(paths.root, 'elsewhere.json'), CODEX_REFRESHED); },
  ];
  for (const mutate of bad) {
    const executor = new Executor();
    executor.hook = async (dir) => { await mutate(dir!); };
    await runner(paths, executor, { mode: 'subscription', directory }).runRole(request(paths));
    assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), CODEX_AUTH);
    assert.deepEqual(await readdir(paths.staging), []);
  }
});

test('staging is removed and a refreshed login still persisted after failure, timeout and cancellation', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const outcomes: Partial<DockerProcessResult>[] = [
    { code: 1, stdout: 'not json' },
    { code: null, timedOut: true },
    { code: null, cancelled: true },
  ];
  for (const [index, outcome] of outcomes.entries()) {
    const executor = new Executor();
    const refreshed = JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: `rt-after-${index}` } });
    executor.hook = async (dir) => { await writeFile(join(dir!, 'auth.json'), refreshed); return outcome; };
    const result = await runner(paths, executor, { mode: 'subscription', directory }).runRole(request(paths));
    assert.notEqual(result.status, 'SUCCEEDED');
    assert.deepEqual(await readdir(paths.staging), [], `staging removed (outcome ${index})`);
    assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), refreshed, `refresh persisted (outcome ${index})`);
  }
  const throwing = new Executor();
  throwing.hook = async () => { throw new Error('executor exploded'); };
  await assert.rejects(() => runner(paths, throwing, { mode: 'subscription', directory }).runRole(request(paths)));
  assert.deepEqual(await readdir(paths.staging), []);
});

test('concurrent runs sharing one codex login are serialized and see each other refreshed token', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const executor = new Executor();
  const seenAuth: string[] = [];
  let counter = 0;
  executor.hook = async (dir) => {
    seenAuth.push(await readFile(join(dir!, 'auth.json'), 'utf8'));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    counter += 1;
    await writeFile(join(dir!, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: `rt-run-${counter}` } }));
  };
  const instance = runner(paths, executor, { mode: 'subscription', directory });
  const other = runner(paths, executor, { mode: 'subscription', directory });
  const results = await Promise.all([instance.runRole(request(paths)), other.runRole(request(paths)), instance.runRole(request(paths))]);
  assert.ok(results.every((result) => result.status === 'SUCCEEDED'));
  assert.equal(executor.maxActive, 1, 'never two containers on the same login at once');
  assert.deepEqual(seenAuth.map((text) => (JSON.parse(text) as { tokens: { refresh_token: string } }).tokens.refresh_token), ['rt-1', 'rt-run-1', 'rt-run-2']);
  assert.match(await readFile(join(directory, 'auth.json'), 'utf8'), /rt-run-3/);
});

test('a waiter whose signal aborts while queued on the login lock is cancelled without a container', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const executor = new Executor();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  executor.hook = async () => { await gate; };
  const instance = runner(paths, executor, { mode: 'subscription', directory });
  const first = instance.runRole(request(paths));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  const controller = new AbortController();
  const second = instance.runRole(request(paths), controller.signal);
  controller.abort();
  assert.equal((await second).status, 'CANCELLED');
  release();
  assert.equal((await first).status, 'SUCCEEDED');
  assert.equal(executor.runs.length, 1);
  const third = await instance.runRole(request(paths));
  assert.equal(third.status, 'SUCCEEDED', 'lock is released after an abandoned waiter');
});

test('staging refuses a directory inside the workspace/output roots and invalid profile logins', async () => {
  const paths = await fixture();
  const directory = await codexDirectory(paths);
  const executor = new Executor();
  await assert.rejects(() => runner(paths, executor, { mode: 'subscription', directory }, { authStagingRoot: join(paths.outputRoot, 'staging') }).runRole(request(paths)), (error: unknown) => error instanceof AutosError && error.code === 'POLICY');
  assert.equal(executor.runs.length, 0);
  await chmod(join(directory, 'auth.json'), 0o644);
  await assert.rejects(() => runner(paths, executor, { mode: 'subscription', directory }).runRole(request(paths)), (error: unknown) => error instanceof AutosError && error.code === 'AUTH');
  assert.equal(executor.runs.length, 0);
  assert.deepEqual(await readdir(paths.staging), []);
});

// ------------------------------------------------------------------------------------------------------------- health

test('runner health reports sorted profile/provider/mode summaries and nothing else', async () => {
  const paths = await fixture();
  const instance = new DockerRunner({
    workerImage: 'worker:test', checksImage: 'checks:test', workspaceRoot: paths.workspaceRoot, promptRoot: paths.outputRoot, outputRoot: paths.outputRoot, executor: new Executor(), testOnly: true,
    requireSubscription: true,
    authSummary: [{ profile: 'b', provider: 'codex', mode: 'subscription' }, { profile: 'a', provider: 'cursor', mode: 'subscription' }, { profile: 'a', provider: 'claude', mode: 'api', env: { ANTHROPIC_API_KEY: API }, directory: paths.authRoot } as never],
  });
  const health = await instance.health();
  assert.deepEqual(health, { status: 'ready', version: 1, docker: 'test-only', require_subscription: true, auth: [{ profile: 'a', provider: 'claude', mode: 'api' }, { profile: 'a', provider: 'cursor', mode: 'subscription' }, { profile: 'b', provider: 'codex', mode: 'subscription' }] });
  assert.ok(!JSON.stringify(health).includes(API) && !JSON.stringify(health).includes(paths.authRoot));
});

test('the socket client passes auth health through, tolerates older supervisors and rejects malformed auth data', async (t) => {
  const paths = await fixture();
  const socketPath = join(paths.root, 'h.sock');
  let body: unknown = { status: 'ready', version: 1, docker: 'available' };
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  try { await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(socketPath, () => resolvePromise()); }); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('environment blocks Unix socket creation'); return; } throw error; }
  const client = new DockerRunnerClient({ socketPath });
  try {
    assert.deepEqual(await client.health(), { status: 'ready', version: 1, docker: 'available' }, 'older supervisor without auth fields');
    body = { status: 'ready', version: 1, docker: 'available', require_subscription: false, auth: [{ profile: 'team', provider: 'claude', mode: 'subscription', secret: 'dropped' }] };
    assert.deepEqual(await client.health(), { status: 'ready', version: 1, docker: 'available', require_subscription: false, auth: [{ profile: 'team', provider: 'claude', mode: 'subscription' }] });
    for (const bad of [{ auth: 'x' }, { auth: [{ profile: 'a', provider: 'gemini', mode: 'api' }] }, { auth: [{ profile: 'a', provider: 'claude', mode: 'free' }] }, { auth: [{ profile: '', provider: 'claude', mode: 'api' }] }, { require_subscription: 'yes' }]) {
      body = { status: 'ready', version: 1, docker: 'available', ...bad };
      await assert.rejects(() => client.health(), (error: unknown) => error instanceof AutosError && error.code === 'TOOL');
    }
  } finally { await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())); }
});
