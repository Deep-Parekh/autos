import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutosError, type IndexedComment, type IndexedIssue } from '@autos/contracts';
import { DeterministicFakeEmbedding, IndexSync, PrecedentStore, type JiraIndexSource } from '../../packages/precedents/src/index.js';
import { issue } from './fixtures.js';

class FakeSource implements JiraIndexSource {
  issues = new Map<string, IndexedIssue>();
  extraComments = new Map<string, IndexedComment[]>();
  calls: string[] = [];
  searches: Array<{ since: string | null; token: string | null }> = [];
  failWith: AutosError | null = null;
  listPageSize = 2;
  async searchIssuesForIndex(opts: { projects: string[]; updatedSince: string | null; pageToken: string | null; pageSize: number }) {
    this.calls.push('search'); this.searches.push({ since: opts.updatedSince, token: opts.pageToken });
    if (this.failWith) throw this.failWith;
    const all = [...this.issues.values()].filter((i) => opts.projects.includes(i.project_key) && (!opts.updatedSince || i.updated_at >= opts.updatedSince))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || Number(a.id) - Number(b.id));
    const start = Number(opts.pageToken ?? 0);
    const page = all.slice(start, start + opts.pageSize);
    return { issues: page, nextPageToken: start + opts.pageSize < all.length ? String(start + opts.pageSize) : null, skipped_restricted: 1, skipped_invalid: 0 };
  }
  async getIndexComments(issueId: string, startAt: number) {
    this.calls.push(`comments:${issueId}:${startAt}`);
    const rest = this.extraComments.get(issueId) ?? [];
    const offset = startAt - (this.issues.get(issueId)?.comments.length ?? 0);
    const page = rest.slice(offset, offset + 2);
    return { comments: page, next_start_at: offset + 2 < rest.length ? startAt + 2 : null, skipped_invalid: 0 };
  }
  async listIssueIds(opts: { projects: string[]; pageToken: string | null }) {
    this.calls.push('list');
    const all = [...this.issues.values()].filter((i) => opts.projects.includes(i.project_key)).sort((a, b) => a.id.localeCompare(b.id));
    const start = Number(opts.pageToken ?? 0);
    return { ids: all.slice(start, start + this.listPageSize).map((i) => ({ id: i.id, key: i.key, updated: i.updated_at })), nextPageToken: start + this.listPageSize < all.length ? String(start + this.listPageSize) : null };
  }
}

const NOW = new Date('2026-11-12T12:00:00.000Z');
const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();
function setup(n = 5) {
  const store = new PrecedentStore(':memory:');
  const source = new FakeSource();
  for (let i = 1; i <= n; i++) source.issues.set(String(i), issue({ id: String(i), key: `PROJA-${i}`, summary: `Issue ${i} fails`, description: `The widget ${i} crashes with Widget${i}Exception`, updated_at: at(i) }));
  const embedder = new DeterministicFakeEmbedding({ dims: 16 });
  const sync = (opts: Partial<ConstructorParameters<typeof IndexSync>[2]> = {}) => new IndexSync(store, source, { projects: ['PROJA'], pageSize: 2, minSpacingMs: 0, embedder, now: () => NOW, relearnAfterFull: false, ...opts });
  return { store, source, embedder, sync };
}

