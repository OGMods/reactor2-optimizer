import type { PlacedBuilding, SearchHooks } from "./types";

export interface IslandProgress {
  placements: PlacedBuilding[];
  powerOutput: number;
}

/** Returns control to the worker's event loop so queued messages (STOP) can run. */
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  // A MessageChannel task is not subject to setTimeout's 4ms nesting clamp, so
  // yielding stays sub-millisecond even when it happens often.
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Keeps a long synchronous search cooperative.
 *
 * The retired Python reference ran each island to its deadline in one uninterrupted
 * block; in a Web Worker the same loop has to come up for air so a STOP
 * message can be delivered and progress can be reported. `due()` is a cheap
 * clock comparison the search can call in its existing time checks, and
 * `pump()` does the actual yielding — so the search runs flat out between
 * yields instead of paying an event-loop round trip every few hundred steps.
 */
export class Pacer {
  private readonly hooks: SearchHooks | undefined;
  private readonly yieldIntervalMs: number;
  private readonly reportIntervalMs: number;
  private lastYieldMs: number;
  private lastReportMs: number;
  private stopped = false;

  constructor(hooks?: SearchHooks, yieldIntervalMs = 50) {
    this.hooks = hooks;
    this.yieldIntervalMs = yieldIntervalMs;
    this.reportIntervalMs = hooks?.reportIntervalMs ?? 1000;
    const now = performance.now();
    this.lastYieldMs = now;
    this.lastReportMs = now;
  }

  /** True once the host has asked the solve to wind down. */
  get stopRequested(): boolean {
    return this.stopped;
  }

  due(nowMs: number): boolean {
    return nowMs - this.lastYieldMs >= this.yieldIntervalMs;
  }

  /**
   * Yields to the event loop, and reports `progress()` if the reporting
   * interval has elapsed. `progress` is only invoked when a report is actually
   * due, so computing it may be as expensive as a stabilization pass.
   */
  async pump(nowMs: number, progress?: () => IslandProgress): Promise<void> {
    this.lastYieldMs = nowMs;

    if (
      progress &&
      this.hooks?.onProgress &&
      nowMs - this.lastReportMs >= this.reportIntervalMs
    ) {
      this.lastReportMs = nowMs;
      const snapshot = progress();
      this.hooks.onProgress(snapshot.placements, snapshot.powerOutput);
    }

    await yieldToEventLoop();

    if (!this.stopped && this.hooks?.shouldStop?.()) this.stopped = true;
  }

  /**
   * Reports that the cleanup past the deadline has finished `done` of `total`
   * layouts, and yields. Unconditionally rather than when `due()`: a layout's
   * cleanup can take most of a second, and both the report and a STOP should
   * land between layouts rather than whenever the interval happens to say so.
   */
  async finalizing(done: number, total: number): Promise<void> {
    this.hooksFinalizing(done, total);
    await this.pump(performance.now());
  }

  /**
   * The same report without the yield — for the last one, after which the
   * solve returns at once and there is nothing left for a STOP to cut.
   */
  hooksFinalizing(done: number, total: number): void {
    this.hooks?.onFinalizing?.(done, total);
  }
}
