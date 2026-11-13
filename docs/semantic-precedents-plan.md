# Semantic precedent search across projects and code lineage: plan

Status: plan only. Nothing here is implemented. Revised 2026-11-08 after user feedback.

## 0. Context

### Why the first draft did not fit

The company's code is organized as **lineages**: a root repository (two today, more microservice repos coming) whose main/base branch has had many project branches cut from it over the years, with further dev/sandbox branches forked from those. Each customer/product project has **its own Jira project**. So:

1. A bug introduced before a project branched off usually exists in every project branched from the same base, and is often reported (in different words) in several Jira projects, sometimes fixed in one and still open in others.
2. Search must run **across Jira projects**, not within the ticket's own project.
3. Issue types are unreliable (bugs filed as Story, Task, Epic), so **no filtering by type**.
4. Often nothing truly similar exists. Tickets share domain keywords (product names, module names, "login", "report", "timeout") and a keyword or embedding match alone produces confident-looking false positives. The system must **abstain** unless it has real evidence.

### What exists today

`findHistoricalPrecedents` (`packages/atlassian/src/index.ts`) only considers linked issues, same-project resolved Bugs sharing a component, and ≤ 5 summary keywords via JQL `text ~`, then keeps those whose key appears in the last 20 pages of commits on one branch of one repo (needs an optional Bitbucket token that the templates leave commented out). The routing stage (`precedentText` in `packages/workflow/src/index.ts`) writes `artifacts/<jobId>/precedents.md`, which is exported in the dataset but never shown to an agent.

### Intended outcome

For each incoming ticket, Autos answers three questions, and says "no match" when the evidence is weak:

- **Also reported elsewhere?** Tickets in any Jira project (any type, any status) describing the same defect.
- **Already fixed in a related branch?** A fix commit for one of those tickets on a branch in the same lineage, and whether it applies to this project's branch.
- **Already fixed here?** The same patch (by patch-id) already on this project's branch, which means the ticket may be a regression or a different bug.

The best verified results go to the SWE prompt as bounded, untrusted reference material.

## 1. Goals and non-goals

### Goals

1. Cross-project search over every Jira project mapped to a lineage (from the Confluence branch map), plus an optional explicit extra list; all issue types; resolved and unresolved.
2. Lineage-aware code evidence: use Git ancestry to tell whether a candidate's fix touches code this project inherited, and whether it is already present.
3. Precision over recall: a calibrated pipeline that returns `NO_MATCH` rather than keyword lookalikes. Target: ≥ 80% of shown precedents judged relevant on the benchmark; recall is secondary.
4. Support N repositories (2 now, microservices later) by configuration only.
5. Ticket text and embeddings for the whole index stay on the host; only the small final verification set goes to the already-used coding providers (approved by the user).
6. Keep all existing rules: Jira/Confluence reads only, no push/merge/PR, no secrets or raw upstream bodies in logs, argument-array processes, fakes in tests.

### Non-goals

- Writing to Jira (no auto-linking "also reported in" — the operator sees it in artifacts and the CLI).
- Automatically porting fixes between branches. Autos may show "this fix applies cleanly"; the SWE still implements and checks.
- Confluence, attachments, images.
- Per-user Jira permissions (one service account, §8).

## 2. Lineage model (new)

A **lineage** is a set of branches with shared Git history:

```yaml
precedents:
  lineages:
    - id: core                     # repo 1
      repository: {workspace: acme, repository_slug: core}
      root_branch: master          # the base everything was cut from
      scan_branches: ["**"]        # refs scanned (** includes names with /) for fix commits (dev/sbx included)
      ignore_branches: ["renovate/*"]
      branch_codes: {}             # optional {JIRAKEY: code} when <code>_dev/<code>_sbx cannot be inferred
    - id: platform                 # repo 2, no shared history with core
      repository: {workspace: acme, repository_slug: platform}
      root_branch: main
    # later: one lineage per microservice repo
```

- **Nodes** are the root branch plus every development branch named in the branch map (Jira project → repo + development branch). Every Jira project is in the branch map (confirmed), so every in-scope ticket has a node.
- **Dev/sbx branches** follow `<code>_dev` and `<code>_sbx`, where `<code>` is a branch code that is **not always** the Jira or Confluence project key. They are attached to their project node, not treated as separate projects:
  1. if the node's development branch name has the form `<code>` or `<code>_<suffix>`, try `<code>_dev` / `<code>_sbx`;
  2. otherwise, or if those branches do not exist, infer by ancestry: a `*_dev` / `*_sbx` branch whose closest fork ancestor among the nodes is this node;
  3. an optional per-project override `branch_codes: {JIRAKEY: code}` in config settles ambiguous cases.
  `autos lineage show` lists every attachment and how it was made (name, ancestry, override) so the operator can correct it. Fixes found on a node's dev/sbx branches count as fixes for that node, marked "not yet on the development branch".
