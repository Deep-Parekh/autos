import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AutosError, parseConfig, parseConfigYaml } from '@autos/contracts';

const text = readFileSync(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');
function example() { return structuredClone(parseConfigYaml(text)); }

test('canonical configuration uses safe defaults and secret references', () => {
  const config = example();
  assert.equal(config.bitbucket.push_feature_branch, false);
  assert.equal(config.jobs.max_parallel, 1);
  assert.equal(config.agents.qa.provider, 'codex');
  assert.equal(config.jira.token_env, 'AUTOS_ATLASSIAN_TOKEN');
});

test('prohibited capabilities, extra credential fields, and excessive repair/concurrency settings fail closed', () => {
  for (const mutate of [
    (c: any) => c.security.allow_jira_write = true,
    (c: any) => c.security.allow_confluence_write = true,
    (c: any) => c.security.allow_merge = true,
    (c: any) => c.git.no_force_push = false,
    (c: any) => c.git.branch_template = 'main',
    (c: any) => c.bitbucket.create_pull_request = true,
    (c: any) => c.jobs.max_repair_rounds = 3,
    (c: any) => c.jobs.max_parallel = 9,
    (c: any) => c.jobs.max_parallel = 0,
    (c: any) => { c.jobs.max_parallel = 2; c.jobs.max_concurrent_checks = 3; },
    (c: any) => c.api.listen_host = '0.0.0.0',
    (c: any) => c.jira.token = 'secret-never-print-me',
  ]) {
    const config = example(); mutate(config);
    assert.throws(() => parseConfig(config), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG' && !error.message.includes('secret-never-print-me'));
  }
});

test('max_parallel defaults to 1 and can be raised for a larger host', () => {
  const base: any = example(); delete base.jobs.max_parallel;
  assert.equal(parseConfig(base).jobs.max_parallel, 1);
  const larger = example(); larger.jobs.max_parallel = 4; larger.jobs.max_concurrent_checks = 2;
  const parsed = parseConfig(larger);
  assert.equal(parsed.jobs.max_parallel, 4);
  assert.equal(parsed.jobs.max_concurrent_checks, 2);
});

test('duplicate repositories, missing build profiles and credential-bearing remotes are rejected', () => {
  const duplicate = example();
  duplicate.bitbucket.allowed_repositories.push(duplicate.bitbucket.allowed_repositories[0]!);
  assert.throws(() => parseConfig(duplicate), /Invalid configuration/);
  const profile = example(); profile.bitbucket.allowed_repositories[0]!.build_profile = 'missing';
  assert.throws(() => parseConfig(profile), /build_profile/);
  const remote = example(); remote.bitbucket.allowed_repositories[0]!.remote_url = 'https://user:secret-never-print-me@bitbucket.org/example/sample-app.git';
  assert.throws(() => parseConfig(remote), (error: unknown) => error instanceof AutosError && !error.message.includes('secret-never-print-me'));
});

test('invalid YAML, duplicate keys, aliases and legacy config names give safe errors', () => {
  for (const source of ['jira: [', 'secret-never-print-me: 1\nsecret-never-print-me: 2', 'a: &a [1]\nb: *a']) {
    assert.throws(() => parseConfigYaml(source), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG' && !error.message.includes('secret-never-print-me'));
  }
  assert.throws(() => parseConfig({ instance: { concurrency: 1 } }), /Invalid configuration/);
});

test('role fallback chains are ordered, distinct, and Cursor is auto-only', () => {
  const config: any = example();
  config.agents.swe = { provider: 'claude', fallbacks: [{ provider: 'codex' }, { provider: 'cursor' }] };
  config.agents.reviewer = { provider: 'cursor' };
  config.agents.qa = { provider: 'codex' };
  const parsed = parseConfig(config);
  assert.deepEqual(parsed.agents.swe.fallbacks, [{ provider: 'codex' }, { provider: 'cursor', model: 'auto' }]);
  assert.equal(parsed.agents.reviewer.model, 'auto');
  assert.deepEqual(parsed.agents.qa.fallbacks, []);
  for (const mutate of [
    (c: any) => c.agents.swe = { provider: 'cursor', model: 'gpt-5' },
    (c: any) => c.agents.qa = { provider: 'codex', fallbacks: [{ provider: 'cursor', model: 'sonnet' }] },
    (c: any) => c.agents.qa = { provider: 'codex', fallbacks: [{ provider: 'codex' }] },
    (c: any) => c.agents.qa = { provider: 'codex', fallbacks: [{ provider: 'claude' }, { provider: 'claude' }] },
    (c: any) => c.agents.qa = { provider: 'codex', fallbacks: [{ provider: 'claude' }, { provider: 'cursor' }, { provider: 'codex' }] },
    (c: any) => c.agents.qa = { provider: 'codex', fallbacks: [{ provider: 'gemini' }] },
  ]) {
    const bad: any = example(); mutate(bad);
    assert.throws(() => parseConfig(bad), (error: unknown) => error instanceof AutosError && error.code === 'INVALID_CONFIG');
  }
});
