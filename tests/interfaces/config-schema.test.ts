import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { CONFIG_DESCRIPTIONS, configJsonSchema, descriptionKey, settingPaths } from '../../apps/controller/src/config-schema.js';

test('every configuration setting has a description, and no description is stale', () => {
  const schema = configJsonSchema();
  const keys = new Set(settingPaths(schema).map(descriptionKey));
  const missing = [...keys].filter((key) => !CONFIG_DESCRIPTIONS[key]);
  assert.deepEqual(missing, [], `settings without a description: ${missing.join(', ')}`);
  const stale = Object.keys(CONFIG_DESCRIPTIONS).filter((key) => key !== '' && !keys.has(key));
  assert.deepEqual(stale, [], `descriptions for settings that no longer exist: ${stale.join(', ')}`);
  assert.equal(typeof schema.description, 'string');
});

test('the settings schema carries allowed values, ranges and defaults from the Zod config schema', () => {
  const schema = configJsonSchema() as { properties: Record<string, { properties: Record<string, Record<string, unknown>> }> };
  const jobs = schema.properties.jobs!.properties;
  assert.deepEqual([jobs.max_parallel!.minimum, jobs.max_parallel!.maximum, jobs.max_parallel!.default], [1, 8, 1]);
  const precedents = (schema.properties.precedents as unknown as { properties: Record<string, { properties: Record<string, Record<string, unknown>> }> }).properties;
  assert.deepEqual(precedents.embedding!.properties.provider!.enum, ['none', 'ollama']);
  assert.equal(precedents.index!.properties.window_weeks!.default, 104);
  assert.equal(JSON.stringify(schema).includes('"$schema"'), false);
});

test('docs/openapi.yaml publishes the settings schema as components.schemas.AutosConfig', async () => {
  const doc = parseDocument(await readFile('docs/openapi.yaml', 'utf8')).toJS({ maxAliasCount: 1000 }) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
  const published = doc.components.schemas.AutosConfig;
  assert.ok(published, 'AutosConfig is present');
  assert.deepEqual(Object.keys(published.properties).sort(), Object.keys((configJsonSchema() as { properties: Record<string, unknown> }).properties).sort());
});
