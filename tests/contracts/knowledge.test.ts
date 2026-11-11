import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KNOWLEDGE_TOOLS, KNOWLEDGE_TOOL_INPUTS, KNOWLEDGE_TOOL_NAMES, knowledgeCallResponseSchema, knowledgeSessionSchema, parseConfigYaml, providerRequestSchema } from '@autos/contracts';

const example = () => readFile(new URL('../../config/config.example.yaml', import.meta.url), 'utf8');

test('knowledge config is optional, off by default, and validates the allow-list', async () => {
  const base = await example();
  assert.equal(parseConfigYaml(base).knowledge, undefined);
  const on = parseConfigYaml(`${base}\nknowledge:\n  enabled: true\n  confluence:\n    spaces: [UAE, '~60fee4eba539cb00681d1309']\n    pages: ['3083534337']\n`).knowledge!;
  assert.equal(on.enabled, true);
  assert.deepEqual(on.roles, ['swe', 'qa', 'reviewer']);
  assert.equal(on.gateway.listen_host, '127.0.0.1'); assert.equal(on.gateway.advertise_url, 'http://host.docker.internal:8791');
  assert.equal(on.limits.max_calls_per_run, 80); assert.equal(on.jira.projects, undefined);
  assert.equal(parseConfigYaml(`${base}\nknowledge: {}\n`).knowledge!.enabled, false);
  for (const bad of ["confluence:\n    spaces: ['bad key']", "confluence:\n    pages: [abc]", 'gateway:\n    advertise_url: http://user:pw@host:1/', 'gateway:\n    listen_host: example.com', 'write_access: true']) {
    assert.throws(() => parseConfigYaml(`${base}\nknowledge:\n  ${bad}\n`), bad);
  }
});

test('every tool has a definition whose JSON schema matches its validator, and no tool can write', () => {
  assert.deepEqual(KNOWLEDGE_TOOLS.map((t) => t.name).sort(), [...KNOWLEDGE_TOOL_NAMES].sort());
  for (const tool of KNOWLEDGE_TOOLS) {
    assert.match(tool.name, /^(jira|confluence)_(get|search)/, 'read verbs only');
    const shape = KNOWLEDGE_TOOL_INPUTS[tool.name].shape as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), Object.keys(shape).sort());
    for (const required of tool.inputSchema.required) assert.equal(shape[required]!.safeParse(undefined).success, false, `${tool.name}.${required} is required`);
  }
  assert.equal(KNOWLEDGE_TOOL_INPUTS.jira_get_issue.safeParse({ issue_key: 'CMS2-1495', extra: 1 }).success, false);
  assert.equal(KNOWLEDGE_TOOL_INPUTS.jira_search.safeParse({ query: 'x' }).success, false);
  assert.equal(KNOWLEDGE_TOOL_INPUTS.jira_get_attachment.safeParse({ issue_key: 'CMS2-1', attachment_id: '12/../3' }).success, false);
});

test('sessions and call responses are strict', () => {
  const token = 'a'.repeat(43);
  assert.equal(knowledgeSessionSchema.safeParse({ url: 'http://host.docker.internal:8791', token }).success, true);
  assert.equal(knowledgeSessionSchema.safeParse({ url: 'http://host.docker.internal:8791/path?x=1', token }).success, false);
  assert.equal(knowledgeSessionSchema.safeParse({ url: 'http://h:1', token: 'short' }).success, false);
  assert.equal(knowledgeCallResponseSchema.safeParse({ ok: true, content: [{ type: 'text', text: 'x' }] }).success, true);
  assert.equal(knowledgeCallResponseSchema.safeParse({ ok: false, code: 'FORBIDDEN', message: 'Space is not allowed', body: 'upstream' }).success, false);
  const request = { job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', issue_key: 'SAMPLE-1', provider: 'claude', role: 'qa', cwd: '/w', prompt_path: '/p', transcript_path: '/t', timeout_ms: 1000, source_access: 'read', auth_profile: 'default' };
  assert.equal(providerRequestSchema.safeParse({ ...request, knowledge: { url: 'http://h:8791', token } }).success, true);
  assert.equal(providerRequestSchema.safeParse({ ...request, knowledge: { url: 'http://h:8791' } }).success, false);
});
