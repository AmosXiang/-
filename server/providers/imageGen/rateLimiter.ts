export type ImageResolutionTier = '1k' | '2k' | '3k_4k';

const RPM_BY_TIER: Record<ImageResolutionTier, number> = { '1k': 20, '2k': 10, '3k_4k': 1 };

export function imageResolutionTier(width: number, height: number): ImageResolutionTier {
  const longest = Math.max(width, height);
  if (longest <= 1024) return '1k';
  if (longest <= 2048) return '2k';
  return '3k_4k';
}

type Waiter = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

class TierBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly waiters: Waiter[] = [];
  private wakeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly rpm: number) {
    this.tokens = rpm;
  }

  acquire(timeoutMs: number): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Image rate limiter queue timed out after ${timeoutMs}ms.`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
      this.schedule();
    });
  }

  queued(): number { return this.waiters.length; }

  private refill() {
    const now = Date.now();
    const tokensToAdd = Math.floor((now - this.lastRefill) / (60_000 / this.rpm));
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.rpm, this.tokens + tokensToAdd);
      this.lastRefill += tokensToAdd * (60_000 / this.rpm);
    }
    while (this.tokens >= 1 && this.waiters.length) {
      this.tokens -= 1;
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private schedule() {
    if (this.wakeTimer || !this.waiters.length) return;
    const waitMs = Math.max(1, Math.ceil(60_000 / this.rpm - (Date.now() - this.lastRefill)));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.refill();
      this.schedule();
    }, waitMs);
  }
}

export class AgnesImageRateLimiter {
  private readonly buckets: Record<ImageResolutionTier, TierBucket> = {
    '1k': new TierBucket(RPM_BY_TIER['1k']),
    '2k': new TierBucket(RPM_BY_TIER['2k']),
    '3k_4k': new TierBucket(RPM_BY_TIER['3k_4k']),
  };

  async acquire(width: number, height: number, timeoutMs = 120_000): Promise<{ tier: ImageResolutionTier; queuedAhead: number }> {
    const tier = imageResolutionTier(width, height);
    const queuedAhead = this.buckets[tier].queued();
    await this.buckets[tier].acquire(timeoutMs);
    return { tier, queuedAhead };
  }
}

export const agnesImageRateLimiter = new AgnesImageRateLimiter();
