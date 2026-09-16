/**
 * Worker entry when the CLI is run from TypeScript source.
 *
 * A worker thread gets its own module loader and does not inherit the one
 * `tsx` installs in the main thread, so `new Worker(new URL("./worker.ts"))`
 * fails with ERR_UNKNOWN_FILE_EXTENSION. Registering the same loader here, in
 * the worker, is the whole fix — three lines rather than a build step between
 * every edit and every run.
 *
 * The published package needs none of this: `dist/` is plain JavaScript, and
 * `pool.ts` points straight at the worker when the URL is already `.js`.
 */

import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
