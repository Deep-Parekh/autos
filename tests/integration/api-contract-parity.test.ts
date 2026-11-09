// Guards against drift between the shared Zod contracts and the controller's hand-written route schemas
// (published in docs/openapi.yaml). A field added to a contract must also reach the API, or responses would
// silently drop it under additionalProperties: false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { EFFORT_LEVELS, ERROR_CODES, JOB_EVENT_TYPES, jobEventSchema, jobRecordSchema, ticketNotesSummarySchema, tierPinRequestSchema, tierPinResultSchema, tierPinSchema } from '@autos/contracts';

type Schema = { properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; $ref?: string; anyOf?: Schema[]; oneOf?: Schema[] };

async function openapi(): Promise<Record<string, any>> {
  return parse(await readFile('docs/openapi.yaml', 'utf8')) as Record<string, any>;
}
function resolve(doc: Record<string, any>, schema: Schema): Schema {
  if (!schema.$ref) return schema;
  return schema.$ref.replace(/^#\//, '').split('/').reduce((node: any, key) => node[key], doc) as Schema;
}
function okJson(doc: Record<string, any>, path: string, status = '200'): Schema {
  const operation = doc.paths[path]?.get;
  assert.ok(operation, `${path} GET is documented`);
  return resolve(doc, operation.responses[status].content['application/json'].schema);
}
function enumOf(schema: Schema | undefined): unknown[] {
  if (!schema) return [];
  if (schema.enum) return schema.enum;
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap((option) => option.enum ?? []);
}

test('every job event contract field and type is exposed by the events API', async () => {
  const doc = await openapi();
  const event = resolve(doc, okJson(doc, '/v1/events').properties!.events!.items!);
  const apiFields = Object.keys(event.properties ?? {}).sort();
  const contractFields = Object.keys(jobEventSchema.shape).sort();
  assert.deepEqual(contractFields.filter((field) => !apiFields.includes(field)), [], 'contract event fields missing from the API schema');
  assert.deepEqual(apiFields.filter((field) => !contractFields.includes(field)), [], 'API event fields that are not in the contract');
  assert.deepEqual([...enumOf(event.properties!.type)].sort(), [...JOB_EVENT_TYPES].sort());
  assert.deepEqual([...enumOf(event.properties!.code)].sort(), [...ERROR_CODES].sort());
});

test('every job record contract field is exposed by the job details API', async () => {
  const doc = await openapi();
  const job = okJson(doc, '/v1/jobs/{jobId}');
  const apiFields = Object.keys(job.properties ?? {});
  const contractFields = Object.keys(jobRecordSchema.shape);
  assert.deepEqual(contractFields.filter((field) => !apiFields.includes(field)), [], 'contract job fields missing from the API schema');
  assert.deepEqual([...enumOf(job.properties!.blocked_code)].sort(), [...ERROR_CODES].sort());
});

test('every ticket notes summary and tier pin contract field is exposed by the notes API', async () => {
  const doc = await openapi();
  const summary = okJson(doc, '/v1/issues/{issueKey}/notes');
  assert.deepEqual(Object.keys(summary.properties ?? {}).sort(), Object.keys(ticketNotesSummarySchema.shape).sort());
  const pin = resolve(doc, summary.properties!.tier_pins!.items!);
  assert.deepEqual(Object.keys(pin.properties ?? {}).sort(), Object.keys(tierPinSchema.shape).sort());
  const pins = okJson(doc, '/v1/issues/{issueKey}/tier');
  assert.deepEqual(Object.keys(resolve(doc, pins.properties!.pins!.items!).properties ?? {}).sort(), Object.keys(tierPinSchema.shape).sort());
  const put = doc.paths['/v1/issues/{issueKey}/tier']?.put;
  assert.ok(put, 'PUT /v1/issues/{issueKey}/tier is documented');
  const result = resolve(doc, put.responses['200'].content['application/json'].schema);
  assert.deepEqual(Object.keys(result.properties ?? {}).sort(), Object.keys(tierPinResultSchema.shape).sort());
  const request = resolve(doc, put.requestBody.content['application/json'].schema);
  assert.deepEqual(Object.keys(request.properties ?? {}).sort(), Object.keys(tierPinRequestSchema.shape).sort());
  assert.deepEqual([...enumOf(request.properties!.effort)].sort(), [...EFFORT_LEVELS].sort());
});
