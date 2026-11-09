import type { JobEvent, WorkflowActivity, WorkflowServicePort } from '@autos/contracts';

export const emptyActivity: WorkflowActivity = {
  active: null, active_jobs: [], slots: { max_parallel: 1, in_use: 0, max_concurrent_checks: 1, checks_in_use: 0 },
  polling: { in_progress: false, last_started_at: null, last_finished_at: null, last_outcome: null, last_error_code: null, last_discovered: null },
  counts: {}, last_event_id: 0,
};

export function makeEvent(id: number, extra: Partial<JobEvent> = {}): JobEvent {
  return { event_id: id, at: `2026-11-07T12:01:${String(id % 60).padStart(2, '0')}.000Z`, type: 'role_started', job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', issue_key: 'SAMPLE-1', stage: 'implementation', role: 'swe', provider: 'claude', repair_round: 0, ...extra };
}

/** In-memory events/subscribe/activity for the WorkflowServicePort. */
export function monitorPort(initial: JobEvent[] = []): Pick<WorkflowServicePort, 'events' | 'subscribe' | 'activity' | 'discover' | 'drain' | 'reviseIssue' | 'closeIssue' | 'closure' | 'workspaces' | 'pruneWorkspaces' | 'addTicketNote' | 'removeTicketNotes' | 'setTicketHold' | 'ticketNotes'> & {
  store: JobEvent[]; listeners: Set<(event: JobEvent) => void>; emit(event: JobEvent): void; activityValue: WorkflowActivity;
} {
  const store = [...initial];
  const listeners = new Set<(event: JobEvent) => void>();
  const port = {
    store, listeners, activityValue: emptyActivity,
    emit(event: JobEvent) { store.push(event); for (const listener of [...listeners]) listener(event); },
    events: async (query: { job_id?: string; after?: number; limit: number }) => store.filter((event) => event.event_id > (query.after ?? 0) && (!query.job_id || event.job_id === query.job_id)).slice(0, query.limit),
    subscribe: (listener: (event: JobEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activity: async () => port.activityValue,
    discover: async () => ({ discovered: 0, queued: 0 }),
    drain: async () => undefined,
    // Issue closure / workspace hygiene defaults: nothing closed, nothing on disk. Tests override what they exercise.
    reviseIssue: async () => { throw new Error('reviseIssue not faked'); },
    closeIssue: async () => { throw new Error('closeIssue not faked'); },
    closure: async () => null,
    workspaces: async () => [],
    // Ticket notes defaults: none stored. Tests override what they exercise.
    addTicketNote: async () => { throw new Error('addTicketNote not faked'); },
    removeTicketNotes: async () => 0,
    setTicketHold: async () => undefined,
    ticketNotes: async (issueKey?: string) => issueKey === undefined ? [] : [{ issue_key: issueKey, notes: [], held: false, status: 'not_seen' as const, attempts: 0, dry_runs: 0, latest_job_id: null, latest_state: null, last_activity_at: null, attempts_with_current_notes: 0 }],
    pruneWorkspaces: async () => ({ dry_run: false, removed: [], failed: [], freed_bytes: null, remaining: 0 }),
  };
  return port;
}
