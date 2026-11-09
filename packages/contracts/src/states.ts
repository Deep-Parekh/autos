import type { JobState } from './domain.js';

const transitions: Record<JobState, readonly JobState[]> = {
  QUEUED: ['INVESTIGATING', 'BLOCKED', 'CANCELLING'],
  INVESTIGATING: ['PLANNED', 'IMPLEMENTING', 'BLOCKED', 'CANCELLING'],
  PLANNED: [],
  IMPLEMENTING: ['QA', 'BLOCKED', 'CANCELLING'],
  QA: ['REVIEW', 'REVISING', 'BLOCKED', 'CANCELLING'],
  REVIEW: ['REVISING', 'READY_FOR_HUMAN', 'BLOCKED', 'CANCELLING'],
  REVISING: ['IMPLEMENTING', 'BLOCKED', 'CANCELLING'],
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
