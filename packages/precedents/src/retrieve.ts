import { branchNameSchema, semanticPrecedentResultSchema, type EmbeddingPort, type IndexedIssue, type SemanticPrecedent, type SemanticPrecedentResult } from '@autos/contracts';
import { buildJudgePrompt, parseJudgeOutput, type Judge, type JudgeCandidate } from './judge.js';
import { oneLine } from './safety.js';
import { BruteForceVectorIndex, type PrecedentStore, type StoredFix, type StoredIssue, type VectorIndex } from './store.js';
import { codeOverlap, keywordTerms, prepareIssue, templateFromLines, type CodeRef } from './text.js';

type PrecedentSignal = SemanticPrecedent['signals'][number];
type PrecedentKind = SemanticPrecedent['kind'];

/** A Jira project's development branch in a lineage (with attached dev/sbx branches). */
export interface PrecedentNode { lineage_id: string; project_key: string; branch: string; side_branches?: string[] }

/**
 * Lineage facts from trusted Git (`@autos/git-runner`, Task C) or the store's cached tables. `null` = unknown.
 * Only ever asked about a fix and a node in the same lineage.
 */
export interface LineageEvidence {
  /** The code the fix changed existed before the node's fork point (bug inherited by that node). */
  inherited(fixSha: string, node: PrecedentNode): Promise<boolean | null>;
  /** A commit with this patch-id is already on the node (or its dev/sbx branches). */
  presentOn(patchId: string, node: PrecedentNode): Promise<boolean | null>;
  /** `git apply --check` of the fix onto the node's branch tip succeeds. */
  appliesTo(sha: string, node: PrecedentNode): Promise<boolean | null>;
  /** Bounded diff excerpt of the fix commit (optional). */
  diffExcerpt?(sha: string, lineageId: string, maxBytes: number): Promise<string | null>;
}

/** LineageEvidence from the store's `fix_presence` / `fix_inheritance` tables; `appliesTo` is unknown. */
export class StoredLineageEvidence implements LineageEvidence {
  constructor(private readonly store: PrecedentStore) {}
  async inherited(fixSha: string, node: PrecedentNode) { return this.store.fixInheritance(node.lineage_id, fixSha, node.project_key); }
  async presentOn(patchId: string, node: PrecedentNode) { return this.store.fixPresence(node.lineage_id, patchId, node.project_key); }
  async appliesTo() { return null; }
}

export const FEATURE_NAMES = ['semantic', 'near_duplicate', 'error_signature', 'code_overlap', 'lineage', 'jira_link', 'patch_id', 'same_lineage', 'fix_not_present', 'defect_score', 'autos_merged', 'recency', 'keyword'] as const;
export type FeatureName = typeof FEATURE_NAMES[number];
export type RetrieveWeights = Record<FeatureName, number>;

/** Noisy-OR weights in [0,1]: score = 1 − Π(1 − w·f). Tuned on the benchmark (§9); keyword stays tiny. */
export const DEFAULT_WEIGHTS: RetrieveWeights = {
  semantic: 0.5, near_duplicate: 0.5, error_signature: 0.5, code_overlap: 0.4, lineage: 0.3, jira_link: 0.2, patch_id: 0.5,
  same_lineage: 0.05, fix_not_present: 0.05, defect_score: 0.05, autos_merged: 0.1, recency: 0.03, keyword: 0.05,
};

export interface RetrieveConfig {
  /** Shown fix precedents (hard cap 5). */
  maxResults: number;
  semanticThreshold: number;
  nearDuplicateThreshold: number;
  /** Independent signals required by the evidence gate (keyword never counts). */
  requireSignals: number;
  /** Score required when the judge did not run (NOT_RUN), or did not judge a candidate. */
  strictScoreThreshold: number;
  /** Apply the strict threshold also when no judge is configured (SKIPPED). */
  strictWithoutJudge: boolean;
  candidateLimit: number;
  fusionLimit: number;
  judgeMaxCandidates: number;
  /** Error signatures carried by more issues than this are not discriminative. */
  maxSignatureIssues: number;
  /** Failed-gate candidates with a fix and at least this semantic similarity are RELATED_FIX (CLI only). */
  relatedThreshold: number;
  perPrecedentDiffBytes: number;
  rrfK: number;
  weights: RetrieveWeights;
}
export const DEFAULT_RETRIEVE_CONFIG: RetrieveConfig = {
  maxResults: 3, semanticThreshold: 0.8, nearDuplicateThreshold: 0.93, requireSignals: 2, strictScoreThreshold: 0.7, strictWithoutJudge: true,
  candidateLimit: 100, fusionLimit: 30, judgeMaxCandidates: 10, maxSignatureIssues: 25, relatedThreshold: 0.6, perPrecedentDiffBytes: 6144, rrfK: 60, weights: DEFAULT_WEIGHTS,
};