- For each node, trusted Git computes the **fork point** = `git merge-base <node> <root_branch>` and its date, refreshed after each fetch. Two project nodes are **relatives** if they share a fork ancestry in the same lineage; their **common base** is `merge-base(a, b)`.
- **The two root repositories share no history (confirmed), so they are two independent lineages**, each with its own bare mirror. Tickets from the other lineage can still match on text and error signatures, but never get lineage evidence (no inheritance, no "applies cleanly", no patch-id presence). Future microservice repos are added as further lineages by config.

This gives a project relatedness signal derived from code, not from Jira structure: a ticket in project B is a stronger candidate for a ticket in project A when A and B are in the same lineage, and stronger still when the candidate's fix touches code that existed before their common base.

## 3. Indexing

### 3.1 Jira sync (read-only)

New read methods in `@autos/atlassian` (Task A owner), reusing `getJson` (origin pinning, manual redirects, 429/5xx retry with `Retry-After`, sanitized errors), the enhanced search `GET /rest/api/3/search/jql` with `nextPageToken`, and the ADF-to-text conversion `getIssue` already uses:

- `searchIssuesForIndex(jql, fields, token)`: fields `summary, description, issuetype, status, resolution, resolutiondate, created, updated, project, components, labels, priority, security, issuelinks, parent, comment, fixVersions, versions`.
- `getIssueComments(id, startAt)` only when the embedded comment page is incomplete.
- `listIssueIds(jql)` with `fields=id,key,updated` for reconciliation.

**Scope:** `project in (<all branch-map projects>) AND updated >= -104w` (about 2 years, confirmed as the useful window; `index.window_weeks`, default 104). No `issuetype` filter. JQL built from validated project keys only. Tickets that age out of the window are purged on reconcile. The Git mirrors keep full history, because inheritance checks need to blame code older than 2 years; only fix *links* are limited to commits in the window.

**Full sync** resumable by cursor (`updated`, `id`), page size 100. **Incremental** every 15 min with `updated >= cursor − 10 min` and content-hash idempotency. **Rate limiting**: one request in flight, ≥ 250 ms spacing, per-run request budget, stop on 401/403 and report in `index status`. **Reconcile** daily: ids no longer returned (deleted, moved out of scope, permission lost) are hard-deleted with their chunks, vectors and links. Primary key is the Jira `id`; moved issues keep old keys as aliases. Issues with a `security` level and comments with `visibility` restrictions are not stored.

### 3.2 Text processing: built to resist keyword false positives

1. **Template stripping.** Learn each project's boilerplate (lines/headings that appear in > 20% of that project's descriptions, e.g. "Steps to reproduce", "Expected result", environment tables, signatures) and remove them before indexing.
2. **Corpus stoplist.** Terms with very high document frequency across the whole index (product names, project names, module names used everywhere, customer names) are down-weighted in BM25 and excluded from keyword-only candidate generation. Recomputed after each full sync; per-project term frequency keeps one project's jargon from dominating.
3. **Defect-statement extraction.** From summary + description + comments, build a compact "defect statement": the observed behavior, the expected behavior, where (screen, endpoint, job, module), and the error evidence. Done deterministically first (section headers, sentence patterns). This is what gets embedded for the main vector, so two tickets about "login" that fail differently do not look alike.
4. **Error signatures** (high-precision anchor): exception class, error codes, HTTP status + normalized endpoint, top 5 normalized stack frames, log message templates (numbers, ids, timestamps stripped). Stored as exact-match keys, not just text.
5. **Code identifiers**: class/method names, file paths, config keys, SQL table names mentioned in the ticket. Resolved against the project's branch in the mirror (`git ls-files` / `git grep -l` by trusted Git) to real file paths, so the ticket is linked to code locations even before any fix exists.
6. **Ticket-type-agnostic defect score.** Because types are unreliable, a small classifier (rules + embedding nearest-centroid trained on tickets that have fix commits vs ones that do not) scores "describes a defect". Used as a soft ranking feature, never a filter.

Chunks: `defect` (the defect statement), `head` (summary + description, split at ~400 tokens), `comment` (non-bot, capped at first 5 + last 30), `error` (signature), `fix` (commit subjects + files). Each chunk stores a text hash and model id; only changed chunks are re-embedded.

### 3.3 Fix linking across the lineage

