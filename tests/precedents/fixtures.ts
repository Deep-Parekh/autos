import type { IndexedIssue } from '@autos/contracts';

/** Builds a valid IndexedIssue for tests. */
export function issue(over: Partial<IndexedIssue> & { id: string; key: string }): IndexedIssue {
  const project = over.project_key ?? over.key.split('-')[0] ?? 'PROJA';
  return {
    project_key: project, issue_type: 'Story', status: 'Open', resolution: null, resolved_at: null,
    created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', summary: `Summary of ${over.key}`, description: '',
    components: [], labels: [], link_keys: [], parent_key: null, comments: [], comments_truncated: false, ...over,
  };
}
