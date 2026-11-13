import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutosError, type AutosConfig, type PrecedentIndexPort } from '@autos/contracts';
import type { CheckResult } from './deep-doctor.js';

/**
 * Doctor checks for semantic precedents (docs/semantic-precedents-plan.md) and Confluence drafts. Missing optional
 * pieces are WARN, never FAIL. Messages are fixed phrases with names and counts: no URLs, tokens or ticket text.
 */

const code = (error: unknown): string => error instanceof AutosError ? error.code : 'INTERNAL';

/** Offline checks for plain `autos doctor` (no runtime, no network). Empty when config.precedents is absent. */
export async function precedentsDoctorChecks(config: AutosConfig, cwd: string): Promise<CheckResult[]> {
  const p = config.precedents;
  if (!p) return [];
  const results: CheckResult[] = [];
  const add = (name: string, status: CheckResult['status'], message: string): void => { results.push({ name, status, message }); };
  const summary = `enabled=${p.enabled}, source=${p.source}, ${p.lineages.length} lineage(s), auto_sync=${p.index.auto_sync}, judge=${p.judge.enabled ? (p.judge.tier ?? 'cheapest tier') : 'off'}, prompt roles=${p.prompt.roles.length ? p.prompt.roles.join(',') : 'none'}`;
  if (!p.enabled) add('precedents_config', 'WARN', `${summary}; the index is not used while precedents.enabled is false`);
  else if (p.source === 'legacy') add('precedents_config', 'WARN', `${summary}; jobs still use the legacy lookup until source is semantic`);
  else add('precedents_config', 'PASS', summary);

  const file = join(config.storage.data_dir, p.index.db_file);
  const path = resolve(cwd, file);
  const info = await stat(path).catch(() => null);
  if (!info) add('precedents_index_file', 'WARN', `${file} not found; it is created by the first sync (controller start with auto_sync, or autos index sync)`);
  else if (!info.isFile()) add('precedents_index_file', 'WARN', `${file} is not a regular file`);
  else {
    const writable = await access(path, constants.R_OK | constants.W_OK).then(() => true, () => false);
    const loose = (info.mode & 0o077) !== 0;
    add('precedents_index_file', !writable || loose ? 'WARN' : 'PASS', `${file} present (${(info.size / 1024 ** 2).toFixed(1)} MiB)${writable ? '' : '; not readable and writable by this user'}${loose ? '; permissions allow group/other access (expected 0600: it holds ticket text and embeddings)' : ''}`);
  }

  if (p.lineages.length === 0) add('precedents_lineages', 'WARN', 'no lineages configured: fix links, fork points and code evidence are unavailable (text search only)');
  else {
    const outside = p.lineages.filter((lineage) => !config.bitbucket.allowed_repositories.some((repo) => repo.workspace === lineage.repository.workspace && repo.repository_slug === lineage.repository.repository_slug));
    add('precedents_lineages', outside.length ? 'WARN' : 'PASS', outside.length
      ? `lineage repository not in bitbucket.allowed_repositories: ${outside.map((lineage) => lineage.id).join(', ')}`
      : `${p.lineages.map((lineage) => `${lineage.id}: ${lineage.repository.workspace}/${lineage.repository.repository_slug} root ${lineage.root_branch}`).join('; ')}`);
  }

  if (p.embedding.provider === 'none') add('precedents_embedding', 'WARN', 'embedding provider none: keyword and error-signature search only (no semantic matches)');
  else if (!p.embedding.model) add('precedents_embedding', 'WARN', `${p.embedding.provider} embedding model is not set`);
  else add('precedents_embedding', 'PASS', `${p.embedding.provider} model ${p.embedding.model}${p.embedding.dimensions ? ` (${p.embedding.dimensions} dims)` : ''}; service reachability is checked by doctor --deep through the index`);
  if (p.gate.semantic_threshold === undefined && p.embedding.provider !== 'none') add('precedents_gate', 'WARN', 'gate.semantic_threshold is not set; the index default applies until calibrated with the evaluation');
  return results;
}

/** Offline check for configured Confluence fix-document drafts; empty when confluence.drafts is absent. */
export function confluenceDraftsDoctorChecks(config: AutosConfig): CheckResult[] {
  const drafts = config.confluence.drafts;
  if (!drafts) return [];
  if (!drafts.enabled) return [{ name: 'confluence_drafts', status: 'WARN', message: 'confluence.drafts is configured but disabled' }];
  return [{ name: 'confluence_drafts', status: 'PASS', message: `drafts in space ${drafts.space_key} under page ${drafts.parent_page_id}, auto=${drafts.auto}; drafts belong to the account of ${config.confluence.token_env} and are visible only to it until published in Confluence` }];
}

/** `doctor --deep`: index status and lineage summary through the runtime's index. Empty when config.precedents is absent. */
export async function precedentsDeepChecks(config: AutosConfig, index: PrecedentIndexPort | undefined, runtimeError?: string): Promise<CheckResult[]> {
  if (!config.precedents) return [];
  if (!index) return [{ name: 'precedents_index', status: 'WARN', message: runtimeError ? `runtime unavailable (${runtimeError})` : 'this runtime does not provide the precedent index (precedents.enabled is false or source is legacy)' }];
  const results: CheckResult[] = [];
  try {
    const status = await index.status();
    const counts = `${status.issues} issues, ${status.vectors} vectors, ${status.fixes} fixes, ${status.projects.length} project(s), model ${status.embedding_model ?? 'none'}, last sync ${status.last_sync_at ?? 'never'}`;
    if (status.last_error_code) results.push({ name: 'precedents_index', status: 'WARN', message: `${counts}; last error ${status.last_error_code}` });
    else results.push({ name: 'precedents_index', status: status.ready ? 'PASS' : 'WARN', message: status.ready ? counts : `not ready yet (${counts})` });
  } catch (error) { results.push({ name: 'precedents_index', status: 'WARN', message: `index status unavailable (${code(error)})` }); }
  if (config.precedents.lineages.length === 0) return results;
  try {
    const lineage = await index.lineage(AbortSignal.timeout(120_000));
    const issues = [lineage.missing.length ? `missing: ${lineage.missing.join(', ')}` : '', lineage.unattached.length ? `${lineage.unattached.length} unattached branch(es)` : ''].filter(Boolean).join('; ');
    results.push({ name: 'precedents_lineage', status: lineage.nodes.length === 0 || lineage.missing.length ? 'WARN' : 'PASS', message: `${lineage.nodes.length} node(s) across ${new Set(lineage.nodes.map((node) => node.lineage_id)).size} lineage(s)${issues ? `; ${issues}` : ''}` });
  } catch (error) { results.push({ name: 'precedents_lineage', status: 'WARN', message: `lineage unavailable (${code(error)})` }); }
  return results;
}
