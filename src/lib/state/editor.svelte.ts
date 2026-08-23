import type { TileType } from "../types";
import { layoutState } from "./layout.svelte";

/**
 * What the user is currently holding, and what happens when they use it.
 *
 * Transient editor mode, kept out of the document model. Nothing here is
 * persisted: a reload starts with an empty hand.
 *
 * **The editing verbs live here, not on `layoutState`.** The brush knows about
 * the document, never the other way round: these call `layoutState.setTile()`,
 * and `layoutState` imports nothing from the rest of the state layer.
 */
class EditorState {
  /** Terrain brush. `null` means painting is off and drags pan the view. */
  activeTool = $state<TileType | null>(null);

  /** Building the user picked from the HUD palette, ready to place. */
  selectedBuildingId = $state<string | null>(null);

  /**
   * Tap-to-erase: removes a placed building, or reverts an obstacle to grass.
   *
   * On a mouse this is the right-click gesture, which touch has no equivalent
   * for — so on a phone a placed building could be added and never removed.
   * This gives the same action a mode in the HUD.
   */
  eraseMode = $state(false);

  /**
   * Restore mode: the board ghosts in every obstacle the user has cleared,
   * and tapping one puts it back. See `layoutState.restorableObstacles`.
   *
   * It is a mode rather than a per-tile affordance because the ghosts would
   * otherwise clutter a board the user is trying to read — they are only
   * useful while the user is deliberately undoing clearances.
   */
  restoreMode = $state(false);

  /** Selecting the already-selected building clears it, so the HUD toggles. */
  selectBuilding(id: string | null) {
    this.eraseMode = false;
    this.restoreMode = false;
    this.selectedBuildingId = this.selectedBuildingId === id ? null : id;
  }

  /** Picking a terrain brush leaves the other modes; all of these are exclusive. */
  selectTool(tool: TileType | null) {
    this.eraseMode = false;
    this.restoreMode = false;
    this.activeTool = this.activeTool === tool ? null : tool;
  }

  /**
   * Drops whatever the user is holding. Called when the board changes under
   * them — switching to a shipped island while holding a terrain brush would
   * otherwise leave a tool selected that silently does nothing.
   */
  clearHand() {
    this.activeTool = null;
    this.selectedBuildingId = null;
    this.eraseMode = false;
    this.restoreMode = false;
  }

  toggleErase() {
    this.eraseMode = !this.eraseMode;
    if (this.eraseMode) {
      this.activeTool = null;
      this.selectedBuildingId = null;
      this.restoreMode = false;
    }
  }

  toggleRestore() {
    this.restoreMode = !this.restoreMode;
    if (this.restoreMode) {
      this.activeTool = null;
      this.selectedBuildingId = null;
      this.eraseMode = false;
    }
  }

  /**
   * Applies the active brush to a tile. No-op when nothing is held, and on a
   * shipped island, whose terrain is fixed — see `layoutState.canEditTerrain`.
   * The HUD hides the terrain brushes there too; this is the backstop, so a
   * stale `activeTool` left over from a custom island cannot paint one.
   *
   * Reports whether it wrote, which is what the canvas confirms by touch: a
   * brush dragged across a board it may not edit must not buzz once per tile.
   */
  paintTile(x: number, y: number): boolean {
    if (!this.activeTool) return false;
    if (!layoutState.canEditTerrain) return false;

    /*
     * A board carries at most one transformer, so painting a second one
     * **moves** the existing one rather than being refused.
     *
     * Moving is the only sane reading of the two transformer rules together:
     * it cannot be erased, so refusing the second placement would make a
     * misplaced transformer permanent, with no way back short of deleting the
     * whole island. Relocating honours "only one" without creating that trap.
     */
    if (this.activeTool === "transformer") {
      const existing = layoutState.findTransformer();
      if (existing && (existing.x !== x || existing.y !== y)) {
        layoutState.setTile(existing.x, existing.y, "grass");
      }
    }

    layoutState.setTile(x, y, this.activeTool);
    return true;
  }

  /**
   * Clears an obstacle back to buildable grass. Water and grass are left
   * alone — erasing is for removing rocks and trees, not for digging.
   *
   * Deliberately allowed on shipped islands: clearing an obstacle is a move
   * the game offers (the solver even suggests which ones pay off), not
   * terrain authoring. Because it only ever writes grass over an obstacle, it
   * cannot be used to reshape a map.
   *
   * Reports whether it wrote, for the reason on `paintTile`.
   */
  eraseTile(x: number, y: number): boolean {
    /*
     * Not on a previewed board. Clearing an obstacle is allowed on a shipped
     * island because it is the player's own move on their own board — a board
     * arriving from someone else's link is neither, and every write is barred
     * on it. `paintTile` is already covered by `canEditTerrain`, which reads
     * the same flag.
     */
    if (layoutState.isPreview) return false;
    const current = layoutState.tileAt(x, y);
    if (!current) return false;
    if (current.type === "water" || current.type === "grass") return false;
    // The transformer is permanent — it is the board's power hookup, not
    // scenery. On a custom island it can still be *moved*, by painting a new
    // one; see `paintTile`.
    if (current.type === "transformer") return false;
    layoutState.setTile(x, y, "grass");
    return true;
  }
}

export const editorState = new EditorState();
