import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SemanticPrecedentResult } from '@autos/contracts';
import { deriveLabels, findSemanticPrecedents, runEval, type Judge } from '../../packages/precedents/src/index.js';
import { buildCorpus, deps } from './corpus.js';

const yes: Judge = { judge: async (req) => ({ schema_version: 1, verdicts: req.keys.map((k) => ({ issue_key: k, same_defect: 'yes', confidence: 0.9, shared_evidence: [], differences: [] })) }) };

describe('evaluation harness', () => {
  it('derives patch-id, Autos-merged and hard-negative labels from the index', async () => {
    const { store } = await buildCorpus();
    const labels = deriveLabels(store, { autosMerged: [{ issue_key: 'PROJA-100', files: ['src/main/java/com/acme/pricing/PricingEngine.java'] }], inheritedPairs: [['PROJB-55', 'PROJB-56'], ['PROJB-55', 'NOPE-1']], hardNegativeMinOverlap: 0.05 });
    const pairs = labels.positives.map((p) => `${[p.a, p.b].sort().join('~')}:${p.source}`).sort();
    assert.deepEqual(pairs, ['PROJA-100~PROJB-55:autos_merged', 'PROJA-100~PROJC-90:autos_merged', 'PROJB-55~PROJB-56:inherited', 'PROJB-55~PROJC-90:patch_id']);
    assert.ok(labels.hard_negatives.some((n) => [n.a, n.b].sort().join('~') === 'PROJB-55~PROJC-77'), JSON.stringify(labels.hard_negatives));
    assert.ok(labels.no_relative.includes('PROJD-10'));
    assert.ok(!labels.no_relative.includes('PROJB-55'));
  });

  it('computes precision, hard-negative FP rate, recall@5 and abstention', async () => {
    const { store, emb } = await buildCorpus();
    const labels = { positives: [{ a: 'PROJB-55', b: 'PROJC-90', source: 'patch_id' as const }], hard_negatives: [{ a: 'PROJB-55', b: 'PROJC-77' }], no_relative: ['PROJD-10', 'PROJC-77'] };
    const m = await runEval(store, labels, (issue) => findSemanticPrecedents(deps(store, emb, { judge: yes }), { issue }));
    assert.equal(m.queries, 4);
    assert.equal(m.hard_negative_fp_rate, 0);
    assert.equal(m.recall_at_5, 1, JSON.stringify(m));
    assert.equal(m.abstention_rate, 1);
    assert.ok(m.precision !== null && m.precision > 0 && m.precision <= 1);
    assert.equal(m.precision_labeled, 1);

    // A keyword-only baseline that shows every BM25 hit trips the hard negatives.
    const naive = async (issue: { key: string; summary: string }): Promise<SemanticPrecedentResult> => {
      const hits = store.ftsSearch(issue.summary.toLowerCase().split(/\W+/).filter((t) => t.length > 3), 5).map((h) => store.getIssue(h.issue_id)!).filter((i) => i.key !== issue.key);
      const items = hits.map((i) => ({ issue_key: i.key, issue_url: `https://jira.example.test/browse/${i.key}`, project_key: i.project, summary: i.summary, status: i.status, resolution: i.resolution,
        kind: 'ALSO_REPORTED' as const, score: 0.5, signals: ['keyword' as const], judge: null, fix: null, caveats: [] }));
      return { schema_version: 1, outcome: items.length ? 'FOUND' : 'NO_MATCH', judge: 'SKIPPED', items: [], also_reported: items, rejected: [], checked: items.length, index: null };
    };
    const b = await runEval(store, { ...labels, positives: [], hard_negatives: [{ a: 'PROJC-77', b: 'PROJB-55' }], no_relative: [] }, naive);
    assert.equal(b.hard_negative_fp_rate, 1, JSON.stringify(b));
  });
});
