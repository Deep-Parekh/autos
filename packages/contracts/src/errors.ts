export const ERROR_CODES = [
  'INVALID_CONFIG', 'INVALID_INPUT', 'AUTH', 'FORBIDDEN', 'NOT_FOUND',
  'RATE_LIMIT', 'UPSTREAM', 'MAPPING', 'BRANCH_COLLISION', 'POLICY',
  'TIMEOUT', 'CANCELLED', 'CONTEXT', 'TOOL', 'INVALID_OUTPUT',
  'STALE_CANDIDATE', 'CHECK_FAILED', 'CONFLICT', 'INTERNAL',
  /** Provider CLI missing or not runnable in the execution environment. */
  'UNAVAILABLE',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

/** Messages must be authored safe text, never raw upstream or process output. */
export class AutosError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'AutosError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
