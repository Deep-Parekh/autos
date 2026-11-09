import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseConfigYaml, AutosError } from '@autos/contracts';
import { createAtlassianClient } from '../../packages/atlassian/src/index.js';

const base = parseConfigYaml(readFileSync('config/config.example.yaml', 'utf8'));
const config = {
  ...base,
  jira: { ...base.jira, allowed_projects: ['SAMPLE', 'OTHER'] },
  bitbucket: { ...base.bitbucket, allowed_repositories: [...base.bitbucket.allowed_repositories, { ...base.bitbucket.allowed_repositories[0]!, repository_slug: 'other-app', remote_url: 'https://bitbucket.org/example/other-app.git' }] },
};
const credentials = { jira: { username: 'fixture@example.test', token: 'fixture-secret' }, confluence: { username: 'fixture@example.test', token: 'fixture-secret' } };
const now = () => new Date('2026-01-02T03:04:05Z');
const header = '<tr><th>Project Key</th><th>Bitbucket Workspace</th><th>Repository Slug</th><th>Development Branch</th><th>Sandbox Branch</th><th>Enabled</th></tr>';
const row = (project: string, repo: string, enabled = 'true') => `<tr><td>${project}</td><td>example</td><td>${repo}</td><td>develop</td><td></td><td>${enabled}</td></tr>`;
const good = row('SAMPLE', 'sample-app');
const goodOther = row('OTHER', 'other-app');

