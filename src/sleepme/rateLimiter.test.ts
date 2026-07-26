import {
  DEFAULT_COMMAND_RESERVE,
  POLL_BUDGET_PER_MINUTE,
  RateLimitDeferredError,
  RateLimiter,
  REQUESTS_PER_MINUTE,
} from './rateLimiter.js';

// The limiter is driven by an injected clock so window behaviour can be tested
// exactly, without waiting on real time.
const limiterAt = (now: () => number) =>
  new RateLimiter(REQUESTS_PER_MINUTE, DEFAULT_COMMAND_RESERVE, now);

describe('RateLimiter budgets', () => {
  it('caps polls at the poll budget rather than the full limit', () => {
    const limiter = limiterAt(() => 0);
    let granted = 0;
    while (limiter.tryAcquire('poll')) {
      granted++;
      if (granted > 50) {
        throw new Error('poll budget never ran out');
      }
    }
    expect(granted).toBe(POLL_BUDGET_PER_MINUTE);
  });

  it('keeps the reserve available to commands after polling is exhausted', () => {
    const limiter = limiterAt(() => 0);
    while (limiter.tryAcquire('poll')) { /* drain the poll budget */ }

    let granted = 0;
    while (limiter.tryAcquire('command')) {
      granted++;
      if (granted > 50) {
        throw new Error('command budget never ran out');
      }
    }
    expect(granted).toBe(DEFAULT_COMMAND_RESERVE);
  });

  it('never grants more than the documented quota in one window', () => {
    const limiter = limiterAt(() => 0);
    let granted = 0;
    while (limiter.tryAcquire('poll')) {
      granted++;
    }
    while (limiter.tryAcquire('command')) {
      granted++;
    }
    expect(granted).toBe(REQUESTS_PER_MINUTE);
  });

  // The whole point of the reserve: background polling must never be able to
  // starve a tap in the Home app.
  it('grants a command even after polling has saturated the window', () => {
    const limiter = limiterAt(() => 0);
    for (let i = 0; i < 100; i++) {
      limiter.tryAcquire('poll');
    }
    expect(limiter.tryAcquire('command')).toBe(true);
  });

  it('reports remaining headroom per kind', () => {
    const limiter = limiterAt(() => 0);
    expect(limiter.remaining('poll')).toBe(POLL_BUDGET_PER_MINUTE);
    expect(limiter.remaining('command')).toBe(REQUESTS_PER_MINUTE);

    limiter.tryAcquire('poll');
    expect(limiter.remaining('poll')).toBe(POLL_BUDGET_PER_MINUTE - 1);
    expect(limiter.remaining('command')).toBe(REQUESTS_PER_MINUTE - 1);
  });
});

describe('RateLimiter discrete minute window', () => {
  // The API counts against a fixed wall-clock minute, not a sliding window, so
  // the reset must follow the clock rather than the first request.
  it('holds the window until the clock minute rolls over', () => {
    let now = 30_000;
    const limiter = limiterAt(() => now);
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) {
      limiter.tryAcquire('command');
    }

    expect(limiter.tryAcquire('command')).toBe(false);

    now = 59_999;
    expect(limiter.tryAcquire('command')).toBe(false);

    now = 60_000;
    expect(limiter.tryAcquire('command')).toBe(true);
  });

  it('measures the reset against the wall clock', () => {
    let now = 75_000; // 15s into the second minute
    const limiter = limiterAt(() => now);
    expect(limiter.msUntilNextWindow()).toBe(45_000);

    now = 119_000;
    expect(limiter.msUntilNextWindow()).toBe(1_000);
  });
});

describe('RateLimitDeferredError', () => {
  it('carries how long the caller should wait', () => {
    const error = new RateLimitDeferredError(12_000);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryAfterMs).toBe(12_000);
    expect(error.name).toBe('RateLimitDeferredError');
    expect(error.message).toContain('12s');
  });
});
