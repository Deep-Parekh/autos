import type { IndexedIssue, SemanticPrecedentResult } from '@autos/contracts';
import type { PrecedentStore } from './store.js';
import { keywordTerms, tokenize } from './text.js';
import type { RetrieveOutput } from './retrieve.js';

/** Automatic labels (plan §9). Keys are Jira issue keys. */
export type PositiveSource = 'patch_id' | 'inherited' | 'autos_merged';
export interface EvalLabels {
  positives: Array<{ a: string; b: string; source: PositiveSource }>;
  hard_negatives: Array<{ a: string; b: string }>;
  /** Tickets with no known relative (abstention expected). */
  no_relative: string[];
}

export interface DeriveLabelOptions {
  /** Pairs whose fixes change the same pre-fork lines (from trusted Git blame), as issue keys. */
  inheritedPairs?: Array<[string, string]>;
  /** Files of Autos merged attempts (from `changes.patch`), per issue key. */
  autosMerged?: Array<{ issue_key: string; files: string[] }>;
  /** Minimum term Jaccard for a hard-negative pair (default 0.25). */
  hardNegativeMinOverlap?: number;
  maxNoRelative?: number;
}

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Derives labels from the local index: ported fixes (patch-id across projects), injected inheritance and Autos merges, hard negatives. */
export function deriveLabels(store: PrecedentStore, opts: DeriveLabelOptions = {}): EvalLabels {
  const minOverlap = opts.hardNegativeMinOverlap ?? 0.25;
  const fixes = store.allFixes();
  const issues = store.getIssues(fixes.map((f) => f.issue_id));
  const positives = new Map<string, EvalLabels['positives'][number]>();
  const add = (a: string, b: string, source: PositiveSource) => { if (a !== b && !positives.has(pairKey(a, b))) positives.set(pairKey(a, b), { a, b, source }); };
  // 1. Ported fixes: same patch-id, different Jira projects.
  const byPatch = new Map<string, string[]>();
  for (const f of fixes) if (f.patch_id) byPatch.set(f.patch_id, [...(byPatch.get(f.patch_id) ?? []), f.issue_id]);
  for (const ids of byPatch.values()) {
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const a = issues.get(uniq[i] as string); const b = issues.get(uniq[j] as string);
      if (a && b && a.project !== b.project) add(a.key, b.key, 'patch_id');
    }
  }
  // 2. Inherited-code fixes (injected from trusted Git).
  for (const [a, b] of opts.inheritedPairs ?? []) if (store.getIssueByKey(a) && store.getIssueByKey(b)) add(a, b, 'inherited');
  // 3. Autos merged attempts: tickets whose fix files overlap the merged patch's files.
  const filesByIssue = new Map<string, Set<string>>();
  for (const f of fixes) { const s = filesByIssue.get(f.issue_id) ?? new Set<string>(); f.files.forEach((x) => s.add(x)); filesByIssue.set(f.issue_id, s); }
  for (const m of opts.autosMerged ?? []) {
    const merged = new Set(m.files);
    for (const [id, files] of filesByIssue) { const other = issues.get(id); if (other && other.key !== m.issue_key && [...files].some((x) => merged.has(x))) add(m.issue_key, other.key, 'autos_merged'); }
  }
  // 4. Hard negatives: high keyword overlap, fixes in disjoint files and directories.
  const negatives = new Map<string, { a: string; b: string }>();
  const termsOf = (id: string) => { const i = store.getIssue(id); return new Set(i ? tokenize(`${i.summary} ${i.description_clean}`).filter((t) => t.length >= 3) : []); };
  for (const [id, files] of filesByIssue) {
    const a = issues.get(id); if (!a) continue;
    const ta = termsOf(id);
    for (const hit of store.ftsSearch(keywordTerms(`${a.summary}\n${a.description_clean}`, null), 10)) {
      if (hit.issue_id === id) continue;
      const other = filesByIssue.get(hit.issue_id); const b = issues.get(hit.issue_id);
      if (!other || !b || positives.has(pairKey(a.key, b.key))) continue;
      const tb = termsOf(hit.issue_id); const inter = [...ta].filter((t) => tb.has(t)).length; const jac = inter / Math.max(1, ta.size + tb.size - inter);
      const dirsA = new Set([...files].map(dirOf)); const disjoint = ![...other].some((f) => files.has(f) || dirsA.has(dirOf(f)));
      if (jac >= minOverlap && disjoint) negatives.set(pairKey(a.key, b.key), { a: a.key, b: b.key });
    }
  }
  const related = new Set([...positives.values()].flatMap((p) => [p.a, p.b]));
  const no_relative = store.listIssueIds().map((id) => store.getIssue(id)).filter((i): i is NonNullable<typeof i> => !!i && !related.has(i.key) && !i.link_keys.length && !i.parent_key)
    .map((i) => i.key).slice(0, opts.maxNoRelative ?? 200);
  return { positives: [...positives.values()], hard_negatives: [...negatives.values()], no_relative };
}

