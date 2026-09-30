type Job = { domain: string; run: () => Promise<void> };

/** In-process queue with a global and a per-domain concurrency cap (spec §6.2). */
export class FetchQueue {
  private active = 0;
  private readonly perDomainActive = new Map<string, number>();
  private readonly waiting: Job[] = [];
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly opts: { global: number; perDomain: number; maxWaiting?: number }) {}

  /** Returns false (and drops the task) when the backlog is full; callers treat that URL as still pending. */
  push(domain: string, run: () => Promise<void>): boolean {
    if (this.waiting.length >= (this.opts.maxWaiting ?? 5000)) return false;
    this.waiting.push({ domain, run });
    this.pump();
    return true;
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.active < this.opts.global; ) {
      const job = this.waiting[i]!;
      if ((this.perDomainActive.get(job.domain) ?? 0) >= this.opts.perDomain) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.start(job);
    }
    if (this.active === 0 && this.waiting.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private start(job: Job): void {
    this.active++;
    this.perDomainActive.set(job.domain, (this.perDomainActive.get(job.domain) ?? 0) + 1);
    job
      .run()
      .catch(() => {})
      .finally(() => {
        this.active--;
        const n = this.perDomainActive.get(job.domain)! - 1;
        if (n === 0) this.perDomainActive.delete(job.domain);
        else this.perDomainActive.set(job.domain, n);
        this.pump();
      });
  }
}
