import { DatabaseSync } from 'node:sqlite';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AutosError, datasetExportOptionsSchema, datasetRecordSchema, jobIdSchema, providerCallSchema, semanticPrecedentResultSchema, type AutosConfig, type DatasetExportOptions, type DatasetRecord } from '@autos/contracts';

type Outcome = DatasetRecord['outcome'];
type Note = DatasetRecord['operator_notes'][number];
type Call = DatasetRecord['calls'][number];
type Row = Record<string, unknown>;

const ROLES = ['swe', 'qa', 'reviewer'] as const;
const TRUNCATION_MARKER = '[transcript truncated]';
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Reads a regular file below `base` without following symlinks (any component); null when missing, unsafe or unreadable. */
async function safeRead(base: string, ...segments: string[]): Promise<string | null> {
  try {
    let current = base;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return null;
      if (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()) return null;
    }
    return await readFile(current, 'utf8');
  } catch { return null; }
}
async function safeJson(base: string, ...segments: string[]): Promise<unknown | null> {
  const text = await safeRead(base, ...segments);
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
async function realDirectory(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

function notesOf(db: DatabaseSync, jobId: string): Note[] {
  const rows = db.prepare('SELECT instructions,roles,author,created_at,source FROM operator_notes WHERE job_id=? ORDER BY seq').all(jobId) as Row[];
  return rows.flatMap((row) => {
    try {
      const roles = JSON.parse(String(row.roles)) as unknown;
      return [{ instructions: String(row.instructions), roles: Array.isArray(roles) ? roles : [], author: String(row.author), created_at: String(row.created_at), ...(row.source === 'ticket' ? { source: 'ticket' } : {}) } as Note];
    } catch { return []; }
  });
}

async function callsOf(privateRoot: string, include: { prompts: boolean; transcripts: boolean }): Promise<Call[]> {
  const found: Array<{ key: string; mtime: number; call: Call }> = [];
  for (const role of ROLES) {
    const roleDir = join(privateRoot, role);
    if (!(await realDirectory(roleDir))) continue;
    let names: string[];
    try { names = (await readdir(roleDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { continue; }
    for (const invocation of names) {
      if (!jobIdSchema.safeParse(invocation).success) continue;
      const directory = join(roleDir, invocation);
      let mtime = 0;
      try { const info = await lstat(directory); if (info.isSymbolicLink() || !info.isDirectory()) continue; mtime = info.mtimeMs; } catch { continue; }
      const parsed = providerCallSchema.safeParse(await safeJson(directory, 'call.json'));
      const call = parsed.success && parsed.data.invocation_id === invocation && parsed.data.role === role ? parsed.data : null;
      const transcriptText = include.transcripts ? await safeRead(directory, 'output', 'transcript.jsonl') : null;
      found.push({
        key: call?.started_at ?? new Date(mtime).toISOString(), mtime,
        call: {
          call, role, invocation_id: invocation,
          prompt: include.prompts ? await safeRead(directory, 'input', 'prompt.md') : null,
          transcript: transcriptText,
          transcript_truncated: transcriptText !== null && transcriptText.trimEnd().split('\n').at(-1) === TRUNCATION_MARKER,
        },
      });
    }
  }
  return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.mtime - b.mtime)).map((item) => item.call);
}

async function precedentFields(json: (name: string) => Promise<unknown>): Promise<{ precedent_keys?: string[]; precedent_kinds?: string[] }> {
  const parsed = semanticPrecedentResultSchema.safeParse(await json('precedents.json'));
  return parsed.success ? { precedent_keys: parsed.data.items.map((i) => i.issue_key), precedent_kinds: parsed.data.items.map((i) => i.kind) } : {};
}

/**
 * Streams one dataset record per non-dry-run, finished attempt (oldest first). Reads the SQLite database read-only (safe while the
 * controller runs) and the artifacts directory without following symlinks. Missing or malformed artifacts become null.
 */
export async function* exportDataset(input: { config: AutosConfig; options: DatasetExportOptions; now?: () => Date }): AsyncGenerator<DatasetRecord> {
  const options = datasetExportOptionsSchema.parse(input.options);
  const databasePath = join(input.config.storage.data_dir, 'autos.sqlite');
  if (!existsSync(databasePath)) throw new AutosError('NOT_FOUND', 'Autos database not found in the configured data directory');
  const artifactsRoot = input.config.storage.artifacts_dir;
  const exportedAt = (input.now ?? (() => new Date()))().toISOString();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const closures = new Map<string, Row>();
    for (const row of db.prepare('SELECT * FROM issue_closures').all() as Row[]) closures.set(String(row.issue_key), row);
    const jobs = db.prepare('SELECT * FROM jobs WHERE dry_run=0 ORDER BY created_at, rowid').all() as Row[];
    const children = new Map<string, string[]>();
    for (const row of db.prepare('SELECT job_id,parent_job_id FROM jobs WHERE parent_job_id IS NOT NULL ORDER BY created_at, rowid').all() as Row[]) {
      const parent = String(row.parent_job_id); children.set(parent, [...(children.get(parent) ?? []), String(row.job_id)]);
    }
    for (const job of jobs) {
      const jobId = String(job.job_id); const issueKey = String(job.issue_key); const state = String(job.state);
      if (options.issue_key && issueKey !== options.issue_key) continue;
      if (options.since && String(job.updated_at) < options.since) continue;
      const closure = closures.get(issueKey);
      let outcome: Outcome;
      if (closure && closure.job_id === jobId && (closure.resolution === 'MERGED' || closure.resolution === 'ABANDONED')) outcome = closure.resolution === 'MERGED' ? 'merged' : 'abandoned';
      else if (state === 'READY_FOR_HUMAN') outcome = children.has(jobId) ? 'revised' : 'awaiting_review';
      else if (state === 'BLOCKED') outcome = 'blocked';
      else if (state === 'CANCELLED') outcome = 'cancelled';
      else continue; // PLANNED and non-terminal attempts are not training data yet
      if (options.outcomes && !options.outcomes.includes(outcome)) continue;

      const feedback = outcome === 'revised' ? (children.get(jobId) ?? []).flatMap((child) => notesOf(db, child)) : [];
      const jobDir = join(artifactsRoot, jobId);
      const dirOk = await realDirectory(jobDir);
      const json = (name: string) => (dirOk ? safeJson(jobDir, name) : Promise.resolve(null));
      const text = (name: string) => (dirOk ? safeRead(jobDir, name) : Promise.resolve(null));
      const timeline = (db.prepare("SELECT at,type,stage,role,provider,outcome,code FROM job_events WHERE job_id=? AND type <> 'role_progress' ORDER BY event_id").all(jobId) as Row[])
        .map((row) => ({ at: String(row.at), type: String(row.type), stage: str(row.stage), role: str(row.role), provider: str(row.provider), outcome: str(row.outcome), code: str(row.code) }));
      const record = {
        schema_version: 1, exported_at: exportedAt, job_id: jobId, issue_key: issueKey, revision: Number(job.revision ?? 0), parent_job_id: str(job.parent_job_id),
        repository_id: str(job.repository_id), base_branch: str(job.base_branch), base_sha: str(job.base_sha), commit_sha: str(job.commit_sha), feature_branch: str(job.feature_branch),
        final_state: state, blocked_code: str(job.blocked_code), created_at: String(job.created_at), updated_at: String(job.updated_at),
        outcome, feedback, operator_notes: notesOf(db, jobId),
        issue: await json('issue.json'), rounds: await json('rounds.json'), checks: await json('checks.json'), baseline_checks: await json('baseline-checks.json'),
        qa: await json('qa.json'), review: await json('review.json'), tiers: await json('tiers.json'),
        instructions: await text('effective-instructions.md'), precedents: await text('precedents.md'), final_diff: await text('changes.patch'),
        calls: dirOk ? await callsOf(join(jobDir, '_private'), { prompts: options.include_prompts, transcripts: options.include_transcripts }) : [],
        timeline,
        // Semantic precedents shown for this attempt; the fields are omitted entirely without a valid precedents.json (legacy).
        ...(await precedentFields(json)),
      };
      const parsed = datasetRecordSchema.safeParse(record);
      if (!parsed.success) throw new AutosError('INVALID_OUTPUT', `Dataset record for job ${jobId} failed validation`);
      yield parsed.data;
    }
  } finally { db.close(); }
}
