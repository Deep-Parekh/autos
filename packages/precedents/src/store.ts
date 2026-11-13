import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { AutosError, type FixCommit, type IndexedIssue, type LineageNode } from '@autos/contracts';
import { EMBEDDED_CHUNK_KINDS, ftsMatchExpression, type ChunkKind, type CodeRef, type ErrorSignature, type PreparedIssue, type ProjectTemplate, type TermStats } from './text.js';

/** Default location, relative to the Autos data directory; callers pass an absolute path. */
export const DEFAULT_PRECEDENTS_DB = 'data/precedents.sqlite';

export interface EmbeddingModelInfo { id: string; dims: number }

export interface StoredIssue {
  id: string; key: string; aliases: string[]; project: string; type: string; status: string; resolution: string | null;
  resolved_at: string | null; created_at: string; updated_at: string; summary: string; link_keys: string[]; parent_key: string | null;
  defect: string; defect_public: string; description_clean: string; defect_score: number; content_hash: string;
}

export interface StoredFix {
  issue_id: string; lineage_id: string; commit_sha: string; patch_id: string | null; files: string[]; reverted: boolean; subject: string;
  committed_at: string; contained_in: string[]; autos_job_id: string | null; autos_outcome: string | null;
}

export interface StoreStatus {
  issues: number; chunks: number; vectors: number; missing_vectors: number; error_sigs: number; code_refs: number; fixes: number;
  projects: Record<string, number>; model: EmbeddingModelInfo | null; last_updated: string | null;
}

export interface ChunkHit { chunk_id: number; issue_id: string; kind: ChunkKind; score: number }

const nowIso = () => new Date().toISOString();
const str = (v: SQLOutputValue | undefined): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: SQLOutputValue | undefined): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: SQLOutputValue | undefined): number => Number(v ?? 0);
const json = <T>(v: SQLOutputValue | undefined, fallback: T): T => { try { return v ? JSON.parse(String(v)) as T : fallback; } catch { return fallback; } };

