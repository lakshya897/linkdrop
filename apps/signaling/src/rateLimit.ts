import { LinkDropError } from '@linkdrop/shared';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export class InMemoryRateLimiter {
  private records = new Map<string, RateLimitRecord>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly errorCode: string = 'RATE_LIMITED'
  ) {}

  check(key: string) {
    const now = Date.now();
    const record = this.records.get(key);

    if (!record) {
      this.records.set(key, { count: 1, resetTime: now + this.windowMs });
      return;
    }

    if (now > record.resetTime) {
      // Window expired, reset
      record.count = 1;
      record.resetTime = now + this.windowMs;
      return;
    }

    if (record.count >= this.limit) {
      throw new LinkDropError(this.errorCode, 'Too many attempts. Please try again later.', 429);
    }

    record.count++;
  }

  reset(key: string) {
    this.records.delete(key);
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (now > record.resetTime) {
        this.records.delete(key);
      }
    }
  }
}
