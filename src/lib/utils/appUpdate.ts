import { asset } from "./assetUrl";

/**
 * Whether the site has been deployed again since this page loaded.
 *
 * Every file a build ships is content-hashed and a Pages deploy replaces the
 * whole site, so a page loaded before a deploy keeps pointing at files that no
 * longer exist. Nothing breaks until it next asks for one — and the one it asks
 * for late is the solver's worker, so the symptom is a Run that never starts.
 *
 * The build bakes its id into the bundle and writes the same id to
 * `version.json` beside it (`vite.config.ts`); a different id on the server
 * means this page is out of date. Fetched past every cache, since a cached
 * answer is exactly the stale one.
 *
 * False in development, and false whenever the question cannot be answered —
 * offline, or a server with no `version.json` — since "reload" is only worth
 * saying when it is known to help.
 */
async function isAppOutdated(): Promise<boolean> {
  const built = import.meta.env.VITE_APP_BUILD as string | undefined;
  if (import.meta.env.DEV || !built) return false;
  try {
    const res = await fetch(asset("version.json"), { cache: "no-store" });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: unknown };
    return typeof build === "string" && build !== built;
  } catch {
    return false;
  }
}

/** How often coming back to the tab may ask again. */
const RECHECK_MS = 5 * 60_000;

/**
 * Calls `onOutdated` once a newer deploy is found: at start, and whenever the
 * tab comes back into view at most every few minutes — a phone tab restored
 * after a week is the page most likely to be stale, and the one least likely
 * to have been reloaded.
 */
export function watchForAppUpdate(onOutdated: () => void): void {
  let lastCheck = -Infinity;
  let found = false;
  const check = async () => {
    if (found || performance.now() - lastCheck < RECHECK_MS) return;
    lastCheck = performance.now();
    if (await isAppOutdated()) {
      found = true;
      onOutdated();
    }
  };
  void check();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}
