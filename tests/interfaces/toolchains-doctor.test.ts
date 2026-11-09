import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseConfigYaml, type AutosConfig, type ProjectMapping } from '@autos/contracts';
import { deepChecks, type DeepRuntime } from '../../apps/cli/src/deep-doctor.js';

const canonical = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
const source = { page_id: '1', version: 1, fetched_at: '2026-11-07T00:00:00.000Z' };

function setup(profiles: Record<string, { jdk?: string; tomcat?: string }>) {
  const config: AutosConfig = structuredClone(canonical);
  config.jira.allowed_projects = ['WTS', 'UWE'];
  const base = config.bitbucket.allowed_repositories[0]!;
  config.bitbucket.allowed_repositories = [{ ...base, repository_slug: 'wts', build_profile: 'wts' }, { ...base, repository_slug: 'uwe', build_profile: 'uwe' }];
  for (const [id, profile] of Object.entries(profiles)) config.build_profiles[id] = { ...config.build_profiles['java-example']!, ...profile };
  for (const id of ['wts', 'uwe']) if (!profiles[id]) config.build_profiles[id] = { ...config.build_profiles['java-example']! };
  for (const id of ['wts', 'uwe']) if (!(profiles[id] && 'jdk' in profiles[id]!)) delete config.build_profiles[id]!.jdk;
  return config;
}
const mapping = (key: string, extra: Partial<ProjectMapping> = {}): ProjectMapping => ({ project_key: key, workspace: 'example', repository_slug: key.toLowerCase(), development_branch: 'develop', sandbox_branch: null, enabled: true, source, ...extra });

async function toolchainCheck(config: AutosConfig, projects: ProjectMapping[], toolchains?: { jdk: string[]; tomcat: string[] }) {
  const runtime = {
    runnerHealth: async () => ({ status: 'ready' as const, version: 1 as const, docker: 'available' as const, ...(toolchains ? { toolchains } : {}) }),
    projects: async () => projects,
  } as unknown as DeepRuntime;
  const results = await deepChecks({ config, env: {}, cwd: '/nonexistent-autos-test', runtime, deps: { freeBytes: async () => 100 * 1024 ** 3 } });
  return results.find((result) => result.name === 'toolchains')!;
}
const installed = { jdk: ['17', '21', '25'], tomcat: ['9.0.50', '11.0.24'] };

test('toolchains PASS summarizes selections and installed versions', async () => {
  const check = await toolchainCheck(setup({ uwe: { jdk: '21', tomcat: '9.0.50' } }), [mapping('WTS', { jdk: '25', tomcat: '11.0.24' }), mapping('UWE')], installed);
  assert.equal(check.status, 'PASS');
  assert.equal(check.message, 'WTS: JDK 25 + Tomcat 11.0.24; UWE: JDK 21 + Tomcat 9.0.50 (installed: JDK 17, 21, 25; Tomcat 9.0.50, 11.0.24)');
});

test('toolchains FAIL when a selected toolchain is not installed', async () => {
  const check = await toolchainCheck(setup({}), [mapping('WTS', { jdk: '25', tomcat: '11.0.24' }), mapping('UWE', { jdk: '21' })], { jdk: ['17', '21'], tomcat: ['11.0.24'] });
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /WTS needs JDK 25 \(not installed\)/);
  assert.match(check.message, /scripts\/install-toolchains\.ts/);
  assert.doesNotMatch(check.message, /UWE needs/);
});

test('toolchains WARN when the supervisor reports no toolchains', async () => {
  const check = await toolchainCheck(setup({}), [mapping('WTS', { jdk: '25' })]);
  assert.equal(check.status, 'WARN');
  assert.match(check.message, /does not report installed toolchains/);
});

test('toolchains WARN when no JDK resolves for a project', async () => {
  const check = await toolchainCheck(setup({}), [mapping('WTS', { jdk: '25' }), mapping('UWE')], installed);
  assert.equal(check.status, 'WARN');
  assert.match(check.message, /UWE: no JDK configured; agents get no Java and checks use the checks image JDK/);
});

test('toolchains FAIL when a Tomcat is set without a JDK', async () => {
  const check = await toolchainCheck(setup({}), [mapping('WTS', { tomcat: '11.0.24' })], installed);
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /WTS: .*no JDK/);
});

test('toolchains ignores disabled and non-allowed projects', async () => {
  const config = setup({});
  const check = await toolchainCheck(config, [mapping('WTS', { jdk: '21' }), mapping('UWE', { jdk: '99', enabled: false }), mapping('OTHER', { tomcat: '11.0.24' })], installed);
  assert.equal(check.status, 'PASS');
  assert.match(check.message, /^WTS: JDK 21 \(installed/);
});
