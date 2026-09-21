/**
 * Six runes singletons, split by what the state *is* rather than which
 * component happens to read it:
 *
 *   editor   — the paintbrush: active tool, selected building
 *   layout   — the document: grid, dimensions, template, hand placements
 *   config   — the roster: which components are unlocked, and to what level
 *   solver   — the optimizer run: status, streaming result, stop handle
 *   viewport — the device: width class and pointer type, from matchMedia
 *   ui       — the interface: what's open, what's being inspected
 *
 * They reference each other directly rather than through events; this app is
 * small enough that singletons plus direct calls are the whole "store" layer.
 * The one rule worth keeping: `layout` must not reach into `ui`. It is the
 * model, it gets constructed first, and recentering the canvas on template
 * load is the call site's job.
 */

import { clearSharedCode, readSharedCode } from "../encoding/shareLink";
import { configState } from "./config.svelte";
import { layoutState } from "./layout.svelte";
import { solverState } from "./solver.svelte";

/**
 * Applies the user's saved blueprint before the app mounts.
 *
 * `layoutState`'s constructor is synchronous and only gets as far as the
 * pristine template — decoding a blueprint needs `CompressionStream`, which is
 * async. Awaiting this in `main.ts` means the first paint is the real layout
 * instead of a template that visibly swaps a frame later.
 *
 * It lives here rather than on either singleton because it spans both: the
 * placements being restored need `configState`'s unlock levels to resolve their
 * base values and its Time Lab research to be rated under, and `layoutState`
 * deliberately does not import `configState`.
 *
 * The last solve is re-hung afterwards, in that order because deciding whether
 * it is still valid means reading the board it was solved against.
 *
 * **A shared link overrides all of it.** Arriving with a `?bp=` code means the
 * user came to look at someone else's board, so that board is what gets built
 * and none of their own state is disturbed — no solve is re-hung, because a
 * stored solve answers a question about a different island. The visitor's own
 * layout is still restored first, so `exitPreview()` has somewhere to return
 * to; a code that turns out to be unreadable simply leaves them there, which is
 * the same place a mistyped link should land them.
 */
export async function hydrateState(): Promise<void> {
  // Before the board exists, so the first score every placement gets is already
  // under the player's research rather than a frame of unresearched figures.
  layoutState.setPrestige(configState.prestige);
  await layoutState.hydrate(configState.buildingUpgrades);

  const shared = readSharedCode();
  if (
    shared &&
    (await layoutState.loadPreview(shared, configState.buildingUpgrades))
  ) {
    return;
  }
  if (shared) clearSharedCode();

  solverState.restore();
}

export { editorState } from "./editor.svelte";
export { viewportState } from "./viewport.svelte";
export { layoutState } from "./layout.svelte";
export { configState } from "./config.svelte";
export { solverState } from "./solver.svelte";
export { uiState } from "./ui.svelte";
