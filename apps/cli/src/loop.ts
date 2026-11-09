import { AutosError, type AutosConfig, type JobEvent, type WorkflowServicePort } from '@autos/contracts';
import type { LoopStatus } from '@autos/controller';

const MAX_POLL_BACKOFF_SECONDS = 300;
/** Poll delay: the configured interval, doubling per consecutive failure, capped at max(4x interval, 5 minutes). */
export function pollDelayMs(pollSeconds: number, consecutiveFailures: number): number {
  const cap = Math.max(pollSeconds * 4, MAX_POLL_BACKOFF_SECONDS);
  const factor = 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 16);
  return Math.min(pollSeconds * factor, cap) * 1000;
}

export function waitForSignalOrTimeout(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolvePromise(); };
    const onAbort = () => finish();
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

export type LoopSleep = (ms: number, signal: AbortSignal, kind?: 'discover' | 'drain') => Promise<void>;

/** Events that mean work may be ready to run: a job was queued/requeued or an execution slot may have freed. */
const WAKE_EVENTS: ReadonlySet<JobEvent['type']> = new Set(['job_queued', 'job_finished', 'revision_requested', 'recovered']);

export interface ControllerLoopOptions {
  workflow: WorkflowServicePort;
  config: AutosConfig;
  signal: AbortSignal;
  state: LoopStatus;
  stdout(text: string): void;
  stderr(text: string): void;
  sleep?: LoopSleep;
  now?(): Date;
}

function logFailure(stderr: (text: string) => void, event: string, error: unknown, failures: number, retrySeconds: number): void {
  if (failures !== 1 && failures % 10 !== 0) return;
  const code = error instanceof AutosError ? error.code : 'INTERNAL';
  stderr(JSON.stringify({ event, code, consecutive_failures: failures, retry_seconds: retrySeconds }));
}

/**
 * The `controller start` scheduler. Two independent loops so a long job never stops intake:
 * - discovery (only when jira.auto_poll): discover() every poll_seconds with bounded backoff on failure;
 * - drain: drain() whenever discovery queued work, a job settled or was queued, or every poll_seconds.
 * With auto_poll off, discover() is never called; drain still runs submitted and requeued (auto-retry) jobs.
 */
export async function runControllerLoop(options: ControllerLoopOptions): Promise<void> {
  const { workflow, config, signal, state, stdout, stderr } = options;
  const sleep: LoopSleep = options.sleep ?? ((ms, inner) => waitForSignalOrTimeout(inner, ms));
  const now = options.now ?? (() => new Date());
  const pollSeconds = config.jira.poll_seconds;
  const autoPoll = config.jira.auto_poll;
  state.auto_poll = autoPoll;
  state.running = true;

  let wakePending = false;
  let wakeSleep: AbortController | undefined;
  const wake = (): void => { wakePending = true; wakeSleep?.abort(); };
  const unsubscribe = workflow.subscribe((event) => { if (WAKE_EVENTS.has(event.type)) wake(); });

  if (!autoPoll) stdout('auto_poll disabled: only submitted jobs run');

  const discoveryLoop = async (): Promise<void> => {
    let failures = 0;
    while (!signal.aborted) {
      state.next_poll_at = null;
      try {
        const result = await workflow.discover(signal);
        failures = 0; state.consecutive_failures = 0; state.last_discovery_at = now().toISOString();
        if (result.queued > 0) wake();
      } catch (error) {
        if (signal.aborted) break;
        failures = Math.min(failures + 1, 1000); state.consecutive_failures = failures;
        logFailure(stderr, 'poll_failed', error, failures, pollDelayMs(pollSeconds, failures) / 1000);
      }
      if (signal.aborted) break;
      const delay = pollDelayMs(pollSeconds, failures);
      state.next_poll_at = new Date(now().getTime() + delay).toISOString();
      await sleep(delay, signal, 'discover');
    }
  };

  const drainLoop = async (): Promise<void> => {
    let failures = 0;
    while (!signal.aborted) {
      wakePending = false;
      try { await workflow.drain(signal); failures = 0; }
      catch (error) {
        if (signal.aborted) break;
        failures = Math.min(failures + 1, 1000);
        logFailure(stderr, 'drain_failed', error, failures, pollDelayMs(pollSeconds, failures) / 1000);
      }
      if (signal.aborted) break;
      if (wakePending) continue; // something was queued or settled while draining
      wakeSleep = new AbortController();
      try { await sleep(pollDelayMs(pollSeconds, failures), AbortSignal.any([signal, wakeSleep.signal]), 'drain'); }
      finally { wakeSleep = undefined; }
    }
  };

  try {
    await Promise.all([drainLoop(), ...(autoPoll ? [discoveryLoop()] : [])]);
  } finally {
    unsubscribe();
    state.running = false; state.next_poll_at = null;
  }
}