/** Encodes a vector as a little-endian float32 BLOB, L2-normalized so cosine similarity is a dot product. */
export function encodeVector(v: Float32Array | number[]): Uint8Array {
  const out = new Float32Array(v.length); let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
  return new Uint8Array(out.buffer);
}
export function decodeVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength); copy.set(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/**
 * Local precedent index in its own SQLite file (plan §4), separate from the job database so it can be rebuilt.
 * FTS5 (external content over `chunks`, kept in sync by triggers) and float32 vector BLOBs keyed by chunk id.
 */
export class PrecedentStore {
  readonly db: DatabaseSync;
  constructor(path: string, opts: { model?: EmbeddingModelInfo } = {}) {
    if (path !== ':memory:') {
      if (!isAbsolute(path)) throw new AutosError('INVALID_INPUT', 'Precedent index path must be absolute');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { if (lstatSync(path).isSymbolicLink()) throw new AutosError('POLICY', 'Precedent index symlinks are not allowed'); } catch (error) { if (error instanceof AutosError) throw error; }
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.migrate();
    if (opts.model) this.assertModel(opts.model);
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, key TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', project TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL, resolution TEXT, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, summary TEXT NOT NULL,
        link_keys TEXT NOT NULL DEFAULT '[]', parent_key TEXT, defect TEXT NOT NULL, defect_public TEXT NOT NULL, description_clean TEXT NOT NULL,
        defect_score REAL NOT NULL DEFAULT 0, doc TEXT NOT NULL, content_hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS issues_key_idx ON issues(key);
      CREATE INDEX IF NOT EXISTS issues_project_idx ON issues(project, updated_at);
      CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL, UNIQUE(issue_id, kind, ord));
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TABLE IF NOT EXISTS vectors (chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE, model TEXT NOT NULL, dims INTEGER NOT NULL, vec BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS error_sigs (sig TEXT NOT NULL, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, kind TEXT NOT NULL, strong INTEGER NOT NULL,
        display TEXT NOT NULL, PRIMARY KEY(sig, issue_id));
      CREATE INDEX IF NOT EXISTS error_sigs_issue_idx ON error_sigs(issue_id);
      CREATE TABLE IF NOT EXISTS code_refs (issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, node TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, path TEXT NOT NULL,
        PRIMARY KEY(issue_id, node, kind, path));
      CREATE INDEX IF NOT EXISTS code_refs_path_idx ON code_refs(path);
      CREATE TABLE IF NOT EXISTS fixes (issue_id TEXT NOT NULL, lineage TEXT NOT NULL, commit_sha TEXT NOT NULL, patch_id TEXT, files TEXT NOT NULL, reverted INTEGER NOT NULL,
        subject TEXT NOT NULL, committed_at TEXT NOT NULL, contained_in TEXT NOT NULL, source TEXT NOT NULL, autos_job_id TEXT, autos_outcome TEXT,
        PRIMARY KEY(issue_id, lineage, commit_sha));
      CREATE INDEX IF NOT EXISTS fixes_patch_idx ON fixes(patch_id);
      CREATE TABLE IF NOT EXISTS fix_presence (lineage TEXT NOT NULL, patch_id TEXT NOT NULL, node TEXT NOT NULL, present INTEGER NOT NULL, PRIMARY KEY(lineage, patch_id, node));
      CREATE TABLE IF NOT EXISTS fix_inheritance (lineage TEXT NOT NULL, commit_sha TEXT NOT NULL, node TEXT NOT NULL, inherited INTEGER NOT NULL, PRIMARY KEY(lineage, commit_sha, node));
      CREATE TABLE IF NOT EXISTS lineage_nodes (lineage TEXT NOT NULL, branch TEXT NOT NULL, project_key TEXT NOT NULL, fork_point TEXT NOT NULL, fork_date TEXT NOT NULL,
        side_branches TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(lineage, project_key));
      CREATE TABLE IF NOT EXISTS term_stats (term TEXT PRIMARY KEY, df INTEGER NOT NULL, stop INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_templates (project TEXT NOT NULL, line TEXT NOT NULL, PRIMARY KEY(project, line));
      CREATE TABLE IF NOT EXISTS sync_state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS code_ref_scans (issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, node TEXT NOT NULL, content_hash TEXT NOT NULL,
        PRIMARY KEY(issue_id, node));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, '${nowIso()}');`);
  }

  schemaVersion(): number { return num(this.db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v); }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
  }
  private meta(key: string): string | null { return strOrNull(this.db.prepare('SELECT value FROM index_meta WHERE key=?').get(key)?.value); }
  private setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }

  // ---- Embedding model ----

  modelInfo(): EmbeddingModelInfo | null {
    const id = this.meta('model_id'); const dims = this.meta('model_dims');
    return id && dims ? { id, dims: Number(dims) } : null;
  }
  /** Records the model on first use; a different model or dims means the vectors are unusable: rebuild required. */
  assertModel(model: EmbeddingModelInfo): void {
    const current = this.modelInfo();
    if (!current) { this.setMeta('model_id', model.id); this.setMeta('model_dims', String(model.dims)); return; }
    if (current.id !== model.id || current.dims !== model.dims) throw new AutosError('CONFLICT', 'Precedent index was built with a different embedding model or dimension; rebuild required');
  }
  /** Drops every vector and records a new model (used by `index rebuild`). Chunks and text stay. */
  resetVectors(model: EmbeddingModelInfo): void {
    this.tx(() => { this.db.exec('DELETE FROM vectors'); this.setMeta('model_id', model.id); this.setMeta('model_dims', String(model.dims)); });
  }

  // ---- Issues ----

  /**
   * Inserts or updates one prepared issue. Idempotent by content hash: an unchanged issue only refreshes
   * `updated_at`. Unchanged chunks keep their ids and vectors; returns the chunk ids that need (new) vectors.
   */
  upsertIssue(p: PreparedIssue): { changed: boolean; needs_vectors: number[] } {
    const i = p.issue;
    return this.tx(() => {
      const existing = this.db.prepare('SELECT key, aliases, content_hash FROM issues WHERE id=?').get(i.id);
      if (existing && str(existing.content_hash) === p.content_hash && str(existing.key) === i.key) {
        this.db.prepare('UPDATE issues SET updated_at=? WHERE id=?').run(i.updated_at, i.id);
        return { changed: false, needs_vectors: [] };
      }
      const aliases = new Set(json<string[]>(existing?.aliases, []));
      if (existing && str(existing.key) !== i.key) aliases.add(str(existing.key));
      aliases.delete(i.key);
      const values: SQLInputValue[] = [i.key, JSON.stringify([...aliases].sort()), i.project_key, i.issue_type, i.status, i.resolution, i.resolved_at, i.created_at, i.updated_at,
        i.summary, JSON.stringify(i.link_keys), i.parent_key, p.defect.text, p.defect_public, p.description_clean, p.defect_score, JSON.stringify(i), p.content_hash, nowIso()];
      if (existing) {
        this.db.prepare(`UPDATE issues SET key=?, aliases=?, project=?, type=?, status=?, resolution=?, resolved_at=?, created_at=?, updated_at=?, summary=?, link_keys=?,
          parent_key=?, defect=?, defect_public=?, description_clean=?, defect_score=?, doc=?, content_hash=?, indexed_at=? WHERE id=?`).run(...values, i.id);
      } else {
        this.db.prepare(`INSERT INTO issues(key, aliases, project, type, status, resolution, resolved_at, created_at, updated_at, summary, link_keys, parent_key, defect,
          defect_public, description_clean, defect_score, doc, content_hash, indexed_at, id) VALUES (${Array(20).fill('?').join(',')})`).run(...values, i.id);
      }
      // Chunks: keep (kind, ord) rows whose text hash is unchanged; replace the rest.
      const old = new Map(this.db.prepare('SELECT id, kind, ord, text_hash FROM chunks WHERE issue_id=?').all(i.id).map((r) => [`${str(r.kind)}:${num(r.ord)}`, { id: num(r.id), hash: str(r.text_hash) }]));
      const needs: number[] = [];
      const insert = this.db.prepare('INSERT INTO chunks(issue_id, kind, ord, text, text_hash) VALUES (?, ?, ?, ?, ?)');
      const del = this.db.prepare('DELETE FROM chunks WHERE id=?');
      for (const c of p.chunks) {
        const k = `${c.kind}:${c.ord}`; const prev = old.get(k); old.delete(k);
        if (prev && prev.hash === c.hash) continue;
        if (prev) del.run(prev.id);
        const id = Number(insert.run(i.id, c.kind, c.ord, c.text, c.hash).lastInsertRowid);
        if (EMBEDDED_CHUNK_KINDS.includes(c.kind)) needs.push(id);
      }
      for (const stale of old.values()) del.run(stale.id);
      // A kept chunk may still lack a vector (earlier embedding failed): report it too.
      for (const r of this.db.prepare(`SELECT c.id FROM chunks c LEFT JOIN vectors v ON v.chunk_id=c.id WHERE c.issue_id=? AND v.chunk_id IS NULL AND c.kind IN (${EMBEDDED_CHUNK_KINDS.map(() => '?').join(',')})`).all(i.id, ...EMBEDDED_CHUNK_KINDS)) {
        const id = num(r.id); if (!needs.includes(id)) needs.push(id);
      }
      this.db.prepare('DELETE FROM error_sigs WHERE issue_id=?').run(i.id);
      const sig = this.db.prepare('INSERT OR IGNORE INTO error_sigs(sig, issue_id, kind, strong, display) VALUES (?, ?, ?, ?, ?)');
      for (const s of p.signatures) sig.run(s.key, i.id, s.kind, s.strong ? 1 : 0, s.display.slice(0, 300));
      this.db.prepare("DELETE FROM code_refs WHERE issue_id=? AND node=''").run(i.id);
      const ref = this.db.prepare("INSERT OR IGNORE INTO code_refs(issue_id, node, kind, path) VALUES (?, '', ?, ?)");
      for (const r of p.code_refs) ref.run(i.id, r.kind, r.value);
      return { changed: true, needs_vectors: needs.sort((a, b) => a - b) };
    });
  }

  /** Records resolved code paths for an issue on a node (from trusted Git path resolution). */
  setResolvedCodeRefs(issueId: string, node: string, paths: string[]): void {
    if (!node) throw new AutosError('INVALID_INPUT', 'Node is required for resolved code refs');
    this.tx(() => {
      this.db.prepare('DELETE FROM code_refs WHERE issue_id=? AND node=?').run(issueId, node);
      const ins = this.db.prepare("INSERT OR IGNORE INTO code_refs(issue_id, node, kind, path) VALUES (?, ?, 'path', ?)");
      for (const p of paths) ins.run(issueId, node, p);
    });
  }

  /** Records resolved code paths for an issue on a node and remembers the content hash they were resolved for. */
  setResolvedCodeRefsScanned(issueId: string, node: string, paths: string[], contentHash: string): void {
    this.setResolvedCodeRefs(issueId, node, paths);
    this.db.prepare('INSERT INTO code_ref_scans(issue_id, node, content_hash) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE id=?) ON CONFLICT(issue_id, node) DO UPDATE SET content_hash=excluded.content_hash')
      .run(issueId, node, contentHash, issueId);
  }

  /**
   * Issues of the given projects whose ticket identifiers (path/class refs) were not yet resolved on `node` for their
   * current content, oldest first. Issues without identifiers are skipped.
   */
  issuesNeedingPathResolution(project: string, node: string, limit: number): Array<{ id: string; content_hash: string; identifiers: string[] }> {
    const rows = this.db.prepare(`SELECT i.id, i.content_hash FROM issues i LEFT JOIN code_ref_scans s ON s.issue_id=i.id AND s.node=?
      WHERE i.project=? AND (s.content_hash IS NULL OR s.content_hash<>i.content_hash)
      AND EXISTS (SELECT 1 FROM code_refs c WHERE c.issue_id=i.id AND c.node='' AND c.kind IN ('path','class')) ORDER BY i.updated_at, i.id LIMIT ?`).all(node, project, limit);
    const refs = this.db.prepare("SELECT path FROM code_refs WHERE issue_id=? AND node='' AND kind IN ('path','class') ORDER BY path");
    return rows.map((r) => ({ id: str(r.id), content_hash: str(r.content_hash), identifiers: refs.all(str(r.id)).map((x) => str(x.path)) }));
  }

  /** Marks stored fix commits as reverted (a later scan saw the revert). Returns the rows changed. */
  markFixesReverted(lineage: string, commitShas: string[]): number {
    if (!commitShas.length) return 0;
    const stmt = this.db.prepare('UPDATE fixes SET reverted=1 WHERE lineage=? AND commit_sha=? AND reverted=0');
    return this.tx(() => commitShas.reduce((n, sha) => n + Number(stmt.run(lineage, sha).changes), 0));
  }

  /** Hard-deletes issues with their chunks, FTS rows, vectors, signatures, code refs and fix links. Returns the count. */
  deleteIssues(ids: string[]): number {
    if (!ids.length) return 0;
    return this.tx(() => {
      let n = 0;
      const delIssue = this.db.prepare('DELETE FROM issues WHERE id=?'); const delFix = this.db.prepare('DELETE FROM fixes WHERE issue_id=?');
      for (const id of ids) { n += Number(delIssue.run(id).changes); delFix.run(id); }
      return n;
    });
  }
  purgeProject(project: string): number { return this.deleteIssues(this.db.prepare('SELECT id FROM issues WHERE project=?').all(project).map((r) => str(r.id))); }
  /** Purges issues last updated before `cutoffIso` (aged out of the index window). */
  purgeOlderThan(cutoffIso: string): number { return this.deleteIssues(this.db.prepare('SELECT id FROM issues WHERE updated_at < ?').all(cutoffIso).map((r) => str(r.id))); }
  /** Purges issues whose project is not in `projects`. */
  purgeProjectsNotIn(projects: string[]): number {
    const keep = new Set(projects);
    return this.deleteIssues(this.db.prepare('SELECT id, project FROM issues').all().filter((r) => !keep.has(str(r.project))).map((r) => str(r.id)));
  }

  listIssueIds(): string[] { return this.db.prepare('SELECT id FROM issues ORDER BY id').all().map((r) => str(r.id)); }

  private toIssue(r: Record<string, SQLOutputValue>): StoredIssue {
    return { id: str(r.id), key: str(r.key), aliases: json(r.aliases, []), project: str(r.project), type: str(r.type), status: str(r.status), resolution: strOrNull(r.resolution),
      resolved_at: strOrNull(r.resolved_at), created_at: str(r.created_at), updated_at: str(r.updated_at), summary: str(r.summary), link_keys: json(r.link_keys, []),
      parent_key: strOrNull(r.parent_key), defect: str(r.defect), defect_public: str(r.defect_public), description_clean: str(r.description_clean),
      defect_score: num(r.defect_score), content_hash: str(r.content_hash) };
  }
  getIssue(id: string): StoredIssue | null { const r = this.db.prepare('SELECT * FROM issues WHERE id=?').get(id); return r ? this.toIssue(r) : null; }
  /** Looks up by current key, then by alias (moved issues keep their old keys). */
  getIssueByKey(key: string): StoredIssue | null {
    const r = this.db.prepare('SELECT * FROM issues WHERE key=?').get(key) ?? this.db.prepare('SELECT i.* FROM issues i, json_each(i.aliases) a WHERE a.value=? LIMIT 1').get(key);
    return r ? this.toIssue(r) : null;
  }
  getIssues(ids: string[]): Map<string, StoredIssue> {
    const out = new Map<string, StoredIssue>(); const stmt = this.db.prepare('SELECT * FROM issues WHERE id=?');
    for (const id of new Set(ids)) { const r = stmt.get(id); if (r) out.set(id, this.toIssue(r)); }
    return out;
  }
  /** The stored (redacted) issue document, for reprocessing and evaluation queries. */
  getIssueDoc(id: string): IndexedIssue | null { const r = this.db.prepare('SELECT doc FROM issues WHERE id=?').get(id); return r ? json<IndexedIssue | null>(r.doc, null) : null; }
  allIssueDocs(): IndexedIssue[] { return this.db.prepare('SELECT doc FROM issues ORDER BY id').all().map((r) => json<IndexedIssue | null>(r.doc, null)).filter((d): d is IndexedIssue => d !== null); }
  /** Ids of issues whose link_keys mention `key`. */
  issuesLinkingTo(key: string): string[] { return this.db.prepare('SELECT i.id FROM issues i, json_each(i.link_keys) l WHERE l.value=?').all(key).map((r) => str(r.id)); }
  idsForKeys(keys: string[]): string[] { return keys.map((k) => this.getIssueByKey(k)?.id).filter((x): x is string => !!x); }

  // ---- Vectors ----

  /** Chunks of embedded kinds without a vector for the current model (resume after a failed embedding run). */
  chunksMissingVectors(limit: number): Array<{ id: number; text: string }> {
    return this.db.prepare(`SELECT c.id, c.text FROM chunks c LEFT JOIN vectors v ON v.chunk_id=c.id WHERE v.chunk_id IS NULL AND c.kind IN (${EMBEDDED_CHUNK_KINDS.map(() => '?').join(',')}) ORDER BY c.id LIMIT ?`)
      .all(...EMBEDDED_CHUNK_KINDS, limit).map((r) => ({ id: num(r.id), text: str(r.text) }));
  }
  chunkTexts(ids: number[]): Map<number, string> {
    const out = new Map<number, string>(); const stmt = this.db.prepare('SELECT text FROM chunks WHERE id=?');
    for (const id of ids) { const r = stmt.get(id); if (r) out.set(id, str(r.text)); }
    return out;
  }
  setVectors(entries: Array<{ chunk_id: number; vector: Float32Array }>): number {
    const model = this.modelInfo();
    if (!model) throw new AutosError('INVALID_INPUT', 'Embedding model is not recorded for the precedent index');
    for (const e of entries) if (e.vector.length !== model.dims) throw new AutosError('INVALID_OUTPUT', 'Embedding dimension does not match the index model');
    return this.tx(() => {
      const stmt = this.db.prepare('INSERT INTO vectors(chunk_id, model, dims, vec) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE id=?) ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dims=excluded.dims, vec=excluded.vec');
      let n = 0;
      for (const e of entries) n += Number(stmt.run(e.chunk_id, model.id, model.dims, encodeVector(e.vector), e.chunk_id).changes);
      return n;
    });
  }
  /** Keyset-paginated scan of vectors for one model (used by the brute-force index). */
  scanVectors(afterChunkId: number, limit: number, kinds: readonly ChunkKind[]): Array<{ chunk_id: number; issue_id: string; kind: ChunkKind; vec: Uint8Array }> {
    const model = this.modelInfo(); if (!model) return [];
    return this.db.prepare(`SELECT v.chunk_id, c.issue_id, c.kind, v.vec FROM vectors v JOIN chunks c ON c.id=v.chunk_id WHERE v.chunk_id > ? AND v.model=? AND v.dims=?
      AND c.kind IN (${kinds.map(() => '?').join(',')}) ORDER BY v.chunk_id LIMIT ?`).all(afterChunkId, model.id, model.dims, ...kinds, limit)
      .map((r) => ({ chunk_id: num(r.chunk_id), issue_id: str(r.issue_id), kind: str(r.kind) as ChunkKind, vec: r.vec as Uint8Array }));
  }
  /** Vector of a given chunk kind for an issue (e.g. its defect statement), or null. */
  issueVector(issueId: string, kind: ChunkKind = 'defect'): Float32Array | null {
    const r = this.db.prepare('SELECT v.vec FROM vectors v JOIN chunks c ON c.id=v.chunk_id WHERE c.issue_id=? AND c.kind=? ORDER BY c.ord LIMIT 1').get(issueId, kind);
    return r ? decodeVector(r.vec as Uint8Array) : null;
  }

  // ---- Lexical and exact-match lookups ----

  /** BM25 search; every term is quoted for FTS5. Returns the best (lowest bm25) chunk per issue, best first. */
  ftsSearch(terms: string[], limit = 200): Array<{ issue_id: string; chunk_id: number; kind: ChunkKind; bm25: number }> {
    const expr = ftsMatchExpression(terms); if (!expr) return [];
    const rows = this.db.prepare(`SELECT c.id chunk_id, c.issue_id, c.kind, bm25(chunks_fts) score FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid
      WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`).all(expr, limit * 5);
    const best = new Map<string, { issue_id: string; chunk_id: number; kind: ChunkKind; bm25: number }>();
    for (const r of rows) { const id = str(r.issue_id); if (!best.has(id)) best.set(id, { issue_id: id, chunk_id: num(r.chunk_id), kind: str(r.kind) as ChunkKind, bm25: num(r.score) }); }
    return [...best.values()].slice(0, limit);
  }
  /** Issues sharing an error signature key, with how many issues carry each key (for discrimination). */
  issuesBySignatures(keys: string[]): Array<{ issue_id: string; sig: string; strong: boolean; sig_issue_count: number }> {
    const out: Array<{ issue_id: string; sig: string; strong: boolean; sig_issue_count: number }> = [];
    const count = this.db.prepare('SELECT COUNT(*) n FROM error_sigs WHERE sig=?'); const rows = this.db.prepare('SELECT issue_id, strong FROM error_sigs WHERE sig=?');
    for (const key of new Set(keys)) {
      const n = num(count.get(key)?.n);
      for (const r of rows.all(key)) out.push({ issue_id: str(r.issue_id), sig: key, strong: num(r.strong) === 1, sig_issue_count: n });
    }
    return out;
  }
  signaturesOf(issueId: string): ErrorSignature[] {
    return this.db.prepare('SELECT sig, kind, strong, display FROM error_sigs WHERE issue_id=? ORDER BY sig').all(issueId)
      .map((r) => ({ key: str(r.sig), kind: str(r.kind) as ErrorSignature['kind'], strong: num(r.strong) === 1, display: str(r.display) }));
  }
  codeRefsOf(issueId: string): Array<CodeRef & { node: string }> {
    return this.db.prepare('SELECT node, kind, path FROM code_refs WHERE issue_id=? ORDER BY node, kind, path').all(issueId)
      .map((r) => ({ node: str(r.node), kind: str(r.kind) as CodeRef['kind'], value: str(r.path) }));
  }
  /** Issues whose code refs (any node) or fix files mention one of the given basenames (candidate pre-filter). */
  issuesByCodeBasenames(basenames: string[], limit = 500): string[] {
    const ids = new Set<string>();
    const refs = this.db.prepare("SELECT DISTINCT issue_id FROM code_refs WHERE path = ? OR path LIKE ? ESCAPE '\\' LIMIT ?");
    const fixes = this.db.prepare("SELECT DISTINCT f.issue_id FROM fixes f, json_each(f.files) j WHERE j.value = ? OR j.value LIKE ? ESCAPE '\\' LIMIT ?");
    for (const b of new Set(basenames.filter(Boolean))) {
      const like = `%/${b.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      for (const r of refs.all(b, like, limit)) ids.add(str(r.issue_id));
      for (const r of fixes.all(b, like, limit)) ids.add(str(r.issue_id));
      for (const r of this.db.prepare('SELECT DISTINCT issue_id FROM code_refs WHERE kind=\'class\' AND path=? LIMIT ?').all(b.replace(/\.[^.]+$/, ''), limit)) ids.add(str(r.issue_id));
    }
    return [...ids].slice(0, limit);
  }

  // ---- Fixes and lineage facts ----

  /** Records fix commits for every indexed issue whose key (or alias) appears in `issue_keys`. Unknown keys are skipped. */
  upsertFixes(fixes: FixCommit[], autos?: { job_id: string; outcome: string }): number {
    return this.tx(() => {
      let n = 0;
      const stmt = this.db.prepare(`INSERT INTO fixes(issue_id, lineage, commit_sha, patch_id, files, reverted, subject, committed_at, contained_in, source, autos_job_id, autos_outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id, lineage, commit_sha) DO UPDATE SET patch_id=excluded.patch_id, files=excluded.files,
        reverted=excluded.reverted, subject=excluded.subject, contained_in=excluded.contained_in, source=excluded.source,
        autos_job_id=COALESCE(excluded.autos_job_id, fixes.autos_job_id), autos_outcome=COALESCE(excluded.autos_outcome, fixes.autos_outcome)`);
      for (const f of fixes) for (const key of f.issue_keys) {
        const issue = this.getIssueByKey(key); if (!issue) continue;
        n += Number(stmt.run(issue.id, f.lineage_id, f.commit_sha, f.patch_id, JSON.stringify(f.files.map((x) => x.path)), f.reverted_by ? 1 : 0, f.subject, f.committed_at,
          JSON.stringify(f.contained_in), f.source, autos?.job_id ?? null, autos?.outcome ?? null).changes);
      }
      return n;
    });
  }
  private toFix(r: Record<string, SQLOutputValue>): StoredFix {
    return { issue_id: str(r.issue_id), lineage_id: str(r.lineage), commit_sha: str(r.commit_sha), patch_id: strOrNull(r.patch_id), files: json(r.files, []),
      reverted: num(r.reverted) === 1, subject: str(r.subject), committed_at: str(r.committed_at), contained_in: json(r.contained_in, []),
      autos_job_id: strOrNull(r.autos_job_id), autos_outcome: strOrNull(r.autos_outcome) };
  }
  fixesForIssue(issueId: string): StoredFix[] { return this.db.prepare('SELECT * FROM fixes WHERE issue_id=? ORDER BY committed_at DESC, commit_sha').all(issueId).map((r) => this.toFix(r)); }
  fixesByPatchId(patchId: string): StoredFix[] { return this.db.prepare('SELECT * FROM fixes WHERE patch_id=? ORDER BY issue_id, commit_sha').all(patchId).map((r) => this.toFix(r)); }
  allFixes(): StoredFix[] { return this.db.prepare('SELECT * FROM fixes ORDER BY issue_id, commit_sha').all().map((r) => this.toFix(r)); }

  setFixPresence(lineage: string, patchId: string, node: string, present: boolean): void {
    this.db.prepare('INSERT INTO fix_presence(lineage, patch_id, node, present) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET present=excluded.present').run(lineage, patchId, node, present ? 1 : 0);
  }
  fixPresence(lineage: string, patchId: string, node: string): boolean | null {
    const r = this.db.prepare('SELECT present FROM fix_presence WHERE lineage=? AND patch_id=? AND node=?').get(lineage, patchId, node); return r ? num(r.present) === 1 : null;
  }
  setFixInheritance(lineage: string, commitSha: string, node: string, inherited: boolean): void {
    this.db.prepare('INSERT INTO fix_inheritance(lineage, commit_sha, node, inherited) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET inherited=excluded.inherited').run(lineage, commitSha, node, inherited ? 1 : 0);
  }
  fixInheritance(lineage: string, commitSha: string, node: string): boolean | null {
    const r = this.db.prepare('SELECT inherited FROM fix_inheritance WHERE lineage=? AND commit_sha=? AND node=?').get(lineage, commitSha, node); return r ? num(r.inherited) === 1 : null;
  }
  upsertLineageNodes(nodes: LineageNode[]): void {
    this.tx(() => {
      const stmt = this.db.prepare(`INSERT INTO lineage_nodes(lineage, branch, project_key, fork_point, fork_date, side_branches) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(lineage, project_key) DO UPDATE SET branch=excluded.branch, fork_point=excluded.fork_point, fork_date=excluded.fork_date, side_branches=excluded.side_branches`);
      for (const n of nodes) stmt.run(n.lineage_id, n.branch, n.project_key, n.fork_point, n.fork_date, JSON.stringify(n.side_branches));
    });
  }
  /** Replaces every node of one lineage (projects removed from the branch map disappear). */
  replaceLineageNodes(lineage: string, nodes: LineageNode[]): void {
    if (nodes.some((n) => n.lineage_id !== lineage)) throw new AutosError('INVALID_INPUT', 'Lineage node belongs to another lineage');
    this.tx(() => {
      this.db.prepare('DELETE FROM lineage_nodes WHERE lineage=?').run(lineage);
      const stmt = this.db.prepare('INSERT OR REPLACE INTO lineage_nodes(lineage, branch, project_key, fork_point, fork_date, side_branches) VALUES (?, ?, ?, ?, ?, ?)');
      for (const n of nodes) stmt.run(n.lineage_id, n.branch, n.project_key, n.fork_point, n.fork_date, JSON.stringify(n.side_branches));
    });
  }
  lineageNodes(): LineageNode[] {
    return this.db.prepare('SELECT * FROM lineage_nodes ORDER BY lineage, project_key').all().map((r) => ({ lineage_id: str(r.lineage), project_key: str(r.project_key), branch: str(r.branch),
      fork_point: str(r.fork_point), fork_date: str(r.fork_date), side_branches: json(r.side_branches, []) }));
  }

  // ---- Term stats and templates ----

  saveTermStats(stats: TermStats): void {
    this.tx(() => {
      this.db.exec('DELETE FROM term_stats');
      const stmt = this.db.prepare('INSERT INTO term_stats(term, df, stop) VALUES (?, ?, ?)');
      const terms = new Set([...stats.df.keys(), ...stats.stoplist]);
      for (const t of terms) stmt.run(t, stats.df.get(t) ?? 0, stats.stoplist.has(t) ? 1 : 0);
      this.setMeta('term_doc_count', String(stats.doc_count));
    });
  }
  loadTermStats(): TermStats | null {
    const n = this.meta('term_doc_count'); if (n === null) return null;
    const df = new Map<string, number>(); const stoplist = new Set<string>();
    for (const r of this.db.prepare('SELECT term, df, stop FROM term_stats').all()) { df.set(str(r.term), num(r.df)); if (num(r.stop) === 1) stoplist.add(str(r.term)); }
    return { doc_count: Number(n), df, stoplist };
  }
  saveTemplate(t: ProjectTemplate): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM project_templates WHERE project=?').run(t.project);
      const stmt = this.db.prepare('INSERT OR IGNORE INTO project_templates(project, line) VALUES (?, ?)');
      for (const l of t.lines) stmt.run(t.project, l);
    });
  }
  loadTemplates(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of this.db.prepare('SELECT project, line FROM project_templates ORDER BY project, line').all()) { const p = str(r.project); out.set(p, [...(out.get(p) ?? []), str(r.line)]); }
    return out;
  }

  // ---- Sync state and status ----

  getState<T>(name: string): T | null { const r = this.db.prepare('SELECT value FROM sync_state WHERE name=?').get(name); return r ? json<T | null>(r.value, null) : null; }
  setState(name: string, value: unknown): void {
    this.db.prepare('INSERT INTO sync_state(name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(name, JSON.stringify(value), nowIso());
  }
  clearState(name: string): void { this.db.prepare('DELETE FROM sync_state WHERE name=?').run(name); }

  status(): StoreStatus {
    const count = (sql: string) => num(this.db.prepare(sql).get()?.n);
    const projects: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT project, COUNT(*) n FROM issues GROUP BY project ORDER BY project').all()) projects[str(r.project)] = num(r.n);
    return {
      issues: count('SELECT COUNT(*) n FROM issues'), chunks: count('SELECT COUNT(*) n FROM chunks'), vectors: count('SELECT COUNT(*) n FROM vectors'),
      missing_vectors: num(this.db.prepare(`SELECT COUNT(*) n FROM chunks c LEFT JOIN vectors v ON v.chunk_id=c.id WHERE v.chunk_id IS NULL AND c.kind IN (${EMBEDDED_CHUNK_KINDS.map(() => '?').join(',')})`).get(...EMBEDDED_CHUNK_KINDS)?.n),
      error_sigs: count('SELECT COUNT(*) n FROM error_sigs'), code_refs: count('SELECT COUNT(*) n FROM code_refs'), fixes: count('SELECT COUNT(*) n FROM fixes'),
      projects, model: this.modelInfo(), last_updated: strOrNull(this.db.prepare('SELECT MAX(updated_at) m FROM issues').get()?.m),
    };
  }
  ftsRowCount(): number { return num(this.db.prepare('SELECT COUNT(*) n FROM chunks_fts').get()?.n); }
}