export interface EvalMetrics {
  queries: number;
  shown: number;
  true_positives: number;
  hard_negative_hits: number;
  /** TP / all shown (unlabeled shown results count against precision). */
  precision: number | null;
  /** TP / (TP + hard-negative hits). */
  precision_labeled: number | null;
  hard_negative_fp_rate: number | null;
  /** Directed ported-fix pairs whose partner is in the top 5 shown. */
  recall_at_5: number | null;
  recall_at_5_all_positives: number | null;
  abstention_rate: number | null;
}

/** Runs a search function over labeled queries and computes the §9 metrics. Local data only. */
export async function runEval(store: PrecedentStore, labels: EvalLabels, search: (issue: IndexedIssue) => Promise<SemanticPrecedentResult | RetrieveOutput>): Promise<EvalMetrics> {
  const partners = new Map<string, Map<string, PositiveSource>>(); const negatives = new Map<string, Set<string>>();
  for (const p of labels.positives) for (const [x, y] of [[p.a, p.b], [p.b, p.a]] as const) { const m = partners.get(x) ?? new Map<string, PositiveSource>(); m.set(y, p.source); partners.set(x, m); }
  for (const n of labels.hard_negatives) for (const [x, y] of [[n.a, n.b], [n.b, n.a]] as const) { const s = negatives.get(x) ?? new Set<string>(); s.add(y); negatives.set(x, s); }
  const queries = [...new Set([...partners.keys(), ...negatives.keys(), ...labels.no_relative])].sort();
  const noRelative = new Set(labels.no_relative);
  let shown = 0; let tp = 0; let hn = 0; let hnPairs = 0; let hnShown = 0; let portedPairs = 0; let portedHit = 0; let allPairs = 0; let allHit = 0; let nrCount = 0; let nrAbstain = 0;
  for (const key of queries) {
    const stored = store.getIssueByKey(key); if (!stored) continue;
    const doc = store.getIssueDoc(stored.id); if (!doc) continue;
    const raw = await search(doc);
    const result = 'result' in raw ? raw.result : raw;
    const ranked = [...result.items, ...result.also_reported].sort((a, b) => b.score - a.score).map((p) => p.issue_key);
    const pos = partners.get(key) ?? new Map<string, PositiveSource>(); const neg = negatives.get(key) ?? new Set<string>();
    shown += ranked.length;
    for (const k of ranked) { if (pos.has(k)) tp++; else if (neg.has(k)) hn++; }
    for (const n of neg) { hnPairs++; if (ranked.includes(n)) hnShown++; }
    const top5 = new Set(ranked.slice(0, 5));
    for (const [k, source] of pos) { allPairs++; if (top5.has(k)) allHit++; if (source === 'patch_id') { portedPairs++; if (top5.has(k)) portedHit++; } }
    if (noRelative.has(key)) { nrCount++; if (!ranked.length) nrAbstain++; }
  }
  const ratio = (a: number, b: number) => (b ? a / b : null);
  return { queries: queries.length, shown, true_positives: tp, hard_negative_hits: hn, precision: ratio(tp, shown), precision_labeled: ratio(tp, tp + hn),
    hard_negative_fp_rate: ratio(hnShown, hnPairs), recall_at_5: ratio(portedHit, portedPairs), recall_at_5_all_positives: ratio(allHit, allPairs), abstention_rate: ratio(nrAbstain, nrCount) };
}
