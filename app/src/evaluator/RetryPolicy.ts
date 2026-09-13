/**
 * Pure bounded-backoff schedule for automatic worker-crash recovery.
 * Independently testable with no timers, no transport, no coordinator state.
 *
 * `nextBackoff(attempt)` returns the delay (ms) before the next automatic
 * retry, or `null` once `maxAttempts` is exhausted — at which point
 * `EvaluationCoordinator` stops retrying on its own and waits for an
 * explicit `retry()` call (e.g. a user pressing "Retry Worker"), which
 * always goes through the same recovery transition regardless of who
 * triggered it (see EvaluationCoordinator.ts's R4 discussion).
 */
export interface RetryPolicy {
  nextBackoff(attempt: number): number | null;
}

export interface BoundedBackoffOptions {
  readonly maxAttempts?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
}

export function boundedBackoff(options: BoundedBackoffOptions = {}): RetryPolicy {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 4000;
  return {
    nextBackoff(attempt: number): number | null {
      if (attempt >= maxAttempts) return null;
      return Math.min(baseMs * 2 ** attempt, maxMs);
    },
  };
}
