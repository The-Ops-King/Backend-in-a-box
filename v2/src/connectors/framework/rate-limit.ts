/**
 * A request budget per key (a GHL location): at most `max` requests in any `windowMs` (GHL: 100 per 10 seconds per app
 * per location). A request over budget waits for room rather than failing: requests are queued, in order. The vendor's
 * own count wins when it says less is left (`X-RateLimit-Remaining`): at 0 nothing more goes until its window
 * (`X-RateLimit-Interval-Milliseconds`) has passed.
 */
export class RateLimiter {
  private sent = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();

  constructor(private o: { max: number; windowMs: number; now: () => Date; sleep: (ms: number) => Promise<void> }) {}

  /** Waits until a request for `key` may go, then counts it. Requests for one key are let through one at a time, in order. */
  async take(key: string): Promise<void> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.queues.set(key, prior.then(() => mine));
    await prior;
    try {
      for (;;) {
        const now = this.o.now().getTime();
        const blocked = this.blockedUntil.get(key) ?? 0;
        if (blocked > now) { await this.o.sleep(blocked - now); continue; }
        const recent = (this.sent.get(key) ?? []).filter((t) => t > now - this.o.windowMs);
        if (recent.length >= this.o.max) { await this.o.sleep(recent[0]! + this.o.windowMs - now); continue; }
        recent.push(now);
        this.sent.set(key, recent);
        return;
      }
    } finally {
      release();
    }
  }

  /** What the vendor said is left. */
  observe(key: string, headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    if (headers.get("x-ratelimit-remaining") === null || !Number.isFinite(remaining)) return;
    const interval = Number(headers.get("x-ratelimit-interval-milliseconds")) || this.o.windowMs;
    if (remaining <= 0) this.blockedUntil.set(key, this.o.now().getTime() + interval);
  }

  /** Requests counted in the current window (for tests and the health view). */
  inWindow(key: string): number {
    const now = this.o.now().getTime();
    return (this.sent.get(key) ?? []).filter((t) => t > now - this.o.windowMs).length;
  }
}