// ---------------------------------------------------------------------------------------------------------------
// Vector index

export interface VectorIndex {
  /** Top-k chunks by cosine similarity among the given kinds. */
  knn(query: Float32Array, opts: { k: number; kinds?: readonly ChunkKind[]; excludeIssueIds?: ReadonlySet<string> }): ChunkHit[];
}

/**
 * Streaming brute-force cosine KNN over the float32 BLOBs (keyset batches, bounded memory). sqlite-vec can
 * replace this later behind the same interface.
 */
export class BruteForceVectorIndex implements VectorIndex {
  constructor(private readonly store: PrecedentStore, private readonly batchSize = 2000) {}
  knn(query: Float32Array, opts: { k: number; kinds?: readonly ChunkKind[]; excludeIssueIds?: ReadonlySet<string> }): ChunkHit[] {
    const model = this.store.modelInfo();
    if (!model) return [];
    if (query.length !== model.dims) throw new AutosError('CONFLICT', 'Query embedding dimension does not match the index; rebuild required');
    const q = decodeVector(encodeVector(query));
    const kinds = opts.kinds ?? EMBEDDED_CHUNK_KINDS;
    const top: ChunkHit[] = [];
    let after = 0;
    for (;;) {
      const batch = this.store.scanVectors(after, this.batchSize, kinds);
      if (!batch.length) break;
      for (const row of batch) {
        after = row.chunk_id;
        if (opts.excludeIssueIds?.has(row.issue_id)) continue;
        const v = decodeVector(row.vec); let dot = 0;
        for (let i = 0; i < q.length; i++) dot += (q[i] ?? 0) * (v[i] ?? 0);
        if (top.length < opts.k || dot > (top[top.length - 1]?.score ?? -Infinity)) {
          let pos = top.length; while (pos > 0 && (top[pos - 1]?.score ?? 0) < dot) pos--;
          top.splice(pos, 0, { chunk_id: row.chunk_id, issue_id: row.issue_id, kind: row.kind, score: dot });
          if (top.length > opts.k) top.pop();
        }
      }
      if (batch.length < this.batchSize) break;
    }
    return top;
  }
}