export interface RetrieveDeps {
  store: PrecedentStore;
  embedder: EmbeddingPort | null;
  vectors?: VectorIndex;
  judge?: Judge | null;
  lineage?: LineageEvidence | null;
  /** Node of a Jira project (from the branch map + lineage config), or null when unmapped. */
  nodeOf(projectKey: string): PrecedentNode | null;
  issueUrl(issueKey: string): string;
  commitUrl(lineageId: string, sha: string): string;
  config?: Partial<Omit<RetrieveConfig, 'weights'>> & { weights?: Partial<RetrieveWeights> };
  now?: () => Date;
  /** Job id passed to the judge (a fresh uuid when absent, e.g. CLI searches). */
  jobId?: string;
}

export interface RetrieveQuery {
  issue: IndexedIssue;
  /** Paths the ticket's identifiers resolved to on its own branch (trusted Git). */
  resolvedPaths?: string[];
  includeRelated?: boolean;
}

export type CandidateList = 'vector' | 'bm25' | 'error' | 'code' | 'link';
export interface CandidateExplain {
  issue_key: string;
  project_key: string;
  ranks: Partial<Record<CandidateList, number>>;
  rrf: number;
  features: Record<FeatureName, number>;
  contributions: Record<FeatureName, number>;
  score: number;
  signals: PrecedentSignal[];
  matched: { signatures: string[]; paths: string[] };
  gate: 'pass' | 'near_duplicate' | 'fail' | 'not_evaluated';
  decision: 'shown' | 'also_reported' | 'rejected' | 'related';
  kind: PrecedentKind | null;
  reason: string | null;
}

export interface RetrieveOutput {
  result: SemanticPrecedentResult;
  explain: CandidateExplain[];
  /** RELATED_FIX entries (CLI search only; never in results or prompts). */
  related: SemanticPrecedent[];
  /** ≤ 600-char description excerpts (templates stripped, no comments) per shown key, for the reference block. */
  excerpts: Record<string, string>;
}

interface FixEval { fix: StoredFix; inherited: boolean | null; present: boolean | null; applies: boolean | null }
interface Candidate {
  id: string; issue: StoredIssue; ranks: Partial<Record<CandidateList, number>>; rrf: number;
  semantic: number; signatures: string[]; paths: string[]; linked: boolean; keywordRank: number | null;
  fixes: StoredFix[]; evals: FixEval[]; patchMatch: boolean;
  features: Record<FeatureName, number>; contributions: Record<FeatureName, number>; score: number;
  signals: PrecedentSignal[]; gate: CandidateExplain['gate']; judge: SemanticPrecedent['judge']; reason: string | null;
  decision: CandidateExplain['decision']; kind: PrecedentKind | null; caveats: string[];
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0); return s; };
const normalize = (v: Float32Array) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
const reason = (text: string) => oneLine(text, 300);

function emptyResult(outcome: SemanticPrecedentResult['outcome'], index: SemanticPrecedentResult['index']): SemanticPrecedentResult {
  return { schema_version: 1, outcome, judge: 'SKIPPED', items: [], also_reported: [], rejected: [], checked: 0, index };
}

/**
 * The §5 pipeline: candidate generation (vector, BM25 with stoplist, error signatures, code overlap, Jira links)
 * from every project and type → RRF + transparent feature score → evidence gate → dedupe → judge (drop-only) →
 * classification → abstention. Lineage evidence is only used within one lineage.
 */
