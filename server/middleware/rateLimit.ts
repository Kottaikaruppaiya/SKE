/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

interface LoginAttempt {
  count: number;
  lockedUntil?: number;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor() {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, attempt] of this.attempts.entries()) {
        if (attempt.lockedUntil && attempt.lockedUntil < now) {
          this.attempts.delete(key);
        }
      }
    }, 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  public getLockoutRemainingMinutes(key: string): number {
    const attempt = this.attempts.get(key);
    const now = Date.now();
    if (attempt?.lockedUntil && attempt.lockedUntil > now) {
      return Math.ceil((attempt.lockedUntil - now) / 60_000);
    }
    return 0;
  }

  public recordFailure(key: string): { locked: boolean } {
    const now = Date.now();
    const attempt = this.attempts.get(key) || { count: 0 };
    attempt.count += 1;
    if (attempt.count >= MAX_ATTEMPTS) {
      attempt.lockedUntil = now + LOCKOUT_MS;
      this.attempts.set(key, attempt);
      return { locked: true };
    }
    this.attempts.set(key, attempt);
    return { locked: false };
  }

  public reset(key: string): void {
    this.attempts.delete(key);
  }
}

export const loginRateLimiter = new LoginRateLimiter();