Trusted Git (`@autos/git-runner`, Task C) keeps one bare mirror per lineage (one repository each; the two current repos share no history) under `data/mirrors/<lineage>.git`, fetched with the existing askpass credential. Incrementally scan all refs matching `scan_branches`:

- commit messages, branch names, and Bitbucket merge messages for issue keys of **any** project. Convention (confirmed): a fix uses the **local** project's ticket key, and only falls back to the original ticket's key when the local project has no ticket. So a port of PROJA-12's fix to project B usually says `PROJB-55`, not `PROJA-12`. Cross-project links therefore come from **patch-id equality**, not from keys: if a PROJB-55 commit has the same patch-id as a PROJA-12 commit, PROJA-12 and PROJB-55 are recorded as the same defect (a strong positive signal and an evaluation label). A commit on project B's branch that names a foreign key (`PROJA-12`) is recorded as "ported without a local ticket";
- per matched commit: `patch-id` (`git patch-id --stable`), files + numstat, the branches that contain it (`git branch -r --contains`, cached per node), revert detection;
- Autos' own attempts from the jobs DB (commit, changed paths, human outcome merged/abandoned).

Derived facts per fix commit, used later as evidence:
- **Ported to:** other nodes containing a commit with the same patch-id (cherry-picks keep the patch-id even with different SHAs).
- **Introduced-before-fork:** `git blame` the lines the fix removed/changed (on the fix's parent) and check whether the blamed commits are ancestors of each node's fork point. If yes, the buggy code was inherited by that node.

This replaces the Bitbucket REST commit scan and its optional read token for precedents.

## 4. Embeddings and storage

- **Embeddings: local only** through an `EmbeddingPort` with an Ollama adapter (Mac: native app with Metal; Ubuntu: an internal Compose service, no published port, model pulled once). Choose between 2–3 multilingual retrieval models (e.g. `qwen3-embedding:0.6b`, `bge-m3`) in the Phase 0 spike by benchmark precision and server throughput. The whole Jira corpus never leaves the host; only the final ≤ 10 candidates go to the judge (§5, approved).
- **Store: one SQLite file `data/precedents.sqlite`** with FTS5 (BM25) and sqlite-vec loaded through `node:sqlite` (`allowExtension` + `loadExtension`; Node ≥ 22.13, Autos needs 22.20+), separate from `data/autos.sqlite` so it can be rebuilt without touching job state. Tens of thousands of tickets × ~5 chunks ≈ 100–300k vectors: brute-force KNN at ~100–300 ms per query is fine for one lookup per job; quantize if memory matters. No new database server. Phase 0 verifies sqlite-vec binaries on darwin-arm64 and the controller image and FTS5 in Node's bundled SQLite; fallback is LanceDB (embedded), not a server.
- Tables: `issues`, `chunks`, `chunks_fts`, `chunks_vec`, `error_sigs(sig, issue_id)`, `code_refs(issue_id, node, path)`, `fixes(issue_id, lineage, commit, patch_id, files, reverted, autos_job_id, autos_outcome)`, `fix_presence(patch_id, node, present)`, `fix_inheritance(commit, node, inherited)`, `lineage_nodes(lineage, branch, project_key, fork_point, fork_date)`, `term_stats`, `sync_state`, `index_meta`.

## 5. Retrieval pipeline with abstention

Query = the incoming ticket processed exactly like indexed tickets (defect statement, error signatures, code identifiers resolved on **its** branch).

**Stage 1 — candidate generation (recall, ~100 issues), from any project in scope, any type, any status:**
- vector KNN on the defect statement and head chunks;
- BM25 with the corpus stoplist applied (identifiers and rare terms carry weight, common domain words do not);
- exact error-signature matches;
- code-reference overlap (tickets whose resolved code refs or fix files intersect this ticket's resolved paths);
- Jira links of the current ticket (clones/duplicates/relates).

**Stage 2 — fusion and features (~20):** RRF across lists, then a transparent feature score: semantic similarity of defect statements, error-signature match, code-ref/fix-file overlap, same lineage, fix introduced-before-fork for this node, fix not yet present on this node, defect score, Autos merged outcome, recency (mild). Weights tuned on the benchmark (§9).

**Stage 3 — evidence gate (deterministic):** a candidate continues only if at least **two independent signals** agree, where keyword overlap alone never counts as one:
- strong semantic similarity of defect statements (above a calibrated threshold), and
- one of: error-signature match; code overlap (ticket paths ↔ candidate paths/fix files); lineage evidence (candidate fix touches code inherited by this node); an explicit Jira link.
Single-signal candidates with very high semantic similarity (near-duplicate text, e.g. the same bug pasted into two Jira projects) pass as "likely duplicate report".

**Stage 4 — LLM judge (approved; runs on the cheapest model tier, see §11 item 8):** the ≤ 10 survivors go, with the current ticket, to a read-only `precedent_judge` invocation through the trusted runner: no repository workspace, no tools, fresh session, small timeout, Zod-validated JSON output:

```json
{"schema_version":1,"verdicts":[{"issue_key":"B-123","same_defect":"yes|likely|no","confidence":0.0,"shared_evidence":["..."],"differences":["..."]}]}
```

The prompt carries summaries, defect statements, error signatures and fix file lists (≤ ~2 KB per candidate, ~25 KB total), all delimited and marked untrusted. Malformed output or timeout ⇒ judge result `NOT_RUN`, and only candidates that passed Stage 3 with a high calibrated score are kept (stricter threshold). The judge cannot add candidates, only keep or drop them; its verdict is advisory and never affects gates.

**Stage 5 — classify and abstain:** final results (max 5, often 0) are labeled:
- `ALSO_REPORTED` — same defect, other project, no fix yet (status shown);
- `FIXED_IN_RELATIVE` — fixed on a related node; with `applies_cleanly: true|false|unknown` (from `git apply --check` of the fix onto this node's base in a temporary index, trusted Git, no workspace changes) and `inherited: true|false|unknown`;
- `ALREADY_PRESENT_HERE` — the fix's patch-id is already on this node (possible regression or different bug; shown with a caveat);
- `RELATED_FIX` — similar area, weaker match (only in CLI search, never in prompts).

If nothing survives, the outcome is `NO_MATCH` and the SWE prompt says nothing about precedents. That is the expected common case.

## 6. Integration

### Ownership (AGENTS.md)

- New `packages/precedents` (`@autos/precedents`): store, text processing, sync orchestration, retrieval pipeline, `EmbeddingPort` + Ollama adapter. **Owned by the controller owner (Task E)** (decided 2026-11-12). It runs inside the controller process; it is a separate package only so the CLI (`precedents eval`, offline search) and the workflow can import it and its tests stay isolated, not because it is a separate service.
- `packages/contracts` (primary): schemas below, lineage config, judge output schema, possibly a new role value.
- `packages/atlassian` (A): index read methods; legacy `findHistoricalPrecedents` kept behind `source: legacy` for one release, then removed.
- `packages/git-runner` (C): lineage mirrors, fork points, key scan, patch-ids, containment, blame-inheritance, `apply --check`, bounded diff excerpts, path resolution.
- `packages/runner` (F): judge invocation profile (no workspace, no tools, read-only, egress to provider only).
- `packages/workflow` (D): `precedents.json` + `precedents.md`, judge call orchestration, reference block in `prompt()`, dataset fields.
- `apps/cli`, `apps/controller` except `runtime.ts`, `docs/cli.md`, `docs/openapi.yaml` (E): commands/endpoints.
- `apps/controller/src/runtime.ts` (primary): wiring. `docker-compose.yml` (F): `embeddings` service.

### Contracts (sketch)

```ts
precedentSchema v2 = {
  issue_key, issue_url, project_key, summary, status, resolution: string|null,
  kind: 'ALSO_REPORTED'|'FIXED_IN_RELATIVE'|'ALREADY_PRESENT_HERE',
  score: number, signals: Array<'semantic'|'error_signature'|'code_overlap'|'lineage'|'jira_link'|'near_duplicate'|'autos_merged'>,
  judge: { verdict: 'yes'|'likely', confidence: number } | null,
  fix: null | { lineage, node_branch, commit_shas, patch_id, evidence_url, files, diff_excerpt: string|null,
                applies_cleanly: boolean|null, inherited: boolean|null, ported_to: string[] },
  caveats: string[],
}
precedentResultSchema: items ≤ 5; outcome FOUND|NO_MATCH|DISABLED|INDEX_NOT_READY; judge: 'RAN'|'NOT_RUN'|'SKIPPED'
PrecedentReadPort.findPrecedents — signature unchanged.
PrecedentIndexPort { status, sync, rebuild, search(query, explain) }
EmbeddingPort { model(), embed(texts) }
```

`assertSafePrecedents` keeps validating Jira and Bitbucket evidence URLs against `jira.site_url` and the lineage repositories (which must also be in an allowlist; scan-only repos are never routed or pushed).

### Where it runs

The indexer runs inside the controller as a background single-flight loop (like the poller): Jira sync, mirror fetch + scans, lineage recompute, reconcile. Jobs only read the index. The lookup stays non-fatal at routing: errors produce today's "Precedent lookup unavailable (CODE)". The judge runs through the runner like other roles. Agent containers never see `precedents.sqlite`, mirrors or the embedding service.

### Config (replaces `jobs.similar_tickets`, accepted with a deprecation warning for one release)

```yaml
precedents:
  enabled: true
  source: semantic                  # semantic | legacy | off
  lineages: [...]                   # §2
  max_results: 3                    # prompt + precedents.md, hard cap 5
  index: {db_path: data/precedents.sqlite, window_weeks: 104, exclude_projects: [], exclude_security_levels: true,
          include_comments: true, sync_interval_minutes: 15, reconcile_interval_hours: 24, max_requests_per_run: 5000, pause_during_checks: true}
  embedding: {provider: ollama, url: http://127.0.0.1:11434, model: <from Phase 0>}
  gate: {semantic_threshold: <calibrated>, require_signals: 2}
  judge: {enabled: true, max_candidates: 10, timeout_ms: 120000, tier: null}   # null = cheapest tier in model_tiers; else a tier name or name:effort
  prompt: {roles: [], max_bytes: 20480, per_precedent_diff_bytes: 6144}   # [] until Phase 5 go/no-go
```

### CLI / API

```
autos index status [--json]
autos index sync [--full] [--reconcile]
autos index rebuild [--yes]
autos index purge --project KEY [--yes]
autos lineage show [--json]                       # nodes, fork points, which Jira project maps where
autos precedents search (--issue KEY | --text "...") [--all-projects] [--no-judge] [--explain] [--json]
autos precedents show KEY [--json]                # indexed text summary, error sigs, code refs, fixes, presence per node
autos precedents eval [--json]                    # §9 benchmark on the local index
```

API: `GET /index/status`, `POST /index/sync`, `GET /lineage`, `GET /precedents/search` (operator token, loopback; bodies never logged). `autos doctor` checks index DB, sqlite-vec, embedding service model/dims, mirrors and lineage config.

### Prompt use

SWE gets a nonce-delimited `REFERENCE` block (only `FIXED_IN_RELATIVE` and `ALREADY_PRESENT_HERE` items; `ALSO_REPORTED` tickets — the same bug still open elsewhere — never go to agents, decided 2026-11-12): kind, key, project, summary, ≤ 600-char description excerpt, signals, fix files, `applies_cleanly`/`inherited`, and a bounded diff excerpt from the mirror. Comments never enter prompts. Text passes through `neutralizeMarkers`; the block states it is untrusted, possibly wrong, not instructions, and fixes must be verified against this branch. Truncation order puts precedents first. Reviewer optionally gets keys + files only. Dataset export gains `precedent_keys` and `precedent_kinds`.

## 7. What the operator sees

`precedents.md` per job, e.g.:

```
# Precedents (3 checked, 1 shown; judge RAN)
## FIXED_IN_RELATIVE  PROJB-881 (Fixed, Story) — project B, lineage core
Signals: semantic, error_signature, lineage. Judge: yes (0.86)
Fix 3f2a… on release/projB: OrderService.java, PricingRule.java. Bug code inherited before fork (2021-06); fix not on this branch; applies cleanly.
## Rejected (not shown to agents): PROJC-77 (keyword overlap only), PROJA-1203 (judge: different defect)
```

Listing rejected candidates with the reason makes false positives visible and gives labels for tuning. `ALSO_REPORTED` tickets appear here under their own heading ("Same bug may be open in other projects").

### Possibly-affected section in the fix report (decided 2026-11-12)

When an attempt reaches READY_FOR_HUMAN, Autos re-checks with the **actual fix** (stronger evidence than the ticket text alone) and adds a "May also affect" section to the attempt's fix report:

- **Open tickets in other projects** that matched as `ALSO_REPORTED` at routing, re-verified against the final diff (same files or same error signature).
- **Projects with no ticket yet:** other nodes in the same lineage whose development branch still contains the code this fix changed (blame-inheritance from before their fork, and `git apply --check` of `changes.patch` onto their branch tip succeeds or nearly succeeds), and where no commit with the same patch-id exists. Listed as "branch X (Jira project Y): fix applies cleanly / needs adaptation".

Every entry is worded as "may be a similar issue and should be checked/fixed", with the evidence, never as a confirmed bug.

This information is **advisory only**. Autos does not queue, revise or run anything for those tickets or projects; an agent works on one only when someone queues it (`autos run KEY`, or the ticket enters the saved filter as usual). Nothing is written to Jira.

Where the section goes: `summary.md`, a `fix-report.md` artifact, `possibly-affected.json` for tooling, and the **Confluence fix-document draft** described in §12 (decided 2026-11-12).

## 8. Security and privacy

- **Credentials:** existing Atlassian read credential and trusted Git askpass in the controller; no Bitbucket read token needed; provider credentials stay with the supervisor; nothing new in agent containers.
- **Stored data:** `precedents.sqlite` (ticket text, comments, embeddings — treat embeddings as sensitive) and `data/mirrors/` (full history), mode 0700/0600, owner `autos`, rebuildable so backups optional.
- **Disclosure:** the full corpus stays local. Per job, the judge sends the current ticket plus ≤ 10 candidate summaries/defect statements from other Jira projects to the configured provider (user-approved). Comments are not sent. `judge.enabled: false` turns this off; `exclude_projects` keeps sensitive projects out of the index entirely.
- **Access control:** the index sees what the Autos service account sees; scope is the branch-map projects plus explicit extras; security-level issues and restricted comments excluded; reconcile purges within a day; `index purge` for immediate removal.
- **Prompt injection:** candidate ticket text is untrusted for both the judge and the SWE. The judge has no tools or workspace and can only drop candidates (an injected "yes" can at most show one wrong reference, still behind the Stage 3 evidence gate); SWE references are delimited, neutralized, capped, comment-free, and never change gates, path policy or permissions. Search terms from the current ticket are quoted/escaped for FTS5 and never placed in JQL.
- **Logs:** counts, ids, durations and codes only.

## 9. Testing and evaluation

### Tests (fakes only)

- Jira sync with a fake fetch: pagination, 429/`Retry-After`, 401/403, moved/deleted/permission-lost issues, security levels, restricted comments, budget stop and resume.
- Text processing: template learning/stripping, corpus stoplist, defect-statement extraction, error signature normalization, secret redaction.
- Lineage with disposable local Git repos: two lineages; root + project branches + dev/sbx forks; a bug introduced before a fork and fixed on one branch; a cherry-pick (same patch-id, different SHA) on another; a revert; fork-point, containment, inheritance and `apply --check` results asserted.
- Retrieval: deterministic fake embedder; a fixture corpus with **keyword-trap tickets** (same product words, different defects) that must be rejected; the evidence gate; abstention ⇒ `NO_MATCH`; near-duplicate cross-project reports; dedupe of tickets sharing one fix.
- Judge: fake provider returning valid, malformed, timed-out and injected outputs; it can drop but not add; `NOT_RUN` fallback.
- Workflow: `precedents.json`/`.md`, prompt block only for configured roles, injection neutralization, truncation order, non-fatal failures, dataset fields.
- `npm run check` stays green; no live Jira, Bitbucket, Ollama or provider calls.

### Evaluation (`autos precedents eval`, local data only)

Automatic labels that match how this company works:
1. **Ported fixes (strongest positives):** tickets in different Jira projects whose fix commits share a patch-id are the same defect. These are exactly the cross-project cases the user describes.
2. **Inherited-code fixes:** tickets whose fixes change the same pre-fork lines.
3. **Autos merged attempts:** tickets whose fix files overlap an Autos merged `changes.patch`.
4. **Hard negatives:** pairs with high keyword/BM25 overlap whose fixes touch disjoint files in unrelated areas — the false-positive trap set.
5. **Human spot check:** the operator labels the top results (shown and rejected) for ~30 recent tickets.

Metrics: precision of shown results (primary), false-positive rate on hard negatives, recall@5 on ported fixes, abstention rate on tickets with no known relative. Compare: today's heuristic, BM25, vector, hybrid, hybrid + gate, hybrid + gate + judge. Thresholds are set to reach the precision target; the operator can trade recall in config.

Go/no-go for prompts: ≥ 80% precision on shown results in labels 1–3 and the spot check, and hard-negative false-positive rate under 5%.

## 10. Rollout phases (one engineer with implementation agents; working days)

| Phase | Scope | Effort |
|---|---|---|
| 0. Spike | sqlite-vec + FTS5 under `node:sqlite` on Mac and controller image; embedding model benchmark; operator runs read-only JQL counts for the 2-year window and lists branches per repo; check how many `*_dev`/`*_sbx` branches attach automatically | 2–3 |
| 1. Index | Contracts, `@autos/precedents` store + text processing, Jira read methods, Ollama adapter, sync/reconcile, `index` commands, text-only `precedents search` | 7–9 |
| 2. Lineage | Lineage config, mirrors, fork points, key scan across all refs, patch-ids, containment, Autos attempts, `lineage show`, `precedents show` | 6–8 |
| 3. Code evidence | Path resolution of ticket identifiers, blame-based inheritance, `apply --check`, fix presence per node | 4–5 |
| 4. Retrieval + eval | Candidate generation, fusion, evidence gate, abstention, classification, eval harness with automatic labels, threshold calibration; replace legacy lookup in `precedents.md` | 6–8 |
| 5. Judge + prompts + fix report | `precedent_judge` invocation via the runner, fallback rules, SWE reference block, dataset fields; post-fix "May also affect" check, `fix-report.md` / `possibly-affected.json`; enable prompts after go/no-go | 5–7 |
| 7. Confluence draft | §12: draft-only write client, storage-format renderer, `autos confluence draft`, auto-draft option, doctor check, policy/doc updates | 4–5 |
| 6. Server + docs | Compose `embeddings` service, permissions, `server-setup.md`, `local-pilot.md`, `cli.md`, openapi, template cleanup (drop the read-token comments), deprecate `jobs.similar_tickets` | 2–3 |
| **Total** | | **~36–48 days (≈ 7.5–9.5 weeks)**; phase 7 depends only on phase 5's fix report and can run in parallel with phase 6 |

## 11. Decisions and open questions

### Answered (2026-11-12)

1. The two root repositories share no Git history: two independent lineages; microservice repos become further lineages.
2. Every Jira project is in the Confluence branch map: index scope = branch-map projects; no text-only extra projects.
3. Fix commits use the local project's ticket key, falling back to the original ticket's key only when there is no local ticket: cross-project links come from patch-id equality (§3.3).
4. Dev and sandbox branches are `<code>_dev` / `<code>_sbx`, where `<code>` is not always the Jira/Confluence key: attached by name, then ancestry, then an optional `branch_codes` override (§2).
5. Index window: about 2 years (`updated >= -104w`); mirrors keep full history for inheritance checks.
6. No projects or content need to be excluded beyond Jira security levels and restricted comments.
7. Same bug still open in another project (`ALSO_REPORTED`): listed only in `precedents.md` and in the fix report's "May also affect" section, never given to agents and never auto-queued; an agent works on it only when someone queues it (§7).
8. Judge provider: **cheapest model** (decided 2026-11-12). The judge uses the cheapest tier in the existing `model_tiers` config (the first tier of the shortest-cost ladder, at low effort), overridable with `precedents.judge.tier`. Without `model_tiers` it uses the reviewer's primary provider with its smallest configured model. One call per job, skipped when no candidate passes the evidence gate; tier fallbacks apply on provider failure, and a judge failure is `NOT_RUN` (stricter local threshold), never a job failure. The eval (§9) reports judge precision, so a larger tier can be chosen if the cheapest one misjudges.
9. Server hardware (partly answered): about 32 GB RAM expected, GPU unknown. **Plan for CPU only:** a ~0.6B embedding model (≈ 1–2 GB RAM in Ollama), vectors for the 2-year window well under 1 GB (int8 if needed), so the index fits next to the controller and job containers. The first full embedding may take a few hours on CPU and runs as a background job at low priority; incremental updates are small. Embedding pauses while check containers run if the host is busy (`index.pause_during_checks: true`). A GPU, if present, only shortens the first build.
10. Owner: the controller owner (Task E); code in `packages/precedents`, running in the controller process.

### Still open

- Rough number of issues in the 2-year window (Phase 0 read-only JQL count), and whether the server has a GPU.
- Confluence draft (§12): which space and parent page the fix documents live under, whether a company template exists for them, and whether the server will keep using the operator's own Atlassian token or move to a service account.

## 12. Confluence fix-document draft (decided 2026-11-12)

### What the user asked for

When a fix is ready, Autos creates a **Confluence draft** of the fix document (fix information plus the "May also affect" section). Only the logged-in user can see it. They review and edit it in Confluence and **publish it themselves**. Autos never publishes.

### How it works

- Confluence Cloud supports unpublished drafts: `POST /wiki/api/v2/pages` with `status: "draft"` creates a page that is visible only to the account that created it until someone publishes it in the editor. Autos calls this with the Atlassian credential the controller already holds, so **the draft belongs to whoever that token belongs to**. On the Mac pilot that is the operator's own account, which matches "only the logged-in user can see it". (Phase 0 verifies draft visibility and the exact v2 request/response in a personal test space before any code depends on it.)
- One draft per READY_FOR_HUMAN attempt, created on demand with `autos confluence draft JOB_ID|ISSUE-KEY` (and `POST /jobs/{id}/confluence-draft`), or automatically when `confluence.drafts.auto: true`. The result (page id, edit link, attempt id) is stored in the job DB and shown by `autos show` / `autos jobs show`.
- A revision attempt updates **its own draft only while it is still a draft**: Autos reads the page first; if its status is no longer `draft` (the user published it) or the version changed (the user edited it), Autos does not touch it and creates a new draft instead, linking the earlier page. Autos never updates a published page and never deletes anything.
- Content: title `<ISSUE-KEY>: <summary> — fix`, then sections generated from trusted artifacts: ticket link, repository/branch/commit, changed files, checks/QA/review results, the fix summary, **"May also affect"** (§7), precedents used, and the limitations line. If the company has a fix-document template page, Autos reads it (read-only) and fills its headings; otherwise a built-in layout.

### Safety and policy changes (primary agent)

- This is the first Atlassian write in Autos, so it needs a deliberate, narrow policy change: AGENTS.md ("Jira and Confluence clients expose reads only") and `security.allow_confluence_write: z.literal(false)` are replaced by a single capability `confluence.drafts: {enabled: false, space_key, parent_page_id, auto: false}`, off by default. Jira stays read-only.
- The write lives in a separate, tiny client (`ConfluenceDraftWriter`, Task A) that can only: create a page with `status: "draft"` in the configured space under the configured parent, and update a page that Autos created **and** whose status is still `draft`. It hard-codes the status (no publish path exists in code), refuses any other space/parent, uses no redirects, and returns only ids and links. Tests assert that no request ever carries `status: "current"`, a DELETE, or a page Autos did not create.
- Agents never get this capability. The knowledge gateway stays read-only; the draft is created by the controller from trusted artifacts after the workflow has finished.
- All text from tickets, agents and precedents is escaped into Confluence storage format (XHTML text nodes only); no raw HTML, macros or links are taken from untrusted text; links are generated by Autos from validated Jira and Bitbucket URLs. Secret patterns are redacted as in logs.
- Audit: one record per draft call (time, job, page id, outcome) in the job events; never the page content.
- **Service-account caveat:** if the server later uses a shared Atlassian service account, drafts would belong to that account and no person could see them. Options then: keep a per-operator token on the server for drafts only, or fall back to `fix-report.md` only. Decide before the server move.

### Tests

Fake Confluence server: create draft (request shape, space/parent enforcement), update only while draft, published/edited page ⇒ new draft, 401/403/404/429 handling, storage-format escaping of hostile ticket and agent text, no publish/delete ever issued, feature off by default, audit without content.

## 13. Implementation status (2026-11-12)

Built and tested with fakes and disposable local repositories only (no live Jira, Confluence, Bitbucket, Ollama or provider calls):

- Contracts: `packages/contracts/src/precedents.ts` (lineages, index records, results, judge, possibly-affected, fix document, draft records, `precedents` and `confluence.drafts` config, ports).
- Jira index reads and the draft-only Confluence writer: `packages/atlassian/src/{index-sync,drafts,http}.ts`.
- Lineage Git operations: `packages/git-runner/src/lineage.ts`.
- Index, text processing, retrieval pipeline, judge prompt, renderers, evaluation and the service: `packages/precedents/`.
- Workflow: semantic lookup at routing, `precedents.json`, SWE/reviewer reference block (off until `prompt.roles` is set), "May also affect", `fix-report.md`, Confluence draft creation, dataset fields.
- Controller/CLI/API: background index loop, `/v1/index/*`, `/v1/lineage`, `/v1/precedents/*`, `/v1/confluence-drafts`, `autos index|lineage|precedents|confluence` commands, doctor checks, docs.
- Runtime wiring: the index runs whenever `precedents.enabled` (so it can be built and evaluated with `source: legacy`); jobs use it only with `source: semantic`. The judge runs on the cheapest model tier through the runner.

Everything is off by default; without the new config blocks Autos behaves exactly as before.

Not done yet: Phase 0 live checks (Confluence draft request shape and visibility in a personal test space, an Ollama model and its dimensions, Git ≥ 2.37 on the server, the issue count), threshold calibration with `autos precedents`-based evaluation on real data, an `autos precedents eval` command, sqlite-vec (brute-force vectors for now), and the Compose `embeddings` service.

## Deliverable and verification

On approval, this content is written to `docs/semantic-precedents-plan.md` (the only file created; no other file changed, nothing committed). The current-state description was checked against `packages/atlassian/src/index.ts`, `packages/workflow/src/index.ts`, `packages/contracts/src/{domain,ports,config,dataset}.ts`, `docker-compose.yml`, `config/*.template.yaml` and `docs/server-setup.md`.
