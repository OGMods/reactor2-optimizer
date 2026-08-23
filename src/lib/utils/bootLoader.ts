/**
 * The splash that covers the app until the board is on screen, and the one way
 * to take it down.
 *
 * The markup is static, in `index.html`, rather than a component — which is the
 * whole point of it. A component cannot paint until the bundle has downloaded,
 * parsed and mounted, and *that wait is most of what this covers*: on a cold
 * load the user faced a blank void through the bundle, `hydrateState()`, mount,
 * WebGL context creation and a ~1MB sprite atlas, with nothing on screen
 * saying the app was alive. Inline markup and inline CSS in the document head
 * paint on the first frame, before a single module has run.
 *
 * So the only thing the app owns is the dismissal, and it lives here rather
 * than in `PixiCanvas` so the id and the fade duration are stated once.
 */

const BOOT_LOADER_ID = "boot-loader";

/** Matches the `#boot-loader` transition in `index.html`. Keep them equal. */
const FADE_MS = 250;

let dismissed = false;

/**
 * Fades the splash out and removes it.
 *
 * Called once the first board has been built and framed — and again from the
 * failing path, so an atlas that never arrives leaves the user looking at the
 * app's own (empty) board rather than at a spinner that will never stop.
 * Idempotent, because the caller must be free to call it on both.
 */
export function dismissBootLoader(): void {
  if (dismissed || typeof document === "undefined") return;
  dismissed = true;

  const el = document.getElementById(BOOT_LOADER_ID);
  if (!el) return;

  // Removed on a timer rather than on `transitionend`: that event does not
  // fire at all when the transition is suppressed (reduced motion, a
  // background tab), which would leave the node in the tree swallowing every
  // pointer event aimed at the board underneath it.
  el.classList.add("is-done");
  setTimeout(() => el.remove(), FADE_MS);
}