describe('IndexSync', () => {
  it('paginates a full sync, embeds changed chunks and advances the cursor', async () => {
    const { store, source, sync } = setup();
    const r = await sync().sync();
    assert.equal(r.mode, 'full'); assert.equal(r.completed, true); assert.equal(r.error_code, null);
    assert.equal(r.requests, 3); assert.equal(r.issues_seen, 5); assert.equal(r.issues_changed, 5); assert.equal(r.skipped_restricted, 3);
    assert.equal(r.vectors_written, 10);
    assert.equal(store.status().missing_vectors, 0);
    const s = sync().status();
    assert.equal(s.cursor, at(5)); assert.ok(s.last_full_at); assert.equal(s.in_progress, null); assert.equal(s.last_run?.issues_seen, 5);
    assert.deepEqual(source.searches.map((x) => x.token), [null, '2', '4']);
  });

  it('stops at the request budget and resumes from the saved page', async () => {
    const { store, source, sync } = setup();
    const first = await sync({ maxRequestsPerRun: 2 }).sync();
    assert.equal(first.completed, false); assert.equal(first.budget_exhausted, true); assert.equal(first.error_code, null);
    assert.equal(store.status().issues, 4);
    assert.equal(sync().status().in_progress?.pages, 2);
    source.searches.length = 0;
    const second = await sync().sync();
    assert.equal(second.completed, true); assert.equal(second.mode, 'full');
    assert.deepEqual(source.searches.map((x) => x.token), ['4'], 'resumed at the saved page token');
    assert.equal(store.status().issues, 5);
  });

  it('incremental sync re-reads the overlap idempotently and only embeds what changed', async () => {
    const { store, source, sync, embedder } = setup();
    await sync().sync();
    const embedCalls = embedder.texts.length;
    source.searches.length = 0;
    const r = await sync().sync();
    assert.equal(r.mode, 'incremental');
    assert.equal(source.searches[0]?.since, new Date(Date.parse(at(5)) - 24 * 3_600_000).toISOString(), 'default overlap is 24 h');
    assert.equal(r.issues_seen, 5); assert.equal(r.issues_changed, 0); assert.equal(r.vectors_written, 0);
    assert.equal(embedder.texts.length, embedCalls);
    source.issues.set('3', { ...source.issues.get('3') as IndexedIssue, description: 'Now a completely different export hang', updated_at: at(6) });
    const r2 = await sync({ overlapMs: 10 * 60_000 }).sync();
    assert.equal(r2.issues_changed, 1); assert.equal(r2.vectors_written, 2);
    assert.equal(source.searches.at(-1)?.since, new Date(Date.parse(at(5)) - 600_000).toISOString());
    assert.equal(store.status().issues, 5);
  });

  it('fetches remaining comments for truncated issues', async () => {
    const { store, source, sync } = setup(1);
    const c = (id: number): IndexedComment => ({ id: String(id), author_is_app: false, created: at(1), body: `comment ${id} about the crash` });
    source.issues.set('1', { ...source.issues.get('1') as IndexedIssue, comments: [c(1)], comments_truncated: true });
    source.extraComments.set('1', [c(2), c(3), c(4)]);
    const r = await sync().sync();
    assert.equal(r.completed, true);
    assert.deepEqual(source.calls.filter((x) => x.startsWith('comments')), ['comments:1:1', 'comments:1:3']);
    assert.equal(store.getIssueDoc('1')?.comments.length, 4);
    assert.equal(store.getIssueDoc('1')?.comments_truncated, false);
  });

  it('reconcile deletes ids no longer listed and issues outside the window or scope', async () => {
    const { store, source, sync } = setup();
    await sync().sync();
    store.upsertIssue((await import('../../packages/precedents/src/index.js')).prepareIssue(issue({ id: '99', key: 'OLD-1', updated_at: '2020-01-01T00:00:00.000Z' })));
    source.issues.delete('2');
    const r = await sync().sync({ reconcile: true });
    assert.equal(r.reconciled, true);
    assert.equal(r.deleted, 2);
    assert.deepEqual(store.listIssueIds(), ['1', '3', '4', '5']);
  });

  it('does not delete anything when the reconcile listing is incomplete', async () => {
    const { store, source, sync } = setup();
    await sync().sync();
    source.issues.delete('2');
    const r = await sync({ maxRequestsPerRun: 2 }).sync({ reconcile: true });
    assert.equal(r.budget_exhausted, true); assert.equal(r.reconciled, false);
    assert.equal(store.status().issues, 5);
    assert.equal(sync().status().in_progress, null, 'a completed incremental run is not resumed');
  });

  it('records only the error code on auth failure and keeps progress', async () => {
    const { source, sync } = setup();
    source.failWith = new AutosError('AUTH', 'Jira said: token xyz invalid');
    const r = await sync().sync();
    assert.equal(r.error_code, 'AUTH'); assert.equal(r.completed, false);
    assert.doesNotMatch(JSON.stringify(sync().status()), /xyz/);
  });

  it('is single-flight and honors abort', async () => {
    const { source, sync } = setup();
    const s = sync();
    const [a, b] = [s.sync(), s.sync()];
    assert.equal(a, b);
    await a;
    assert.equal(source.searches.length, 3);
    const ac = new AbortController(); ac.abort();
    const r = await s.sync({ signal: ac.signal });
    assert.equal(r.error_code, 'CANCELLED');
  });

  it('relearns templates and the stoplist after a full sync', async () => {
    const { store, source, sync } = setup(0);
    for (let i = 1; i <= 25; i++) source.issues.set(String(i), issue({ id: String(i), key: `PROJA-${i}`, summary: `Acmeshop problem ${i}`, description: `h2. Steps to reproduce\nAcmeshop thing${"abcdefghijklmnopqrstuvwxyz"[i]} breaks`, updated_at: at(1) }));
    const r = await sync({ relearnAfterFull: true, pageSize: 100 }).sync();
    assert.equal(r.completed, true);
    assert.deepEqual(store.loadTemplates().get('PROJA'), ['steps to reproduce']);
    assert.ok(store.loadTermStats()?.stoplist.has('acmeshop'));
    assert.equal(store.status().missing_vectors, 0);
  });

  it('refuses invalid project keys', () => {
    assert.throws(() => new IndexSync(new PrecedentStore(':memory:'), new FakeSource(), { projects: ['bad key'] }), /Invalid project key/);
  });
});