function setup(html: string) {
  const methods: string[] = [];
  const client = createAtlassianClient({ config, credentials, now, fetch: async (_input, init) => {
    methods.push(init?.method ?? '');
    return new Response(JSON.stringify({ id: config.confluence.branch_map_page_id, version: { number: 7 }, body: { storage: { value: html } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  return { client, methods, page: config.confluence.branch_map_page_id };
}
const table = (...rows: string[]) => `<table>${header}${rows.join('')}</table>`;
const isMapping = (match?: string) => (error: unknown) => error instanceof AutosError && error.code === 'MAPPING' && (!match || error.message.includes(match));

test('rows for projects outside the allowlist are ignored and counted', async () => {
  const { client, methods, page } = setup(table(good, row('FOREIGN', 'not-allowed'), row('FOREIGN', 'x'), '<tr><td>ZZZ</td></tr>'));
  const report = await client.getBranchMapReport(page);
  assert.equal(report.ignored_rows, 3);
  assert.deepEqual(report.mappings.map((m) => m.project_key), ['SAMPLE']);
  assert.deepEqual(report.invalid_projects, []);
  assert.equal(report.page_version, 7);
  assert.equal(report.mappings[0]?.source.version, 7);
  assert.equal((await client.resolveProjectMapping('SAMPLE')).repository_slug, 'sample-app');
  assert.ok(methods.length > 0 && methods.every((m) => m === 'GET'));
});

test('one bad allowed-project row does not affect other projects', async () => {
  for (const bad of [row('OTHER', 'not-allowed'), row('OTHER', 'other-app', 'maybe'), '<tr><td>OTHER</td><td>example</td></tr>']) {
    const { client, page } = setup(table(good, bad));
    assert.deepEqual((await client.getBranchMap(page)).map((m) => m.project_key), ['SAMPLE']);
    assert.equal((await client.getBranchMapReport(page)).invalid_projects[0]?.project_key, 'OTHER');
    assert.equal((await client.resolveProjectMapping('SAMPLE')).project_key, 'SAMPLE');
    await assert.rejects(client.resolveProjectMapping('OTHER'), isMapping());
  }
});

test('duplicate allowed-project rows fail only that project', async () => {
  const { client, page } = setup(table(good, goodOther, goodOther));
  const report = await client.getBranchMapReport(page);
  assert.deepEqual(report.mappings.map((m) => m.project_key), ['SAMPLE']);
  assert.match(report.invalid_projects[0]!.reason, /duplicate/);
  await assert.rejects(client.resolveProjectMapping('OTHER'), isMapping('duplicate'));
  assert.equal((await client.resolveProjectMapping('SAMPLE')).project_key, 'SAMPLE');
});

test('disabled row fails only that project', async () => {
  const { client } = setup(table(good, row('OTHER', 'other-app', 'no')));
  await assert.rejects(client.resolveProjectMapping('OTHER'), isMapping('disabled'));
  assert.equal((await client.resolveProjectMapping('SAMPLE')).project_key, 'SAMPLE');
});

test('missing mapping for an allowed project fails only that project', async () => {
  const { client } = setup(table(good));
  await assert.rejects(client.resolveProjectMapping('OTHER'), isMapping('No branch mapping'));
});

test('broken table structure still fails closed', async () => {
  const cases = ['<p>no table</p>', '<table><tr><th>Project Key</th><th>Enabled</th></tr></table>', `<table>${header.replace('<th>Enabled</th>', '<th>Enabled</th><th>Extra</th>')}${good}</table>`, table(good) + table(good)];
  for (const html of cases) {
    const { client, page } = setup(html);
    await assert.rejects(client.getBranchMapReport(page), isMapping());
    await assert.rejects(client.resolveProjectMapping('SAMPLE'), isMapping());
  }
});

test('401 tells operators to use a classic API token without leaking secrets', async () => {
  const client = createAtlassianClient({ config, credentials, now, fetch: async () => new Response('secret-body', { status: 401 }) });
  await assert.rejects(client.getBranchMap(config.confluence.branch_map_page_id), (error: unknown) => error instanceof AutosError && error.code === 'AUTH' && error.message.includes('classic (unscoped) API token') && !error.message.includes('secret'));
});

const headerWith = (...extra: string[]) => header.replace('</tr>', `${extra.map((name) => `<th>${name}</th>`).join('')}</tr>`);
const rowWith = (project: string, repo: string, ...extra: string[]) => row(project, repo).replace('</tr>', `${extra.map((cell) => `<td>${cell}</td>`).join('')}</tr>`);
const tableWith = (head: string, ...rows: string[]) => `<table>${head}${rows.join('')}</table>`;

test('JDK and Tomcat columns populate the mapping', async () => {
  const { client } = setup(tableWith(headerWith('JDK', 'Tomcat'), rowWith('SAMPLE', 'sample-app', '21', 'Tomcat 11.0.24'), rowWith('OTHER', 'other-app', 'JDK 25', 'apache-tomcat-9.0.50')));
  assert.deepEqual(await client.resolveProjectMapping('SAMPLE').then((m) => [m.jdk, m.tomcat]), ['21', '11.0.24']);
  assert.deepEqual(await client.resolveProjectMapping('OTHER').then((m) => [m.jdk, m.tomcat]), ['25', '9.0.50']);
});

test('JDK and Tomcat cell variants normalize', async () => {
  const cases: [string, string, string][] = [['Corretto 21', '11.0.24', '21'], ['21.0.9', 'Tomcat 11.0.24', '21'], ['JDK 25', 'apache-tomcat-9.0.50', '25']];
  for (const [jdk, tomcat, expectedJdk] of cases) {
    const { client } = setup(tableWith(headerWith('JDK', 'Tomcat'), rowWith('SAMPLE', 'sample-app', jdk, tomcat)));
    const mapping = await client.resolveProjectMapping('SAMPLE');
    assert.equal(mapping.jdk, expectedJdk);
    assert.equal(mapping.tomcat, tomcat.replace(/^(?:Tomcat |apache-tomcat-)/, ''));
  }
});

test('blank JDK and Tomcat cells and absent columns map to null', async () => {
  const blank = setup(tableWith(headerWith('JDK', 'Tomcat'), rowWith('SAMPLE', 'sample-app', '', '')));
  const blankMapping = await blank.client.resolveProjectMapping('SAMPLE');
  assert.equal(blankMapping.jdk, null);
  assert.equal(blankMapping.tomcat, null);
  const absent = setup(table(good));
  const absentMapping = await absent.client.resolveProjectMapping('SAMPLE');
  assert.equal(absentMapping.jdk, null);
  assert.equal(absentMapping.tomcat, null);
});

test('only one of the optional columns may be present', async () => {
  const jdkOnly = await setup(tableWith(headerWith('JDK'), rowWith('SAMPLE', 'sample-app', '21'))).client.resolveProjectMapping('SAMPLE');
  assert.deepEqual([jdkOnly.jdk, jdkOnly.tomcat], ['21', null]);
  const tomcatOnly = await setup(tableWith(headerWith('Tomcat'), rowWith('SAMPLE', 'sample-app', '11.0.24'))).client.resolveProjectMapping('SAMPLE');
  assert.deepEqual([tomcatOnly.jdk, tomcatOnly.tomcat], [null, '11.0.24']);
});

test('unrecognized JDK or Tomcat value invalidates only that project without echoing the cell', async () => {
  const { client, page } = setup(tableWith(headerWith('JDK', 'Tomcat'), rowWith('SAMPLE', 'sample-app', '21', '11.0.24'), rowWith('OTHER', 'other-app', 'java-secret-x', '')));
  const report = await client.getBranchMapReport(page);
  assert.deepEqual(report.mappings.map((m) => m.project_key), ['SAMPLE']);
  assert.equal(report.invalid_projects[0]?.project_key, 'OTHER');
  assert.equal(report.invalid_projects[0]?.reason, 'Branch map JDK value for this project is not recognized (use a major version such as 21)');
  const tomcat = setup(tableWith(headerWith('JDK', 'Tomcat'), rowWith('SAMPLE', 'sample-app', '21', '11.0.24'), rowWith('OTHER', 'other-app', '21', 'tomcat-secret-x')));
  const tomcatReport = await tomcat.client.getBranchMapReport(tomcat.page);
  assert.deepEqual(tomcatReport.mappings.map((m) => m.project_key), ['SAMPLE']);
  assert.equal(tomcatReport.invalid_projects[0]?.reason, 'Branch map Tomcat value for this project is not recognized (use a full version such as 11.0.24)');
  assert.ok(!JSON.stringify(tomcatReport).includes('secret-x'));
});

test('unknown extra column or duplicate JDK header still rejects the table', async () => {
  for (const head of [headerWith('JDK', 'Notes'), headerWith('JDK', 'JDK')]) {
    const { client, page } = setup(tableWith(head, rowWith('SAMPLE', 'sample-app', '21', '21')));
    await assert.rejects(client.getBranchMapReport(page), isMapping());
  }
});

test('optional headers are matched case-insensitively with normalized whitespace', async () => {
  const { client } = setup(tableWith(headerWith(' jdk ', '  TOMCAT'), rowWith('SAMPLE', 'sample-app', '17', '10.1.20')));
  const mapping = await client.resolveProjectMapping('SAMPLE');
  assert.deepEqual([mapping.jdk, mapping.tomcat], ['17', '10.1.20']);
});
