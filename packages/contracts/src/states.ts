import type { JobState } from './domain.js';

const transitions: Record<JobState, readonly JobState[]> = {
  QUEUED: ['INVESTIGATING', 'BLOCKED', 'CANCELLING'],
  INVESTIGATING: ['PLANNED', 'IMPLEMENTING', 'PAUSED', 'BLOCKED', 'CANCELLING'],
  PLANNED: [],
  IMPLEMENTING: ['QA', 'PAUSED', 'BLOCKED', 'CANCELLING'],
  QA: ['REVIEW', 'REVISING', 'PAUSED', 'BLOCKED', 'CANCELLING'],
  REVIEW: ['REVISING', 'READY_FOR_HUMAN', 'PAUSED', 'BLOCKED', 'CANCELLING'],
  REVISING: ['IMPLEMENTING', 'PAUSED', 'BLOCKED', 'CANCELLING'],
  /**
   * Every provider of a role's chain hit a usage limit: the attempt waits (no slot, no lease) with its workspace, base and
   * repair round intact, and resumes through INVESTIGATING (re-validated intake) when due. Cancellable; blocks after
   * jobs.rate_limit_pause.max_total_hours.
   */
  PAUSED: ['INVESTIGATING', 'BLOCKED', 'CANCELLING'],
  READY_FOR_HUMAN: [],
  BLOCKED: [],
  CANCELLING: ['CANCELLED', 'BLOCKED'],
  CANCELLED: [],
};
/** Retries create a new attempt; terminal history is immutable. */
export function canTransition(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}
export function isTerminalState(state: JobState): boolean {
  return transitions[state].length === 0;
}
