/**
 * A fixed pool of `node:worker_threads`, fed a task list and drained as tasks
 * land. Covers both axes the CLI spends cores on: islands within one solve,
 * attempts within one session.
 */

import { Worker } from "node:worker_threads";

/**
 * The file a worker actually loads.
 *
 * Running from source, that is a bootstrap that installs the TypeScript loader
 * inside the worker first — a worker thread has its own module loader and does
 * not inherit the main thread's. Running from the built package it is the
 * worker itself, which is already JavaScript.
 */
function workerEntry(url: URL): URL {
  return url.pathname.endsWith(".ts")
    ? new URL("./workerBootstrap.mjs", url)
    : url;
}

export interface PoolTask<M> {
  payload: unknown;
  meta: M;
}

export class WorkerPool {
  #workers: Worker[] = [];
  #stopped = false;

  readonly #workerUrl: URL;
  readonly size: number;

  constructor(workerUrl: URL, size: number) {
    this.#workerUrl = workerUrl;
    this.size = size;
  }

  /**
   * Runs every task, calling `onResult` as each lands — in completion order,
   * not task order. Resolves when the list is drained or `stop()` is called.
   */
  async run<M>(
    tasks: PoolTask<M>[],
    onResult: (meta: M, result: unknown) => void,
  ): Promise<void> {
    if (!tasks.length) return;

    const count = Math.max(1, Math.min(this.size, tasks.length));
    let next = 0;
    let outstanding = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };

      const feed = (worker: Worker) => {
        if (this.#stopped || next >= tasks.length) {
          if (outstanding === 0) finish();
          return;
        }
        const task = tasks[next++];
        outstanding++;
        worker.postMessage({ meta: task.meta, payload: task.payload });
      };

      for (let i = 0; i < count; i++) {
        const worker = new Worker(workerEntry(this.#workerUrl));
        this.#workers.push(worker);

        worker.on(
          "message",
          (msg: { meta: M; result?: unknown; error?: string }) => {
            outstanding--;
            if (msg.error) {
              finish(new Error(msg.error));
              return;
            }
            if (!this.#stopped) {
              try {
                onResult(msg.meta, msg.result);
              } catch (err) {
                finish(err as Error);
                return;
              }
            }
            feed(worker);
          },
        );

        worker.on("error", (err) => finish(err as Error));
        worker.on("exit", () => {
          // A terminated worker owes nothing; a crashed one already reported.
          if (this.#stopped && outstanding === 0) finish();
        });

        feed(worker);
      }
    });
  }

  /** Stops feeding and drops whatever is in flight. */
  stop(): void {
    this.#stopped = true;
  }

  async terminate(): Promise<void> {
    this.#stopped = true;
    await Promise.all(this.#workers.map((w) => w.terminate()));
    this.#workers = [];
  }
}
