import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { semanticPrecedentResultSchema } from '@autos/contracts';
import { findSemanticPrecedents, PrecedentStore, type Judge, type RetrieveOutput } from '../../packages/precedents/src/index.js';
import { abstainQuery, buildCorpus, deps, fakeLineage, nearDupQuery, PATCH_P1, queryIssue, SHA_B55 } from './corpus.js';

const yesJudge = (verdict: 'yes' | 'likely' = 'yes'): Judge & { prompts: string[] } => {
  const prompts: string[] = [];
  return { prompts, judge: async (req) => { prompts.push(req.prompt); return `\`\`\`json\n${JSON.stringify({ schema_version: 1, verdicts: req.keys.map((k) => ({ issue_key: k, same_defect: verdict, confidence: 0.8, shared_evidence: [], differences: [] })) })}\n\`\`\``; } };
};
const why = (o: RetrieveOutput) => JSON.stringify(o.explain.map((e) => ({ k: e.issue_key, s: Number(e.score.toFixed(3)), sem: Number(e.features.semantic.toFixed(3)), sig: e.signals, g: e.gate, d: e.decision, r: e.reason })));
const rejected = (o: RetrieveOutput, key: string) => o.result.rejected.find((r) => r.issue_key === key)?.reason;

describe('findSemanticPrecedents', () => {
  it('finds the fixed relative, rejects keyword and semantic-only traps, and dedupes shared fixes and subtasks', async () => {
    const { store, emb } = await buildCorpus();
    const lineage = fakeLineage();
    const o = await findSemanticPrecedents(deps(store, emb, { judge: yesJudge(), lineage }), { issue: queryIssue });
    const r = o.result;
    assert.equal(r.outcome, 'FOUND', why(o));
    assert.equal(r.judge, 'RAN');
    assert.deepEqual(r.items.map((i) => [i.issue_key, i.kind]), [['PROJB-55', 'FIXED_IN_RELATIVE']], why(o));
    const item = r.items[0]!;
    assert.ok(item.signals.includes('semantic') && item.signals.includes('error_signature') && item.signals.includes('code_overlap') && item.signals.includes('lineage'));
    assert.deepEqual(item.judge, { verdict: 'yes', confidence: 0.8 });
    assert.equal(item.fix?.branch, 'projb');
    assert.deepEqual(item.fix?.commit_shas, [SHA_B55]);
    assert.equal(item.fix?.patch_id, PATCH_P1);
    assert.equal(item.fix?.applies_cleanly, true);
    assert.equal(item.fix?.inherited, true);
    assert.deepEqual(item.fix?.ported_to, ['projc']);
    assert.ok(item.fix?.diff_excerpt);
    assert.ok(item.caveats.some((c) => c.includes('PROJB-56')));
    assert.match(rejected(o, 'PROJC-77') ?? '', /keyword overlap only/);
    assert.match(rejected(o, 'PROJC-78') ?? '', /single signal \(semantic\)/);
    assert.match(rejected(o, 'PROJB-61') ?? '', /no semantic agreement \(error_signature, code_overlap\)/);
    assert.match(rejected(o, 'PROJB-56') ?? '', /duplicate of PROJB-55 \(subtask\)/);
    assert.match(rejected(o, 'PROJC-90') ?? '', /duplicate of PROJB-55 \(same patch-id\)/);
    assert.ok(!JSON.stringify(r).includes('PROJA-100'), 'self is never a candidate');
    assert.deepEqual(r.also_reported.map((x) => x.issue_key), ['PROJB-60'], 'judge kept the weak two-signal ticket');
    assert.ok(semanticPrecedentResultSchema.safeParse(r).success);
    assert.ok(o.excerpts['PROJB-55']);
    assert.ok(!lineage.asked.some((a) => a.endsWith(':platform')), 'lineages never mix evidence');
    const e = o.explain.find((x) => x.issue_key === 'PROJB-55')!;
    assert.ok(e.contributions.semantic > 0 && e.ranks.vector && e.ranks.error && e.ranks.code);
  });

  it('labels ALREADY_PRESENT_HERE when the patch-id is already on this node', async () => {
    const { store, emb } = await buildCorpus();
    const o = await findSemanticPrecedents(deps(store, emb, { judge: yesJudge(), lineage: fakeLineage({ presentOn: async (p) => p === PATCH_P1 }) }), { issue: queryIssue });
    assert.equal(o.result.items[0]?.kind, 'ALREADY_PRESENT_HERE', why(o));
    assert.ok(o.result.items[0]?.caveats.some((c) => /possible regression/.test(c)));
  });

  it('reports a near-duplicate from another lineage as ALSO_REPORTED without lineage evidence', async () => {
    const { store, emb } = await buildCorpus();
    const o = await findSemanticPrecedents(deps(store, emb), { issue: nearDupQuery });
    assert.equal(o.result.outcome, 'FOUND', why(o));
    assert.equal(o.result.judge, 'SKIPPED');
    assert.deepEqual(o.result.items, []);
    assert.deepEqual(o.result.also_reported.map((x) => [x.issue_key, x.kind, x.fix]), [['PROJD-9', 'ALSO_REPORTED', null]]);
    assert.ok(o.result.also_reported[0]?.signals.includes('near_duplicate'));
  });

  it('abstains with NO_MATCH when only keywords agree', async () => {
    const { store, emb } = await buildCorpus();
    const o = await findSemanticPrecedents(deps(store, emb, { judge: yesJudge() }), { issue: abstainQuery });
    assert.equal(o.result.outcome, 'NO_MATCH', why(o));
    assert.equal(o.result.judge, 'SKIPPED');
    assert.match(rejected(o, 'PROJC-77') ?? '', /keyword overlap only/);
    assert.ok(o.result.rejected.every((x) => !/judge/.test(x.reason)));
  });

  it('judge can drop but not add; malformed or failing judge means NOT_RUN with the strict threshold', async () => {
    const { store, emb } = await buildCorpus();
    const dropAll: Judge = { judge: async (req) => ({ schema_version: 1, verdicts: req.keys.map((k) => ({ issue_key: k, same_defect: 'no', confidence: 0.9, shared_evidence: [], differences: ['different'] })) }) };
    const dropped = await findSemanticPrecedents(deps(store, emb, { judge: dropAll }), { issue: queryIssue });
    assert.equal(dropped.result.outcome, 'NO_MATCH');
    assert.match(rejected(dropped, 'PROJB-55') ?? '', /judge: different defect/);

    const adds: Judge = { judge: async (req) => ({ schema_version: 1, verdicts: [...req.keys, 'PROJD-10'].map((k) => ({ issue_key: k, same_defect: 'yes', confidence: 1, shared_evidence: [], differences: [] })) }) };
    for (const judge of [adds, { judge: async () => 'not json at all' }, { judge: async () => { throw new Error('timeout'); } }] as Judge[]) {
      const o = await findSemanticPrecedents(deps(store, emb, { judge }), { issue: queryIssue });
      assert.equal(o.result.judge, 'NOT_RUN');
      assert.deepEqual(o.result.items.map((i) => i.issue_key), ['PROJB-55'], why(o));
      assert.equal(o.result.items[0]?.judge, null);
      assert.deepEqual(o.result.also_reported, [], 'weak candidate fails the strict threshold');
      assert.match(rejected(o, 'PROJB-60') ?? '', /judge not run; score below the strict threshold/);
      assert.ok(![...o.result.items, ...o.result.also_reported].some((x) => x.issue_key === 'PROJD-10'), 'judge cannot add candidates');
    }
  });

  it('returns INDEX_NOT_READY for an empty index or a model mismatch', async () => {
    const { emb } = await buildCorpus();
    const empty = new PrecedentStore(':memory:');
    assert.equal((await findSemanticPrecedents(deps(empty, emb), { issue: queryIssue })).result.outcome, 'INDEX_NOT_READY');
    const { store } = await buildCorpus();
    const other = new (emb.constructor as typeof import('../../packages/precedents/src/index.js').DeterministicFakeEmbedding)({ id: 'other', dims: 256 });
    assert.equal((await findSemanticPrecedents(deps(store, other), { issue: queryIssue })).result.outcome, 'INDEX_NOT_READY');
  });

  it('offers RELATED_FIX only outside the result', async () => {
    const { store, emb } = await buildCorpus();
    const o = await findSemanticPrecedents(deps(store, emb, { judge: yesJudge(), config: { semanticThreshold: 0.99, nearDuplicateThreshold: 0.999 } }), { issue: queryIssue, includeRelated: true });
    assert.ok(o.related.length >= 1, why(o));
    assert.ok(o.related.every((x) => x.kind === 'RELATED_FIX'));
    assert.ok(o.result.items.every((x) => x.kind !== 'RELATED_FIX'));
  });
});
