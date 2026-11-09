import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AutosError, parseConfig, parseTierStep, PROVIDER_EFFORTS, providerRequestSchema } from '@autos/contracts';

const raw = () => parse(readFileSync(new URL('../../config/config.example.yaml', import.meta.url), 'utf8')) as any;
const MODELS = { luna: { provider: 'codex', model: 'gpt-6-luna' }, terra: { provider: 'codex', model: 'gpt-6-terra' } };
const TIERS = {
  sm: [{ provider: 'claude', model: 'haiku', effort: 'high' }, 'luna:high'],
  med: ['terra:high', { provider: 'claude', model: 'sonnet', effort: 'high' }, { provider: 'cursor', model: 'auto' }],
  lg: [{ provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }, { provider: 'claude', model: 'opus', effort: 'max' }],
};
function tiered(mutate: (c: any) => void = () => undefined) {
  const c = raw(); c.models = structuredClone(MODELS); c.model_tiers = structuredClone(TIERS);
  c.agents.swe = { ladder: ['sm', 'med', 'lg'] };
  c.agents.reviewer = { ladder: ['med', 'lg'], min: 'med' };
  c.triage = { tier: 'sm' };
  mutate(c); return c;
}
const fields = (fn: () => unknown): string => { try { fn(); return ''; } catch (error) { assert.ok(error instanceof AutosError); return error.message; } };

test('tiers are ordered entry lists across providers; ladders name tiers; effort is per entry', () => {
  const config = parseConfig(tiered());
  const swe = config.agents.swe;
  assert.deepEqual(swe.ladder!.map((s) => s.label), ['sm', 'med', 'lg']);
  assert.deepEqual(swe.ladder![0]!.chain, [{ provider: 'claude', model: 'haiku', effort: 'high', tier: 'sm' }, { provider: 'codex', model: 'gpt-6-luna', effort: 'high', tier: 'sm' }]);
  assert.deepEqual(config.model_tiers.med!.map((e) => [e.provider, e.model, e.effort]), [['codex', 'gpt-6-terra', 'high'], ['claude', 'sonnet', 'high'], ['cursor', 'auto', undefined]]);
  // Legacy readers see the lowest tier as provider/model/fallbacks.
  assert.equal(swe.provider, 'claude'); assert.equal(swe.model, 'haiku'); assert.deepEqual(swe.fallbacks, [{ provider: 'codex', model: 'gpt-6-luna' }]);
  assert.equal(swe.min_index, undefined);
  assert.equal(config.agents.reviewer.min_index, 0);
  assert.equal(config.triage?.enabled, true);
  assert.equal(config.agents.qa.ladder, undefined, 'the plain form is unchanged');
});

test('tier config is validated per provider at load', () => {
  const cases: Array<[string, (c: any) => void, RegExp]> = [
    ['claude has no none effort', (c) => { c.model_tiers.sm[0].effort = 'none'; }, /model_tiers\.sm\.0/],
    ['cursor has no effort', (c) => { c.model_tiers.med[2].effort = 'high'; }, /model_tiers\.med\.2/],
    ['unknown effort word', (c) => { c.model_tiers.sm[1] = 'luna:turbo'; }, /model_tiers\.sm\.1/],
    ['unknown named model', (c) => { c.model_tiers.sm[1] = 'gemini:high'; }, /model_tiers\.sm\.1/],
    ['cursor entry must be auto', (c) => { c.model_tiers.med[2].model = 'gpt-6'; }, /model_tiers\.med\.2/],
    ['entry needs a model', (c) => { delete c.model_tiers.lg[0].model; }, /model_tiers\.lg\.0/],
    ['too many entries', (c) => { c.model_tiers.lg.push('luna', 'terra'); }, /model_tiers\.lg/],
    ['repeated entry', (c) => { c.model_tiers.lg[1] = { provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }; }, /model_tiers\.lg/],
    ['unknown tier in ladder', (c) => { c.agents.swe.ladder[1] = 'xl'; }, /agents\.swe\.ladder\.1/],
    ['duplicate ladder tier', (c) => { c.agents.swe.ladder[1] = 'sm'; }, /agents\.swe\.ladder\.1/],
    ['floor must be a ladder tier', (c) => { c.agents.reviewer.min = 'sm'; }, /agents\.reviewer\.min/],
    ['min only with a ladder', (c) => { c.agents.qa.min = 'sm'; }, /agents\.qa\.min/],
    ['ladder and provider together', (c) => { c.agents.swe.provider = 'codex'; }, /agents\.swe\.provider/],
    ['ladder with fallbacks', (c) => { c.agents.swe.fallbacks = [{ provider: 'claude' }]; }, /agents\.swe\.ladder/],
    ['ladder entries are tier names, not efforts', (c) => { c.agents.swe.ladder[0] = 'sm:high'; }, /agents\.swe\.ladder\.0/],
    ['triage unknown tier', (c) => { c.triage.tier = 'nope'; }, /triage\.tier/],
    ['tier name with colon', (c) => { c.model_tiers['a:b'] = ['luna']; }, /model_tiers/],
  ];
  for (const [name, mutate, path] of cases) assert.match(fields(() => parseConfig(tiered(mutate))), path, name);
  // Omitted effort = CLI default; named models without effort; cursor entry with model omitted means auto.
  assert.equal(fields(() => parseConfig(tiered((c) => { c.model_tiers.sm = ['luna', { provider: 'cursor' }]; }))), '');
  assert.equal(fields(() => parseConfig(tiered((c) => { c.agents.swe = { provider: 'claude', fallbacks: [{ provider: 'codex' }] }; }))), '');
});

test('effort levels, step labels and request validation', () => {
  assert.deepEqual(PROVIDER_EFFORTS.claude, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(PROVIDER_EFFORTS.cursor, []);
  assert.deepEqual(parseTierStep('med:xhigh'), { tier: 'med', effort: 'xhigh' });
  assert.deepEqual(parseTierStep('med'), { tier: 'med' });
  assert.equal(parseTierStep('med:turbo'), null);
  assert.equal(parseTierStep('Codex'), null);
  const request = { job_id: 'e0455252-8db5-4584-8946-79f64a02e238', issue_key: 'AUTO-1', provider: 'claude', role: 'swe', cwd: '/w', prompt_path: '/p', transcript_path: '/t', timeout_ms: 1, source_access: 'write', auth_profile: 'x' };
  assert.equal(providerRequestSchema.safeParse({ ...request, effort: 'max' }).success, true);
  assert.equal(providerRequestSchema.safeParse({ ...request, effort: 'none' }).success, false);
  assert.equal(providerRequestSchema.safeParse({ ...request, provider: 'codex', effort: 'none' }).success, true);
  assert.equal(providerRequestSchema.safeParse({ ...request, provider: 'cursor', effort: 'low' }).success, false);
});
