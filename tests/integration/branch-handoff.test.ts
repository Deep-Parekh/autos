import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAtlassianClient } from '@autos/atlassian';
import { GitRunner } from '@autos/git-runner';
import { CliProviderAdapter } from '@autos/cli-adapters';
import { evaluateFinalization, parseConfigYaml, type AtlassianReadPort, type GitRunnerPort } from '@autos/contracts';

const execFile = promisify(execFileCallback);
const jobId = '432c5a6a-043a-4ad6-894c-5330ea7d06bc';
const fixedDate = new Date('2026-11-08T06:00:00Z');
const html = '<table><tbody><tr><th>Project Key</th><th>Bitbucket Workspace</th><th>Repository Slug</th><th>Development Branch</th><th>Sandbox Branch</th><th>Enabled</th></tr><tr><td>SAMPLE</td><td>example</td><td>sample-app</td><td>develop</td><td></td><td>Yes</td></tr></tbody></table>';

test('Jira filter and Confluence routing feed a pinned Git candidate and gated local handoff', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autos-integration-')));
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Autos Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Autos Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = async (args: string[], cwd = root) => (await execFile('git', args, { cwd, env })).stdout.trim();
  try {
    const source = join(root, 'seed');
    const remote = join(root, 'remote.git');
    await git(['init', '-b', 'main', source]);
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src/App.java'), 'class App { int answer() { return 0; } }\n');
    await git(['add', 'src/App.java'], source);
    await git(['commit', '-m', 'main baseline'], source);
    await git(['checkout', '-b', 'develop'], source);
    await writeFile(join(source, 'src/App.java'), 'class App { int answer() { return 1; } }\n');
    await git(['commit', '-am', 'development baseline'], source);
    const expectedBase = await git(['rev-parse', 'HEAD'], source);
    await git(['init', '--bare', remote]);
    await git(['remote', 'add', 'origin', remote], source);
    await git(['push', 'origin', 'main', 'develop'], source);

    const config = parseConfigYaml(await readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8'));
    const requests: URL[] = [];
    const client = createAtlassianClient({
      config,
      credentials: { jira: { username: 'fixture@example.invalid', token: 'fixture-only' }, confluence: { username: 'fixture@example.invalid', token: 'fixture-only' } },
      now: () => fixedDate,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'manual');
        let body: unknown;
        if (url.pathname === '/rest/api/3/filter/12345') body = { id: '12345', name: 'Fixture bugs', jql: 'key = SAMPLE-123' };
        else if (url.pathname === '/rest/api/3/search/jql') body = { issues: [{ key: 'SAMPLE-123', fields: {} }], isLast: true };
        else if (url.pathname === '/rest/api/3/issue/SAMPLE-123') body = { key: 'SAMPLE-123', fields: { project: { key: 'SAMPLE' }, summary: 'Fix fixture answer', description: 'Expected answer is 2.', issuetype: { name: 'Bug' }, status: { name: 'Open' }, updated: '2026-11-08T06:00:00.000+0000', components: [], issuelinks: [] } };
        else if (url.pathname === '/rest/api/3/issue/SAMPLE-123/comment') body = { comments: [], total: 0, startAt: 0, maxResults: 50 };
        else if (url.pathname === '/wiki/api/v2/pages/67890') body = { id: '67890', version: { number: 7 }, body: { storage: { value: html } } };
        else throw new Error('Unexpected fixture endpoint');
        return Response.json(body);
      },
    });
    const reads: AtlassianReadPort = client;
    const filter = await reads.getSavedFilter(config.jira.saved_filter_id);
    const keys = await reads.listIssueKeys(filter.jql);
    const issues = await Promise.all(keys.map((key) => reads.getIssue(key)));
    assert.equal(issues.length, 1);
    const mapping = await client.resolveProjectMapping(issues[0]!.project_key);
    assert.equal(mapping.source.version, 7);
    const repository = config.bitbucket.allowed_repositories[0]!;
    const runner: GitRunnerPort = new GitRunner({ allowedRepositories: [repository], testOnlyRemoteOverrides: [{ repository: 'example/sample-app', path: remote }] });
    const workspace = await runner.prepare({ job_id: jobId, issue_key: issues[0]!.key, mapping, repository, workspaces_root: join(root, 'jobs') });
    assert.equal(workspace.base_sha, expectedBase);
    assert.equal(workspace.feature_branch, 'deep/SAMPLE-123');
    assert.match(await readFile(join(workspace.directory, 'src/App.java'), 'utf8'), /return 1/);
    const artifactDirectory = join(root, 'private-artifacts');
    await mkdir(artifactDirectory);
    const promptPath = join(artifactDirectory, 'swe-prompt.md');
    await writeFile(promptPath, 'Apply the synthetic fixture fix.');
    const fakeProvider = join(root, 'fake-provider.mjs');
    await writeFile(fakeProvider, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('src/App.java', 'class App { int answer() { return 2; } }\\n');\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Synthetic fixture changed' }));\n`, { mode: 0o700 });
    const adapter = new CliProviderAdapter('claude', { binaries: { claude: fakeProvider } });
    const implementation = await adapter.run({ job_id: jobId, issue_key: issues[0]!.key, provider: 'claude', role: 'swe', cwd: workspace.directory, prompt_path: promptPath, transcript_path: join(artifactDirectory, 'swe.log'), timeout_ms: 5000, source_access: 'write', auth_profile: 'fixture' });
    assert.equal(implementation.status, 'SUCCEEDED');
    assert.match(await readFile(join(workspace.directory, 'src/App.java'), 'utf8'), /return 2/);
    const candidate = await runner.inspectCandidate(workspace);
    // These are schema fixtures, not a claim that a Java build or model review ran.
    const checks = { schema_version: 1, candidate_digest: candidate.digest, recorded_at: fixedDate.toISOString(), checks: [{ name: 'synthetic gate', command: ['fixture-check'], status: 'PASS', exit_code: 0, timed_out: false, required: true, report_paths: [] }] };
    const qa = { schema_version: 1, candidate_digest: candidate.digest, status: 'PASS', evidence: ['Synthetic integration evidence'] };
    const review = { schema_version: 1, candidate_digest: candidate.digest, status: 'PASS', findings: [] };
    assert.equal(evaluateFinalization(candidate.digest, checks, qa, review).ready, true);
    assert.equal(evaluateFinalization('0'.repeat(64), checks, qa, review).ready, false);
    const committed = await runner.commit({ workspace, candidate_digest: candidate.digest, approved_paths: candidate.paths, message: 'SAMPLE-123 fixture fix', author: { name: 'Autos Fixture', email: 'fixture@example.invalid' } });
    assert.deepEqual(committed.paths, ['src/App.java']);
    assert.equal(await git(['rev-parse', 'HEAD^'], workspace.directory), expectedBase);
    assert.equal((await runner.push(workspace, committed.commit_sha)).status, 'DISABLED');
    assert.equal(await git(['rev-parse', 'refs/heads/develop'], remote), expectedBase);

    // Insert a competing ref after the precheck, when the actual push process starts.
    // A normal fast-forward push would replace it; the empty expected-ref lease must fail.
    const pushingRunner = new GitRunner({ allowedRepositories: [repository], pushEnabled: true, testOnlyRemoteOverrides: [{ repository: 'example/sample-app', path: remote }] });
    const pushingWorkspace = await pushingRunner.prepare({ job_id: '432c5a6a-043a-4ad6-894c-5330ea7d06bd', issue_key: issues[0]!.key, mapping, repository, workspaces_root: join(root, 'push-jobs') });
    await writeFile(join(pushingWorkspace.directory, 'src/App.java'), 'class App { int answer() { return 2; } }\n');
    const pushingCandidate = await pushingRunner.inspectCandidate(pushingWorkspace);
    assert.notEqual(pushingCandidate.digest, candidate.digest);
    assert.equal(evaluateFinalization(pushingCandidate.digest, checks, qa, review).ready, false);
    const pushingCommit = await pushingRunner.commit({ workspace: pushingWorkspace, candidate_digest: pushingCandidate.digest, approved_paths: pushingCandidate.paths, message: 'SAMPLE-123 push race fixture', author: { name: 'Autos Fixture', email: 'fixture@example.invalid' } });
    const wrapperDirectory = join(root, 'git-wrapper');
    const raceMarker = join(root, 'race-exercised');
    await mkdir(wrapperDirectory);
    await writeFile(join(wrapperDirectory, 'git'), `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst { writeFileSync } = require('node:fs');\nconst args = process.argv.slice(2);\nif (args.includes('push')) {\n  const inserted = spawnSync('/usr/bin/git', ['--git-dir', ${JSON.stringify(remote)}, 'update-ref', 'refs/heads/deep/SAMPLE-123', ${JSON.stringify(expectedBase)}]);\n  if (inserted.status !== 0) process.exit(90);\n  writeFileSync(${JSON.stringify(raceMarker)}, 'raced');\n}\nconst result = spawnSync('/usr/bin/git', args, { stdio: 'inherit', env: process.env });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${wrapperDirectory}:${previousPath ?? '/usr/bin:/bin'}`;
      assert.equal((await pushingRunner.push(pushingWorkspace, pushingCommit.commit_sha)).status, 'FAILED');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(await readFile(raceMarker, 'utf8'), 'raced');
    assert.equal(await git(['rev-parse', 'refs/heads/deep/SAMPLE-123'], remote), expectedBase);
    assert.equal(await git(['rev-parse', 'HEAD'], pushingWorkspace.directory), pushingCommit.commit_sha);
    assert.ok(requests.length >= 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