export async function findSemanticPrecedents(deps: RetrieveDeps, query: RetrieveQuery, signal?: AbortSignal): Promise<RetrieveOutput> {
  const cfg: RetrieveConfig = { ...DEFAULT_RETRIEVE_CONFIG, ...deps.config, weights: { ...DEFAULT_WEIGHTS, ...deps.config?.weights } };
  cfg.maxResults = Math.max(0, Math.min(5, cfg.maxResults));
  const store = deps.store; const now = deps.now ?? (() => new Date());
  const status = store.status();
  const index = { as_of: status.last_updated ?? now().toISOString(), issues: status.issues, model: status.model?.id ?? 'none' };
  const out = (result: SemanticPrecedentResult, explain: CandidateExplain[] = [], related: SemanticPrecedent[] = [], excerpts: Record<string, string> = {}): RetrieveOutput =>
    ({ result: semanticPrecedentResultSchema.parse(result), explain, related, excerpts });
  if (!status.issues) return out(emptyResult('INDEX_NOT_READY', index));

  // ---- Query, processed exactly like indexed issues ----
  const issue = query.issue;
  const templateLines = store.loadTemplates().get(issue.project_key) ?? [];
  const q = prepareIssue(issue, { template: templateFromLines(issue.project_key, templateLines) });
  const self = new Set<string>([issue.id]);
  const selfStored = store.getIssueByKey(issue.key); if (selfStored) self.add(selfStored.id);
  const currentNode = deps.nodeOf(issue.project_key);

  let queryVec: Float32Array | null = null;
  if (deps.embedder) {
    try {
      store.assertModel(deps.embedder.model());
      const [v] = await deps.embedder.embed([q.defect.text], signal);
      if (!v) throw new Error('no vector');
      queryVec = normalize(v);
    } catch {
      return out(emptyResult('INDEX_NOT_READY', index));
    }
  }

  // ---- Stage 1: candidate generation ----
  const lists: Record<CandidateList, string[]> = { vector: [], bm25: [], error: [], code: [], link: [] };
  const semanticBest = new Map<string, number>();
  if (queryVec) {
    const vectors = deps.vectors ?? new BruteForceVectorIndex(store);
    for (const hit of vectors.knn(queryVec, { k: cfg.candidateLimit * 3, kinds: ['defect', 'head'], excludeIssueIds: self })) {
      semanticBest.set(hit.issue_id, Math.max(semanticBest.get(hit.issue_id) ?? -1, hit.score));
    }
    lists.vector = [...semanticBest].sort((a, b) => b[1] - a[1]).slice(0, cfg.candidateLimit).map(([id]) => id);
  }
  const stats = store.loadTermStats();
  const terms = keywordTerms(`${q.issue.summary}\n${q.description_clean}`, stats);
  const keywordRank = new Map<string, number>();
  store.ftsSearch(terms, cfg.candidateLimit + self.size).filter((h) => !self.has(h.issue_id)).forEach((h, i) => { keywordRank.set(h.issue_id, i); lists.bm25.push(h.issue_id); });

  const strongSigs = q.signatures.filter((s) => s.strong).map((s) => s.key);
  const sigMatches = new Map<string, string[]>();
  for (const m of store.issuesBySignatures(strongSigs)) {
    if (!m.strong || self.has(m.issue_id) || m.sig_issue_count > cfg.maxSignatureIssues) continue;
    sigMatches.set(m.issue_id, [...(sigMatches.get(m.issue_id) ?? []), m.sig]);
  }
  lists.error = [...sigMatches].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([id]) => id);

  const queryRefs: CodeRef[] = [...q.code_refs, ...(query.resolvedPaths ?? []).map((p) => ({ kind: 'path' as const, value: p }))];
  const pathMatches = new Map<string, string[]>();
  const basenames = queryRefs.filter((r) => r.kind === 'path' || r.kind === 'class').map((r) => r.value.split('/').pop() ?? r.value);
  for (const id of store.issuesByCodeBasenames(basenames)) {
    if (self.has(id)) continue;
    const refs = store.codeRefsOf(id).filter((r) => r.kind === 'path' || r.kind === 'class').map((r) => r.value);
    const files = store.fixesForIssue(id).flatMap((f) => f.files);
    const matched = codeOverlap(queryRefs, [...new Set([...refs, ...files])]);
    if (matched.length) pathMatches.set(id, matched);
  }
  lists.code = [...pathMatches].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([id]) => id);

  const linkKeys = [...issue.link_keys, ...(issue.parent_key ? [issue.parent_key] : [])];
  lists.link = [...new Set([...store.idsForKeys(linkKeys), ...store.issuesLinkingTo(issue.key)])].filter((id) => !self.has(id));
  const linked = new Set(lists.link);

  // ---- Stage 2: fusion and features ----
  const rrf = new Map<string, { score: number; ranks: Partial<Record<CandidateList, number>> }>();
  for (const name of Object.keys(lists) as CandidateList[]) lists[name].forEach((id, rank) => {
    const e = rrf.get(id) ?? { score: 0, ranks: {} }; e.score += 1 / (cfg.rrfK + rank + 1); e.ranks[name] = rank + 1; rrf.set(id, e);
  });
  const fused = [...rrf].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, cfg.fusionLimit);
  const issues = store.getIssues(fused.map(([id]) => id));
  const currentFixPatchIds = new Set((selfStored ? store.fixesForIssue(selfStored.id) : []).map((f) => f.patch_id).filter((p): p is string => !!p));
  const nowMs = now().getTime();
  const candidates: Candidate[] = [];
  for (const [id, r] of fused) {
    if (signal?.aborted) break;
    const ci = issues.get(id); if (!ci) continue;
    let semantic = semanticBest.get(id) ?? 0;
    if (queryVec) { const dv = store.issueVector(id, 'defect'); if (dv) semantic = Math.max(semantic, dot(queryVec, dv)); }
    semantic = Math.max(0, Math.min(1, semantic));
    const fixes = store.fixesForIssue(id).filter((f) => !f.reverted);
    const evals: FixEval[] = [];
    for (const fix of fixes.slice(0, 3)) {
      if (!currentNode || !deps.lineage || fix.lineage_id !== currentNode.lineage_id) { evals.push({ fix, inherited: null, present: null, applies: null }); continue; }
      const safe = async (fn: () => Promise<boolean | null>) => { try { return await fn(); } catch { return null; } };
      const lineage = deps.lineage;
      evals.push({ fix, inherited: await safe(() => lineage.inherited(fix.commit_sha, currentNode)), present: fix.patch_id ? await safe(() => lineage.presentOn(fix.patch_id as string, currentNode)) : null,
        applies: await safe(() => lineage.appliesTo(fix.commit_sha, currentNode)) });
    }
    const candNode = deps.nodeOf(ci.project);
    const sigs = sigMatches.get(id) ?? []; const paths = pathMatches.get(id) ?? [];
    const patchMatch = fixes.some((f) => f.patch_id && currentFixPatchIds.has(f.patch_id));
    const age = (nowMs - Date.parse(ci.updated_at)) / 86_400_000;
    const kRank = keywordRank.get(id);
    const features: Record<FeatureName, number> = {
      semantic, near_duplicate: semantic >= cfg.nearDuplicateThreshold ? 1 : 0,
      error_signature: sigs.length ? Math.min(1, 0.6 + 0.2 * (sigs.length - 1)) : 0,
      code_overlap: paths.length ? Math.min(1, 0.6 + 0.2 * (paths.length - 1)) : 0,
      lineage: evals.some((e) => e.inherited === true) ? 1 : 0, jira_link: linked.has(id) ? 1 : 0, patch_id: patchMatch ? 1 : 0,
      same_lineage: currentNode && candNode && currentNode.lineage_id === candNode.lineage_id ? 1 : 0,
      fix_not_present: evals.some((e) => e.present === false) ? 1 : 0, defect_score: ci.defect_score,
      autos_merged: fixes.some((f) => f.autos_outcome === 'merged') ? 1 : 0, recency: Number.isFinite(age) ? Math.max(0, Math.min(1, 1 - age / 730)) : 0,
      keyword: kRank === undefined ? 0 : 1 / (1 + kRank / 10),
    };
    const contributions = Object.fromEntries(FEATURE_NAMES.map((f) => [f, cfg.weights[f] * features[f]])) as Record<FeatureName, number>;
    const score = Math.max(0, Math.min(1, 1 - FEATURE_NAMES.reduce((p, f) => p * (1 - Math.max(0, Math.min(1, contributions[f]))), 1)));
    candidates.push({ id, issue: ci, ranks: r.ranks, rrf: r.score, semantic, signatures: sigs, paths, linked: linked.has(id), keywordRank: kRank ?? null, fixes, evals, patchMatch,
      features, contributions, score, signals: [], gate: 'not_evaluated', judge: null, reason: null, decision: 'rejected', kind: null, caveats: [] });
  }

  // ---- Stage 3: evidence gate ----
  for (const c of candidates) {
    const strongSemantic = c.semantic >= cfg.semanticThreshold;
    const independent: PrecedentSignal[] = [];
    if (strongSemantic) independent.push('semantic');
    if (c.signatures.length) independent.push('error_signature');
    if (c.paths.length) independent.push('code_overlap');
    if (c.features.lineage) independent.push('lineage');
    if (c.linked) independent.push('jira_link');
    if (c.patchMatch) independent.push('patch_id');
    const extra: PrecedentSignal[] = [];
    if (c.features.near_duplicate) extra.push('near_duplicate');
    if (c.keywordRank !== null) extra.push('keyword');
    if (c.features.autos_merged) extra.push('autos_merged');
    c.signals = [...independent, ...extra];
    const corroborating = independent.filter((s) => s !== 'semantic');
    // Strong semantic similarity plus (requireSignals − 1) corroborating signals; a near-duplicate alone; or a
    // shared patch-id with one more signal. Keyword overlap never counts.
    if (strongSemantic && corroborating.length >= Math.max(1, cfg.requireSignals - 1)) c.gate = 'pass';
    else if (c.features.near_duplicate) c.gate = 'near_duplicate';
    else if (c.patchMatch && independent.length >= 2) c.gate = 'pass';
    else {
      c.gate = 'fail';
      c.reason = independent.length === 0
        ? (c.keywordRank !== null ? 'keyword overlap only' : 'no strong signal')
        : !strongSemantic ? `no semantic agreement (${corroborating.join(', ')})`
        : 'single signal (semantic) without corroboration';
    }
  }

  // ---- Dedupe: current ticket family, then clusters sharing a fix, subtasks or clones ----
  let alive = candidates.filter((c) => c.gate !== 'fail');
  for (const c of alive) {
    if (c.issue.parent_key === issue.key || (issue.parent_key && (c.issue.key === issue.parent_key || c.issue.aliases.includes(issue.parent_key)))) {
      c.gate = 'fail'; c.reason = 'parent or subtask of the current ticket';
    }
  }
  alive = alive.filter((c) => c.gate !== 'fail').sort((a, b) => b.score - a.score || a.issue.key.localeCompare(b.issue.key));
  const parentOf = new Map<string, string>();
  const find = (k: string): string => { let x = k; while (parentOf.has(x) && parentOf.get(x) !== x) x = parentOf.get(x) as string; return x; };
  const union = (a: string, b: string, why: string, reasons: Map<string, string>) => { const ra = find(a); const rb = find(b); if (ra === rb) return; parentOf.set(rb, ra); reasons.set(rb, why); };
  const why = new Map<string, string>();
  for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
    const a = alive[i] as Candidate; const b = alive[j] as Candidate;
    const keysA = new Set([a.issue.key, ...a.issue.aliases]); const keysB = new Set([b.issue.key, ...b.issue.aliases]);
    if ((a.issue.parent_key && keysB.has(a.issue.parent_key)) || (b.issue.parent_key && keysA.has(b.issue.parent_key))) union(a.id, b.id, 'subtask', why);
    else if (a.fixes.some((f) => b.fixes.some((g) => g.commit_sha === f.commit_sha))) union(a.id, b.id, 'shared fix commit', why);
    else if (a.fixes.some((f) => f.patch_id && b.fixes.some((g) => g.patch_id === f.patch_id))) union(a.id, b.id, 'same patch-id', why);
    else if ((a.issue.link_keys.some((k) => keysB.has(k)) || b.issue.link_keys.some((k) => keysA.has(k)))) {
      const va = store.issueVector(a.id, 'defect'); const vb = store.issueVector(b.id, 'defect');
      if ((va && vb && dot(va, vb) >= cfg.nearDuplicateThreshold) || oneLine(a.issue.summary).toLowerCase() === oneLine(b.issue.summary).toLowerCase()) union(a.id, b.id, 'clone', why);
    }
  }
  const byId = new Map(alive.map((c) => [c.id, c]));
  for (const c of alive) {
    const root = find(c.id);
    if (root === c.id) continue;
    const rep = byId.get(root) as Candidate;
    c.gate = 'fail'; c.reason = `duplicate of ${rep.issue.key} (${why.get(c.id) ?? 'same defect'})`;
    rep.caveats.push(`Same defect also tracked as ${c.issue.key} (${c.issue.project}, ${oneLine(c.issue.status, 60)})`);
  }
  alive = alive.filter((c) => c.gate !== 'fail');

  // ---- Stage 4: judge (drop-only) ----
  let judgeState: SemanticPrecedentResult['judge'] = 'SKIPPED';
  const judged = alive.slice(0, cfg.judgeMaxCandidates);
  for (const c of alive.slice(cfg.judgeMaxCandidates)) { c.gate = 'fail'; c.reason = 'ranked below the judged candidates'; }
  const verdicts = new Map<string, { same_defect: 'yes' | 'likely' | 'no'; confidence: number }>();
  if (judged.length && deps.judge) {
    const toJudge = (c: Candidate): JudgeCandidate => ({ issue_key: c.issue.key, project_key: c.issue.project, summary: c.issue.summary, defect_statement: c.issue.defect_public,
      error_signatures: store.signaturesOf(c.id).filter((s) => s.strong).map((s) => s.display), code_refs: store.codeRefsOf(c.id).map((r) => r.value).slice(0, 15),
      status: c.issue.status, resolution: c.issue.resolution, fix_files: [...new Set(c.fixes.flatMap((f) => f.files))].slice(0, 20) });
    const request = buildJudgePrompt({ issue_key: issue.key, project_key: issue.project_key, summary: q.issue.summary, defect_statement: q.defect_public,
      error_signatures: q.signatures.filter((s) => s.strong).map((s) => s.display), code_refs: q.code_refs.map((r) => r.value).slice(0, 15) }, judged.map(toJudge), undefined, deps.jobId);
    try {
      const output = parseJudgeOutput(await deps.judge.judge(request, signal), request.keys);
      for (const v of output.verdicts) verdicts.set(v.issue_key, v);
      judgeState = 'RAN';
    } catch { judgeState = 'NOT_RUN'; }
  }
  const strict = judgeState === 'NOT_RUN' || (judgeState === 'SKIPPED' && cfg.strictWithoutJudge);
  for (const c of judged) {
    const v = verdicts.get(c.issue.key);
    if (v?.same_defect === 'no') { c.gate = 'fail'; c.reason = 'judge: different defect'; continue; }
    if (v) { c.judge = { verdict: v.same_defect as 'yes' | 'likely', confidence: v.confidence }; continue; }
    if ((strict || judgeState === 'RAN') && c.score < cfg.strictScoreThreshold) {
      c.gate = 'fail'; c.reason = judgeState === 'NOT_RUN' ? 'judge not run; score below the strict threshold' : judgeState === 'RAN' ? 'not judged; score below the strict threshold' : 'no judge; score below the strict threshold';
    }
  }
  const survivors = judged.filter((c) => c.gate !== 'fail');

  // ---- Stage 5: classify ----
  const shown: Array<{ c: Candidate; p: SemanticPrecedent }> = []; const also: Array<{ c: Candidate; p: SemanticPrecedent }> = [];
  const build = async (c: Candidate, kind: PrecedentKind): Promise<SemanticPrecedent> => {
    let fix: SemanticPrecedent['fix'] = null; const caveats = [...c.caveats];
    if (kind !== 'ALSO_REPORTED' && c.fixes.length) {
      const sameLineage = currentNode ? c.fixes.filter((f) => f.lineage_id === currentNode.lineage_id) : [];
      const pool = sameLineage.length ? sameLineage : c.fixes;
      const chosen = pool[0] as StoredFix;
      const ev = c.evals.find((e) => e.fix.commit_sha === chosen.commit_sha) ?? null;
      const lineageFixes = pool.filter((f) => f.lineage_id === chosen.lineage_id);
      const candNode = deps.nodeOf(c.issue.project);
      const validBranch = (b: string) => branchNameSchema.safeParse(b).success;
      const branch = candNode && candNode.lineage_id === chosen.lineage_id ? candNode.branch : chosen.contained_in.find(validBranch);
      if (branch && validBranch(branch)) {
        const ported = new Set<string>();
        if (chosen.patch_id) for (const f of store.fixesByPatchId(chosen.patch_id)) if (f.lineage_id === chosen.lineage_id) for (const b of f.contained_in) if (b !== branch && validBranch(b)) ported.add(b);
        const sameAsCurrent = currentNode?.lineage_id === chosen.lineage_id;
        let diff: string | null = null;
        if (sameAsCurrent && deps.lineage?.diffExcerpt) { try { diff = await deps.lineage.diffExcerpt(chosen.commit_sha, chosen.lineage_id, cfg.perPrecedentDiffBytes); } catch { diff = null; } }
        fix = { lineage_id: chosen.lineage_id, branch, commit_shas: lineageFixes.map((f) => f.commit_sha).slice(0, 5), patch_id: chosen.patch_id,
          evidence_url: deps.commitUrl(chosen.lineage_id, chosen.commit_sha), files: [...new Set(lineageFixes.flatMap((f) => f.files))].slice(0, 50), diff_excerpt: diff,
          applies_cleanly: sameAsCurrent ? ev?.applies ?? null : null, inherited: sameAsCurrent ? ev?.inherited ?? null : null, ported_to: [...ported].sort().slice(0, 20) };
        if (!sameAsCurrent) caveats.push('Fix is in another repository lineage (no shared history); applicability unknown.');
        if (candNode && candNode.lineage_id === chosen.lineage_id && !chosen.contained_in.includes(candNode.branch) && chosen.contained_in.some((b) => candNode.side_branches?.includes(b))) {
          caveats.push('Fix is on a dev/sbx branch, not yet on the development branch.');
        }
      } else caveats.push('Fix commit branch is unknown.');
    }
    if (kind === 'ALREADY_PRESENT_HERE') caveats.push("The fix's patch is already on this branch: possible regression or a different bug.");
    if (kind === 'ALSO_REPORTED' && c.fixes.length === 0 && store.fixesForIssue(c.id).some((f) => f.reverted)) caveats.push('Its fix was reverted.');
    return { issue_key: c.issue.key, issue_url: deps.issueUrl(c.issue.key), project_key: c.issue.project, summary: oneLine(c.issue.summary, 300), status: oneLine(c.issue.status, 100),
      resolution: c.issue.resolution ? oneLine(c.issue.resolution, 100) : null, kind, score: Math.round(c.score * 1000) / 1000, signals: c.signals.length ? c.signals : ['semantic'],
      judge: c.judge, fix, caveats };
  };
  for (const c of survivors) {
    const present = c.evals.some((e) => e.present === true);
    const kind: PrecedentKind = c.fixes.length ? (present ? 'ALREADY_PRESENT_HERE' : 'FIXED_IN_RELATIVE') : 'ALSO_REPORTED';
    c.kind = kind;
    const p = await build(c, kind);
    if (kind === 'ALSO_REPORTED') also.push({ c, p }); else shown.push({ c, p });
  }
  for (const [list, cap] of [[shown, cfg.maxResults], [also, 10]] as const) {
    for (const { c } of list.slice(cap)) { c.gate = 'fail'; c.reason = 'over the result limit'; }
    for (const { c } of list.slice(0, cap)) c.decision = c.kind === 'ALSO_REPORTED' ? 'also_reported' : 'shown';
  }
  const items = shown.slice(0, cfg.maxResults).map((x) => x.p);
  const alsoReported = also.slice(0, 10).map((x) => x.p);

  // RELATED_FIX (CLI only): failed the gate, has a fix, moderately similar.
  const related: SemanticPrecedent[] = [];
  if (query.includeRelated) for (const c of candidates) {
    if (c.decision !== 'rejected' || !c.fixes.length || c.semantic < cfg.relatedThreshold) continue;
    c.decision = 'related'; c.kind = 'RELATED_FIX';
    related.push(await build(c, 'RELATED_FIX'));
  }

  const rejected = candidates.filter((c) => c.decision === 'rejected' || c.decision === 'related').sort((a, b) => b.score - a.score)
    .slice(0, 50).map((c) => ({ issue_key: c.issue.key, reason: reason(c.reason ?? 'not shown') }));
  const excerpts: Record<string, string> = {};
  for (const { c } of shown.slice(0, cfg.maxResults)) excerpts[c.issue.key] = oneLine(c.issue.description_clean, 600);
  const explain: CandidateExplain[] = candidates.map((c) => ({ issue_key: c.issue.key, project_key: c.issue.project, ranks: c.ranks, rrf: c.rrf, features: c.features,
    contributions: c.contributions, score: c.score, signals: c.signals, matched: { signatures: c.signatures, paths: c.paths }, gate: c.gate, decision: c.decision, kind: c.kind, reason: c.reason }));
  const found = items.length + alsoReported.length > 0;
  return out({ schema_version: 1, outcome: found ? 'FOUND' : 'NO_MATCH', judge: judgeState, items, also_reported: alsoReported, rejected, checked: candidates.length, index }, explain, related, excerpts);
}
