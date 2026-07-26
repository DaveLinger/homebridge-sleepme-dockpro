// filename: src/sleepme/rateLimiter.ts

/**
 * The SleepMe API documents a quota of 10 requests per discrete minute window,
 * per user account: https://docs.developer.sleep.me/docs/
 *
 * "Discrete" matters. The server counts against a fixed wall-clock minute rather
 * than a sliding window, so this mirrors that exactly with a counter keyed to
 * Math.floor(now / 60000). A token bucket would throttle harder than the server
 * actually does.
 *
 * Because the quota is per account, one limiter is shared by every device behind
 * a single API token.
 */

export const REQUESTS_PER_MINUTE = 10;

/**
 * Budget held back from polling so a user's command is never blocked by
 * background traffic. A skipped poll costs nothing — another follows shortly —
 * whereas a delayed command shows up in HomeKit as "no response".
 */
export const DEFAULT_COMMAND_RESERVE = 4;

/** Polling may use the quota minus the command reserve. */
export const POLL_BUDGET_PER_MINUTE = REQUESTS_PER_MINUTE - DEFAULT_COMMAND_RESERVE;

export type RequestKind = 'poll' | 'command';

export class RateLimiter {
  private windowKey = -1;
  private used = 0;

  constructor(
    private readonly limit: number = REQUESTS_PER_MINUTE,
    private readonly commandReserve: number = DEFAULT_COMMAND_RESERVE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resets the counter when the wall-clock minute rolls over. */
  private roll(): void {
    const key = Math.floor(this.now() / 60000);
    if (key !== this.windowKey) {
      this.windowKey = key;
      this.used = 0;
    }
  }

  private capacityFor(kind: RequestKind): number {
    return kind === 'command' ? this.limit : Math.max(0, this.limit - this.commandReserve);
  }

  /** Consumes one request if this kind still has budget in the current window. */
  tryAcquire(kind: RequestKind): boolean {
    this.roll();
    if (this.used >= this.capacityFor(kind)) {
      return false;
    }
    this.used++;
    return true;
  }

  /** Milliseconds until the current window resets. */
  msUntilNextWindow(): number {
    return 60000 - (this.now() % 60000);
  }

  /** Requests still available to this kind in the current window. */
  remaining(kind: RequestKind): number {
    this.roll();
    return Math.max(0, this.capacityFor(kind) - this.used);
  }
}

/**
 * Thrown instead of issuing a poll when the polling budget is exhausted. This is
 * deliberately not an API failure: callers reschedule and try again later rather
 * than retrying, which would turn a saturated window into a retry storm.
 */
export class RateLimitDeferredError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Poll deferred to stay within the API rate limit; next window in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitDeferredError';
    this.retryAfterMs = retryAfterMs;
  }
}
