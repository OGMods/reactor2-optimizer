import { mount } from "svelte";
import "./app.css";
import { default as App } from "./App.svelte";
import { hydrateState } from "./lib/state";
import { preloadAtlas } from "./lib/pixi/atlas";

/*
 * The sprite atlas is ~1MB and nothing below can start it any earlier.
 *
 * Started here, it overlaps `hydrateState()`, mount and `Application.init()`
 * rather than queueing behind all three — the largest thing the app downloads
 * must not be the last request it makes, or the board cannot appear until it
 * lands. `PixiCanvas` awaits this same memoised load rather than issuing a
 * second one.
 *
 * Deliberately not awaited, and the rejection is swallowed: this call is
 * speculative — nothing is on screen yet and nothing here is waiting on the
 * sheet — so the only thing a failure means at this point is that the head
 * start did not happen. `preloadAtlas` drops its memo on failure, so
 * `PixiCanvas` starts a fresh attempt rather than inheriting this one, and it
 * is there, with a board to fill, that a failure is worth reporting. The catch
 * exists to stop an unhandled rejection while nothing is yet listening.
 */
preloadAtlas().catch(() => {});

/*
 * Decoding the saved blueprint is async, so wait for it before mounting —
 * otherwise the first frame shows the pristine template and then swaps.
 *
 * Caught rather than allowed to reject, because a rejection here means the app
 * never mounts and the boot splash in `index.html` stands over an empty page
 * for good. Hydration is a restore of saved state: failing it should land the
 * user on the pristine template with their board unread, not on a spinner that
 * never stops.
 */
try {
  await hydrateState();
} catch (err) {
  console.error("Failed to restore saved state", err);
}

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
