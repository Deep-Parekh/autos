import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AutosError } from '@autos/contracts';
import { BruteForceVectorIndex, DeterministicFakeEmbedding, PrecedentStore, prepareIssue } from '../../packages/precedents/src/index.js';
import { issue } from './fixtures.js';

let root: string;
let store: PrecedentStore;
const MODEL = { id: 'fake-embed', dims: 8 };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'autos-prec-store-')); store = new PrecedentStore(join(root, 'data', 'precedents.sqlite'), { model: MODEL }); });
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

const vec = (...xs: number[]) => Float32Array.from([...xs, ...Array(8 - xs.length).fill(0)]);

describe('PrecedentStore', () => {
  it('creates a private database with migrations and FTS5', async () => {
    assert.equal(store.schemaVersion(), 1);
    assert.equal((await stat(join(root, 'data', 'precedents.sqlite'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'data'))).mode & 0o777, 0o700);
    store.close(); store = new PrecedentStore(join(root, 'data', 'precedents.sqlite'), { model: MODEL });
    assert.equal(store.schemaVersion(), 1, 'reopen is idempotent');
    assert.throws(() => new PrecedentStore('relative.sqlite'), (e: unknown) => e instanceof AutosError && e.code === 'INVALID_INPUT');
  });

  it('upsert is idempotent by content hash and only changed chunks need vectors', () => {
    const base = issue({ id: '10', key: 'PROJA-1', summary: 'Cart total negative', description: 'The cart total becomes negative after removing a coupon.' });
    const first = store.upsertIssue(prepareIssue(base));
    assert.equal(first.changed, true);
    assert.equal(first.needs_vectors.length, 2, 'defect + one head chunk');
    store.setVectors(first.needs_vectors.map((id) => ({ chunk_id: id, vector: vec(1) })));
    const again = store.upsertIssue(prepareIssue({ ...base, updated_at: '2026-10-05T00:00:00.000Z' }));
    assert.deepEqual(again, { changed: false, needs_vectors: [] });
    assert.equal(store.getIssue('10')?.updated_at, '2026-10-05T00:00:00.000Z');
    // A new comment changes only the comment chunk (not embedded) — and nothing needs vectors.
    const withComment = store.upsertIssue(prepareIssue({ ...base, comments: [{ id: '1', author_is_app: false, created: '2026-10-02T00:00:00.000Z', body: 'still broken on staging' }] }));
    assert.equal(withComment.changed, true);
    assert.equal(withComment.needs_vectors.length, 1, 'defect statement changed (comment-derived observation), head unchanged');
    // Description change: head + defect need vectors again.
    const changed = store.upsertIssue(prepareIssue({ ...base, description: 'Totally different: export to CSV hangs.' }));
    assert.equal(changed.needs_vectors.length, 2);
    assert.equal(store.status().missing_vectors, 2);
    assert.equal(store.ftsRowCount(), store.status().chunks, 'FTS kept in sync by triggers');
    assert.equal(store.ftsSearch(['coupon']).length, 0);
    assert.equal(store.ftsSearch(['hangs'])[0]?.issue_id, '10');
  });

  it('keeps old keys as aliases when an issue moves', () => {
    store.upsertIssue(prepareIssue(issue({ id: '11', key: 'PROJA-2', summary: 'Moved bug' })));
    store.upsertIssue(prepareIssue(issue({ id: '11', key: 'PROJB-9', project_key: 'PROJB', summary: 'Moved bug' })));
    const moved = store.getIssueByKey('PROJA-2');
    assert.equal(moved?.key, 'PROJB-9');
    assert.deepEqual(moved?.aliases, ['PROJA-2']);
    assert.equal(store.getIssueByKey('PROJB-9')?.id, '11');
    assert.equal(store.status().issues, 1);
  });

  it('deletes issues with chunks, FTS rows, vectors, signatures and fixes; purges by project and window', () => {
    const a = store.upsertIssue(prepareIssue(issue({ id: '1', key: 'PROJA-1', description: 'Fails with OrderPricingException in OrderService' })));
    store.setVectors(a.needs_vectors.map((id) => ({ chunk_id: id, vector: vec(1) })));
    store.upsertIssue(prepareIssue(issue({ id: '2', key: 'PROJB-1', updated_at: '2020-01-01T00:00:00.000Z' })));
    store.upsertIssue(prepareIssue(issue({ id: '3', key: 'PROJC-1' })));
    store.upsertFixes([{ lineage_id: 'core', commit_sha: 'a'.repeat(40), patch_id: 'b'.repeat(40), issue_keys: ['PROJA-1'], source: 'commit_message', committed_at: '2026-10-01T00:00:00.000Z', subject: 'fix', files: [{ path: 'src/OrderService.java', additions: 1, deletions: 1 }], contained_in: ['proja'], reverted_by: null }]);
    assert.equal(store.status().fixes, 1);
    assert.equal(store.deleteIssues(['1']), 1);
    const s = store.status();
    assert.deepEqual([s.issues, s.vectors, s.error_sigs, s.fixes], [2, 0, 0, 0]);
    assert.equal(store.ftsRowCount(), s.chunks);
    assert.equal(store.purgeOlderThan('2024-01-01T00:00:00.000Z'), 1);
    assert.equal(store.purgeProject('PROJC'), 1);
    assert.equal(store.status().issues, 0);
    assert.equal(store.ftsRowCount(), 0);
  });

  it('refuses a different model or dims (rebuild required) and validates vector dims', () => {
    store.close();
    assert.throws(() => new PrecedentStore(join(root, 'data', 'precedents.sqlite'), { model: { id: 'other', dims: 8 } }), /rebuild required/);
    assert.throws(() => new PrecedentStore(join(root, 'data', 'precedents.sqlite'), { model: { id: 'fake-embed', dims: 16 } }), (e: unknown) => e instanceof AutosError && e.code === 'CONFLICT');
    store = new PrecedentStore(join(root, 'data', 'precedents.sqlite'));
    const r = store.upsertIssue(prepareIssue(issue({ id: '1', key: 'PROJA-1' })));
    assert.throws(() => store.setVectors([{ chunk_id: r.needs_vectors[0] as number, vector: new Float32Array(4) }]), /dimension/);
    store.setVectors(r.needs_vectors.map((id) => ({ chunk_id: id, vector: vec(1) })));
    store.resetVectors({ id: 'other', dims: 4 });
    assert.equal(store.status().vectors, 0);
    assert.deepEqual(store.modelInfo(), { id: 'other', dims: 4 });
  });

  it('brute-force KNN streams batches and ranks by cosine', async () => {
    const emb = new DeterministicFakeEmbedding({ dims: 8, groups: [{ id: 'g', pattern: /coupon/ }] });
    store.close(); await rm(join(root, 'data'), { recursive: true }); store = new PrecedentStore(join(root, 'data', 'p.sqlite'), { model: emb.model() });
    const texts = ['coupon makes total negative', 'export hangs', 'coupon removal bug', 'login slow', 'report empty'];
    for (const [i, t] of texts.entries()) {
      const r = store.upsertIssue(prepareIssue(issue({ id: String(i + 1), key: `PROJA-${i + 1}`, summary: t })));
      const chunks = store.chunkTexts(r.needs_vectors);
      const vectors = await emb.embed([...chunks.values()]);
      store.setVectors([...chunks.keys()].map((id, j) => ({ chunk_id: id, vector: vectors[j] as Float32Array })));
    }
    const [q] = await emb.embed(['a coupon question']);
    const hits = new BruteForceVectorIndex(store, 3).knn(q as Float32Array, { k: 3, kinds: ['defect'], excludeIssueIds: new Set(['3']) });
    assert.equal(hits.length, 3);
    assert.equal(hits[0]?.issue_id, '1');
    assert.ok((hits[0]?.score ?? 0) > 0.8 && (hits[1]?.score ?? 1) < 0.8);
    assert.ok(!hits.some((h) => h.issue_id === '3'));
    assert.throws(() => new BruteForceVectorIndex(store).knn(new Float32Array(3), { k: 1 }), /rebuild required/);
  });

  it('stores sync state, term stats, templates and lineage facts', () => {
    store.setState('cursor', { updated: 'x' });
    assert.deepEqual(store.getState('cursor'), { updated: 'x' });
    store.saveTermStats({ doc_count: 3, df: new Map([['acme', 3]]), stoplist: new Set(['acme', 'the']) });
    const stats = store.loadTermStats();
    assert.ok(stats?.stoplist.has('acme') && stats.df.get('acme') === 3);
    store.saveTemplate({ project: 'PROJA', lines: ['steps to reproduce'], hash: 'h' });
    assert.deepEqual(store.loadTemplates().get('PROJA'), ['steps to reproduce']);
    store.setFixPresence('core', 'b'.repeat(40), 'PROJA', true);
    store.setFixInheritance('core', 'a'.repeat(40), 'PROJA', false);
    assert.equal(store.fixPresence('core', 'b'.repeat(40), 'PROJA'), true);
    assert.equal(store.fixInheritance('core', 'a'.repeat(40), 'PROJA'), false);
    assert.equal(store.fixPresence('core', 'c'.repeat(40), 'PROJA'), null);
    store.upsertLineageNodes([{ lineage_id: 'core', project_key: 'PROJA', branch: 'proja', fork_point: 'c'.repeat(40), fork_date: '2021-06-01T00:00:00.000Z', side_branches: [{ branch: 'pa_dev', kind: 'dev', method: 'name' }] }]);
    assert.equal(store.lineageNodes()[0]?.side_branches[0]?.branch, 'pa_dev');
  });
});
