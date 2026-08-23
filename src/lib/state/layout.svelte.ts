import type {
  CustomIsland,
  IslandTemplate,
  PlacedBuilding,
  Tile,
  TileType,
} from "../types";
import { isObstacleType } from "../types/grid";
import {
  BLANK_ISLAND_CODE,
  ISLAND_TEMPLATES,
  MAX_CUSTOM_ISLANDS,
} from "../data/maps";
import { BUILDINGS } from "../data";
import {
  createPlacement,
  createPlacementAtLevel,
  placementTiers,
  rebaseToUnlocks,
} from "../data/placements";
import {
  blueprintKey,
  decodeBlueprint,
  encodeBlueprint,
  type DecodedBlueprint,
} from "../encoding/blueprint";
import { gridStorage, type SavedTemplateData } from "../storage/storage";
import { simulatePlacedBuildings } from "../simulation/simulator";

/**
 * A whole board, small enough to keep thirty of.
 *
 * Terrain is flattened to a list of types rather than held as `Tile` objects.
 * A `Tile` carries its own coordinates, which are recomputable, and `setTile`
 * mutates one **in place** — so a snapshot holding references would quietly
 * describe the current board rather than the one it was taken of, and Undo
 * would restore nothing.
 */
interface BoardSnapshot {
  width: number;
  height: number;
  types: TileType[];
  placements: PlacedBuilding[];
}

/**
 * How far back Undo reaches. Thirty boards of the largest island the editor
 * allows is a few tens of kilobytes of plain arrays — the cap exists so a long
 * session cannot grow without limit, not because the memory is tight.
 */
const MAX_HISTORY = 30;

/**
 * The document model: the terrain grid, its dimensions, which template it came
 * from, and the buildings the user placed by hand.
 *
 * **This file imports nothing from the rest of the state layer**, and it should
 * stay that way. It is the model: it is constructed first, and everything else
 * reads from it. That is also why the two methods needing the player's unlock
 * levels take them as a parameter instead of importing `configState` — see
 * `hydrate()` and `loadTemplate()`.
 *
 * Everything here — the shipped island templates, the user's saved edits, and
 * the share code — is a **blueprint** (`lib/encoding/blueprint.ts`). One format,
 * carrying terrain, dimensions and placements in a single payload.
 *
 * The consequence is that **loading a grid is asynchronous**, because decoding
 * needs `CompressionStream`. So the constructor does no grid work at all: it
 * only restores which template was selected. `hydrate()` builds the grid, and
 * `main.ts` awaits it before mounting, so the app never renders a blank board.
 *
 * There is one board this file holds that the user does not own: a **preview**,
 * loaded from a shared link. It is read-only and never written, and the flag
 * that says so lives here because every rule following from it — no editing, no
 * saving, no re-basing to the reader's roster — is a rule about the document.
 * See `loadPreview`, `exitPreview` and `adoptPreview`.
 */
class LayoutState {
  width = $state(10);
  height = $state(10);
  grid = $state<Tile[][]>([]);

  /** Which island template is loaded; also the key user edits are saved under. */
  activeTemplateId = $state("island1");

  /**
   * Per-template user edits as blueprint codes. An entry exists **only** while
   * that template is modified — `persist()` deletes it the moment the layout
   * matches the pristine template again, which is what makes
   * `isTemplateModified()` a plain key check.
   */
  savedGrids = $state<Record<string, SavedTemplateData>>({});

  /** Buildings the user placed by hand, scored live by the main-thread simulator. */
  placements = $state<PlacedBuilding[]>([]);

  /**
   * Islands the user created, at most `MAX_CUSTOM_ISLANDS` of them. Only the
   * identity is held here; the terrain is a `savedGrids` entry under the same
   * id, which is why a custom island needs no special case anywhere in the
   * load/save path — it is a template whose pristine board happens to be blank.
   */
  customIslands = $state<CustomIsland[]>([]);

  /**
   * Guards against out-of-order writes: encoding is async, so a burst of paints
   * can have several encodes in flight at once. Each `persist()` claims a
   * number and only the newest is allowed to reach storage.
   */
  #persistSeq = 0;

  /**
   * Identity of the currently loaded template's untouched board. `persist()`
   * compares against this to decide whether the user has modified it, which is
   * what keeps `savedGrids` (and so the "Modified" badge) honest.
   */
  #pristineKey = "";

  /**
   * The loaded template's untouched terrain, by row.
   *
   * Kept because `#pristineKey` is a one-way hash: it can say *that* the board
   * changed but not *what* used to be on a given tile. Restoring a cleared
   * obstacle needs the original type, so the pristine types are retained
   * alongside the key. `$state` because `restorableObstacles` reads it and the
   * HUD reads that.
   */
  #pristineTypes = $state<TileType[][]>([]);

  /**
   * The shared code the app was opened with, or `null` in normal use.
   *
   * Non-null is **preview mode**: the board on screen belongs to whoever sent
   * the link, and none of it is the visitor's to change. Nothing is written —
   * `persist()` and `#saveState()` both return early — so a visitor can follow
   * a link, look at the board and close the tab without their own islands
   * having moved. `previewCode` is kept rather than just a flag because
   * adopting the board means handing that exact string to `importBlueprint`.
   *
   * It is held here rather than on `uiState` because it is a property of the
   * loaded document: this board is not saved, not editable, and not the
   * player's. Every rule that follows from that reads it from the model.
   */
  #previewCode = $state<string | null>(null);

  /** True while the board on screen came from a shared link. */
  get isPreview(): boolean {
    return this.#previewCode !== null;
  }

  // ── Undo ─────────────────────────────────────────────────────────────────
  /*
   * The board is the one thing here a user can destroy by accident, and until
   * this existed the only way back from a mis-tapped building was the
   * readout's Reset — which throws away every *other* building with it. That
   * is not an undo; it is a larger mistake offered as the cure for a small one.
   *
   * It earns its place on a phone especially, which is where this app is
   * mostly used: the board is isometric, the tiles are small, and a thumb
   * covers several of them at once. A misplace there is not carelessness, it
   * is the input method.
   *
   * **Snapshots, not deltas.** A board is a few hundred tile types and a
   * handful of placements, so thirty of them cost little — and the whole class
   * of bug where an inverse operation turns out not to be the inverse (a
   * terrain write that also evicted a building, a resize that dropped three)
   * cannot arise, because nothing is inverted.
   */
  #past: BoardSnapshot[] = [];
  #future: BoardSnapshot[] = [];

  /*
   * The stacks stay plain arrays, so the buttons reading them need something
   * reactive to watch. Mirroring the two depths is cheaper than making the
   * stacks `$state`, which would deep-proxy thirty whole boards for the sake
   * of two numbers.
   */
  undoDepth = $state(0);
  redoDepth = $state(0);

  /*
   * A drag across twelve tiles is one action to the user, so it must be one
   * entry on the stack. The canvas opens a stroke on pointerdown and closes it
   * on pointerup; the first write inside it records and the rest do not.
   */
  #strokeOpen = false;
  #strokeFuture: BoardSnapshot[] = [];
  #strokeCaptured = false;

  constructor() {
    this.init();
  }

  /** Synchronous startup: restores the template *selection* only. */
  init() {
    const saved = gridStorage.loadGridState();
    if (!saved?.savedGrids) return;

    this.savedGrids = saved.savedGrids;
    this.activeTemplateId = saved.activeTemplateId || "island1";
    this.customIslands = (saved.customIslands ?? []).slice(
      0,
      MAX_CUSTOM_ISLANDS,
    );

    // Builds before custom islands were a list kept a single board under the
    // id "custom". Adopt it rather than orphaning whatever is on it.
    const hasLegacy =
      "custom" in this.savedGrids &&
      !this.customIslands.some((c) => c.id === "custom");
    if (hasLegacy && this.customIslands.length < MAX_CUSTOM_ISLANDS) {
      this.customIslands = [
        { id: "custom", name: "Custom Island" },
        ...this.customIslands,
      ];
    }
  }

  /** The user's islands as templates, all starting from the same blank board. */
  get customTemplates(): IslandTemplate[] {
    return this.customIslands.map((island) => ({
      id: island.id,
      name: island.name,
      code: BLANK_ISLAND_CODE,
    }));
  }

  get canAddCustomIsland(): boolean {
    return this.customIslands.length < MAX_CUSTOM_ISLANDS;
  }

  /**
   * Whether the loaded board's *terrain* may be edited — true only for the
   * user's own islands.
   *
   * The shipped islands are fixed maps: they are the puzzle. Repainting one
   * turns "solve this island" into "draw an easier island", and it also means
   * a share code for `island3` can describe a board no other player can
   * reach. So on a shipped template the terrain brushes and the grid-size
   * controls are unavailable, and only the two things that are genuinely the
   * player's move stay open — placing buildings, and clearing obstacles.
   *
   * Erasing an obstacle is deliberately *not* gated by this: it is a move the
   * game itself offers the player, not terrain authoring.
   * `editorState.eraseTile` already refuses to touch anything but obstacles.
   */
  get canEditTerrain(): boolean {
    if (this.isPreview) return false;
    return this.customIslands.some((c) => c.id === this.activeTemplateId);
  }

  /**
   * Obstacles the user has cleared on this board that could be put back.
   *
   * Clearing an obstacle is the one destructive move available on a shipped
   * island. Without a targeted undo it is one-way: the only way back is Reset,
   * which also throws away every building placed.
   *
   * A tile qualifies when the pristine board had an obstacle there and the
   * board now has bare grass. Anything else — a tile the user built on, water,
   * an obstacle still standing — is not a clearance that can be reversed.
   * Custom islands start from a blank board with no obstacles at all, so this
   * is naturally empty there and the HUD control never appears.
   */
  get restorableObstacles(): { x: number; y: number; type: TileType }[] {
    const out: { x: number; y: number; type: TileType }[] = [];
    for (let y = 0; y < this.#pristineTypes.length; y++) {
      const row = this.#pristineTypes[y];
      for (let x = 0; x < row.length; x++) {
        if (!isObstacleType(row[x])) continue;
        if (this.grid[y]?.[x]?.type !== "grass") continue;
        out.push({ x, y, type: row[x] });
      }
    }
    return out;
  }

  /**
   * Puts a cleared obstacle back. No-op unless that tile is genuinely a
   * reversible clearance, so a stale click cannot invent terrain.
   *
   * Any building standing there is evicted — `setTile` already does that for
   * every non-grass write, since a building can only stand on grass.
   */
  restoreObstacle(x: number, y: number): boolean {
    const original = this.#pristineTypes[y]?.[x];
    if (!original || !isObstacleType(original)) return false;
    if (this.grid[y]?.[x]?.type !== "grass") return false;

    this.setTile(x, y, original);
    return true;
  }

  /** Shipped islands first, then the user's. */
  findTemplate(id: string): IslandTemplate | undefined {
    return (
      ISLAND_TEMPLATES.find((t) => t.id === id) ??
      this.customTemplates.find((t) => t.id === id)
    );
  }

  /**
   * Adds an empty island and returns it, or `null` at the cap. Slot numbers are
   * reused after a delete, so ids stay short and predictable.
   */
  addCustomIsland(): IslandTemplate | null {
    if (!this.canAddCustomIsland) return null;

    const taken = new Set(this.customIslands.map((c) => c.id));
    let slot = 1;
    while (taken.has(`custom${slot}`)) slot++;

    const island: CustomIsland = {
      id: `custom${slot}`,
      name: `Custom Island ${slot}`,
    };
    this.customIslands = [...this.customIslands, island];
    this.#saveState();

    return { ...island, code: BLANK_ISLAND_CODE };
  }

  /**
   * Forgets a custom island and its terrain. The caller decides what to load
   * next if the deleted island was the active one — see `TemplateSelector`.
   */
  deleteCustomIsland(id: string) {
    if (!this.customIslands.some((c) => c.id === id)) return;

    this.customIslands = this.customIslands.filter((c) => c.id !== id);
    delete this.savedGrids[id];
    this.#saveState();
  }

  /**
   * Builds the grid: the pristine template first, then the user's saved
   * blueprint for it if they have one. Awaited once at startup (see
   * `state/index.ts`) so the first paint is the real board.
   */
  async hydrate(unlockedUpgrades: Record<string, number>) {
    const template =
      this.findTemplate(this.activeTemplateId) ?? ISLAND_TEMPLATES[0];

    if (template) {
      await this.#applyBaseTemplate(template);
    } else {
      this.initDefaultGrid();
    }

    await this.#applySaved(this.activeTemplateId, unlockedUpgrades);
  }

  initDefaultGrid() {
    const newGrid: Tile[][] = [];
    for (let y = 0; y < this.height; y++) {
      const row: Tile[] = [];
      for (let x = 0; x < this.width; x++) {
        row.push({ x, y, type: "grass" });
      }
      newGrid.push(row);
    }
    this.grid = newGrid;
  }

  /** Custom islands only — a shipped island's dimensions are part of the map. */
  resize(newWidth: number, newHeight: number) {
    if (!this.canEditTerrain) return;
    if (this.grid.length === 0) return;
    const curHeight = this.grid.length;
    const curWidth = this.grid[0]?.length ?? 0;
    if (curHeight === newHeight && curWidth === newWidth) return;

    // A resize can silently drop every placement outside the new bounds, which
    // is exactly the kind of write that needs a way back.
    this.#record();

    let updatedGrid = [...this.grid];

    while (updatedGrid.length < newHeight) {
      const y = updatedGrid.length;
      updatedGrid.push(
        Array.from({ length: newWidth }, (_, x) => ({
          x,
          y,
          type: "water" as TileType,
        })),
      );
    }
    if (updatedGrid.length > newHeight) {
      updatedGrid = updatedGrid.slice(0, newHeight);
    }

    updatedGrid = updatedGrid.map((row, y) => {
      if (row.length === newWidth) return row;
      if (row.length < newWidth) {
        const extended = [...row];
        for (let x = row.length; x < newWidth; x++) {
          extended.push({ x, y, type: "water" });
        }
        return extended;
      }
      return row.slice(0, newWidth);
    });

    this.grid = updatedGrid;
    this.width = newWidth;
    this.height = newHeight;

    // Placements outside the new bounds would be unreachable and unrenderable.
    const inBounds = this.placements.filter(
      (p) => p.x < newWidth && p.y < newHeight,
    );
    if (inBounds.length !== this.placements.length) {
      this.placements = inBounds;
      this.recalculate();
    }

    this.persist();
  }

  /**
   * Loads a template's pristine board and records its identity, so `persist()`
   * can tell later whether the user has actually changed anything.
   */
  async #applyBaseTemplate(template: IslandTemplate) {
    // A different board arrives here, so nothing already on the stack applies
    // to it — see `#clearHistory`.
    this.#clearHistory();
    this.activeTemplateId = template.id;
    this.placements = [];

    try {
      const decoded = await decodeBlueprint(template.code);
      this.grid = decoded.grid;
      this.width = decoded.width;
      this.height = decoded.height;
    } catch (err) {
      console.error(
        `[Layout] Template "${template.id}" failed to decode:`,
        err,
      );
      this.initDefaultGrid();
    }

    this.#pristineKey = blueprintKey(this.grid, this.placements);
    this.#pristineTypes = this.grid.map((row) => row.map((t) => t.type));
  }

  /** Overlays the user's saved blueprint for `templateId`, if one exists. */
  async #applySaved(
    templateId: string,
    unlockedUpgrades: Record<string, number>,
  ): Promise<boolean> {
    const saved = this.savedGrids[templateId];
    if (!saved) return false;

    try {
      const decoded = await decodeBlueprint(saved.code);
      if (!decoded.width || !decoded.height) return false;

      this.grid = decoded.grid;
      this.width = decoded.width;
      this.height = decoded.height;
      this.placements = decoded.placements.map((p) =>
        createPlacement(p.buildingId, p.x, p.y, unlockedUpgrades),
      );
      this.recalculate();
      return true;
    } catch (err) {
      console.error(
        `[Layout] Discarding unreadable saved layout for "${templateId}":`,
        err,
      );
      delete this.savedGrids[templateId];
      this.#saveState();
      return false;
    }
  }

  /**
   * Switches templates: pristine terrain first, then the user's saved layout
   * for it — terrain *and* placements — if they have one.
   */
  async loadTemplate(
    template: IslandTemplate,
    unlockedUpgrades: Record<string, number>,
  ) {
    await this.#applyBaseTemplate(template);
    this.#saveState();
    await this.#applySaved(template.id, unlockedUpgrades);
  }

  /** Throws away the user's edits for a template and restores the pristine one. */
  async resetTemplate(template: IslandTemplate) {
    delete this.savedGrids[template.id];

    if (this.activeTemplateId === template.id) {
      await this.#applyBaseTemplate(template);
    }

    this.#saveState();
  }

  /**
   * An entry exists only while the template differs from its pristine form —
   * `persist()` maintains that — so its presence *is* the answer.
   */
  isTemplateModified(template: IslandTemplate): boolean {
    return template.id in this.savedGrids;
  }

  /**
   * Where the board's transformer is, if it has one.
   *
   * A board carries **at most one** — every shipped map has exactly one, and
   * `editorState` keeps it that way when painting. Exposed as a plain query
   * rather than a rule, because this file deliberately applies no editing
   * rules of its own.
   */
  findTransformer(): { x: number; y: number } | null {
    for (let y = 0; y < this.grid.length; y++) {
      const row = this.grid[y];
      for (let x = 0; x < row.length; x++) {
        if (row[x].type === "transformer") return { x, y };
      }
    }
    return null;
  }

  /** The tile at these coordinates, or `undefined` if out of bounds. */
  tileAt(x: number, y: number): Tile | undefined {
    return this.grid[y]?.[x];
  }

  /**
   * Writes a tile and persists. Applies no editing rules of its own — which
   * tool may write what, and when erasing is allowed, is `editorState`'s call.
   * A write that changes nothing is skipped so it does not churn storage.
   */
  setTile(x: number, y: number, type: TileType) {
    const tile = this.tileAt(x, y);
    if (!tile || tile.type === type) return;
    // After the no-op guard, so a drag back over a tile it already painted
    // does not spend an undo entry on a write that changes nothing.
    this.#record();
    tile.type = type;

    // A building can only stand on grass, so painting anything else evicts it.
    // Its neighbours have to be re-scored: the heat it was absorbing goes back
    // to the reactors that fed it, and the cooling it was drawing frees up.
    if (type !== "grass") {
      const remaining = this.placements.filter(
        (p) => !(p.x === x && p.y === y),
      );
      if (remaining.length !== this.placements.length) {
        this.placements = remaining;
        this.recalculate();
      }
    }

    this.persist();
  }

  /**
   * The shareable code for a board: its terrain, its buildings, and the tier
   * each of those buildings is standing at.
   *
   * `placements` is a parameter because the app has two boards and the one
   * worth sharing is whichever the user is looking at — a solved layout is the
   * interesting thing to send someone. Which board that is, is `uiState`'s
   * question to answer; this file must not reach up the DAG to ask it.
   *
   * The tiers come from the placements themselves rather than from the roster,
   * so a code always describes the buildings that are actually on the board.
   * Saving to `localStorage` deliberately goes the other way and records no
   * tiers at all — see `#writeBlueprint`.
   */
  exportBlueprint(
    placements: readonly PlacedBuilding[] = this.placements,
  ): Promise<string> {
    return encodeBlueprint(this.grid, placements, placementTiers(placements));
  }

  // ── Preview: someone else's board, opened from a link ────────────────────

  /**
   * Puts a shared board on screen without touching anything the visitor owns.
   *
   * The placements are built at **the author's** tiers where the code names
   * them, which is the whole reason the wire format carries a tier table: a
   * layout re-rated at the reader's own unlocks is a different board with the
   * same shape, and the numbers under it would be figures the sender never
   * saw. A code from before the table existed names none, and those buildings
   * fall back to the visitor's levels — the best guess available, and what
   * every reader did before there was anything better.
   *
   * Nothing here is persisted and `activeTemplateId` is left alone, so the
   * island the visitor was last on is still selected underneath and
   * `exitPreview()` is a plain re-hydrate.
   */
  async loadPreview(
    code: string,
    unlockedUpgrades: Record<string, number>,
  ): Promise<boolean> {
    let decoded: DecodedBlueprint;
    try {
      decoded = await decodeBlueprint(code);
    } catch (err) {
      console.error("[Layout] Shared link carries an unreadable code:", err);
      return false;
    }
    if (!decoded.width || !decoded.height) return false;

    // Someone else's board replaces the visitor's own on screen, so the
    // visitor's own edit history no longer describes what they are looking at.
    // Undo is barred in preview anyway; this is what makes leaving clean.
    this.#clearHistory();
    this.#previewCode = code;
    this.grid = decoded.grid;
    this.width = decoded.width;
    this.height = decoded.height;
    this.placements = decoded.placements.map((p) => {
      const tier = decoded.tiers[p.buildingId];
      return tier === undefined
        ? createPlacement(p.buildingId, p.x, p.y, unlockedUpgrades)
        : createPlacementAtLevel(p.buildingId, p.x, p.y, tier);
    });
    this.recalculate();

    // A previewed board is never "modified": there is nothing to compare it
    // against and nothing that may write it. Keeping the pristine identity of
    // the board *underneath* would be worse — persist() is already barred, but
    // a stale key would outlive the preview.
    this.#pristineKey = "";
    this.#pristineTypes = [];
    return true;
  }

  /**
   * Leaves preview and brings the visitor's own board back.
   *
   * `hydrate()` is exactly the right thing to call: `activeTemplateId` was
   * never moved, so this reloads the island they were on before the link, with
   * their saved edits over it — the same path a cold start takes.
   */
  async exitPreview(unlockedUpgrades: Record<string, number>) {
    if (!this.isPreview) return;
    this.#previewCode = null;
    await this.hydrate(unlockedUpgrades);
  }

  /**
   * Takes the previewed board as one of the visitor's own islands.
   *
   * It goes in through `importBlueprint`, the same door a pasted code uses,
   * which means it lands in a new custom slot and — this is the point of the
   * decision, not an accident — is re-based to the **visitor's** unlock levels
   * on the way in. Preview is where the author's tiers are shown faithfully;
   * once the board is yours it is your roster that rates it, which is the rule
   * every other board in the app already follows.
   */
  async adoptPreview(
    unlockedUpgrades: Record<string, number>,
  ): Promise<IslandTemplate> {
    const code = this.#previewCode;
    if (code === null) throw new Error("There is no shared layout to import.");

    // Cleared first: importBlueprint writes, and writes are barred in preview.
    this.#previewCode = null;
    try {
      return await this.importBlueprint(code, unlockedUpgrades);
    } catch (err) {
      // The import was refused — at the island cap, or a board with two
      // transformers. Put the visitor back in front of what they were reading
      // rather than dropping them onto a board they did not ask for.
      this.#previewCode = code;
      throw err;
    }
  }

  /**
   * Loads a pasted share code as a **new custom island**, and returns it.
   *
   * It cannot land on the template the user is looking at: a shipped island's
   * terrain is fixed, and overwriting one custom island with an import the
   * user only meant to preview would throw away a board with no undo. A new
   * slot is the only destination that is never destructive.
   *
   * Throws with a message meant to be shown as-is.
   */
  async importBlueprint(
    code: string,
    unlockedUpgrades: Record<string, number>,
  ): Promise<IslandTemplate> {
    // `adoptPreview` clears the flag before calling this, which is what makes
    // taking a previewed board the one import that may run. Anything else
    // would claim an island slot that `#saveState` then refuses to write.
    if (this.isPreview) {
      throw new Error("Leave the shared layout before importing another.");
    }

    const trimmed = code.trim();
    if (!trimmed) throw new Error("Paste a share code first.");

    // Decode before claiming a slot, so a bad paste leaves nothing behind.
    let decoded: DecodedBlueprint;
    try {
      decoded = await decodeBlueprint(trimmed);
    } catch {
      throw new Error("That does not look like a share code.");
    }
    if (!decoded.width || !decoded.height) {
      throw new Error("That share code does not contain a map.");
    }

    // A board carries at most one transformer. The editor cannot produce a
    // board that breaks this, so a code that does was hand-edited — accepting
    // it would put a layout in front of the user that they can never
    // reproduce or repair, since the extra transformers cannot be erased.
    const transformers = decoded.grid
      .flat()
      .filter((t) => t.type === "transformer").length;
    if (transformers > 1) {
      throw new Error(
        `That map has ${transformers} transformers. A map can only have one.`,
      );
    }

    const island = this.addCustomIsland();
    if (!island) {
      throw new Error(
        `You already have ${MAX_CUSTOM_ISLANDS} custom islands. Delete one to import another.`,
      );
    }

    // A custom island's pristine board is blank, so the imported board rides
    // in as that island's saved layout — the same path a hand-edited board
    // takes, which is why importing needs no special case in load/save.
    this.savedGrids[island.id] = { code: trimmed };
    this.#saveState();
    await this.loadTemplate(island, unlockedUpgrades);

    return island;
  }

  /**
   * Queues a save. Returns immediately; the encode runs in the background and
   * only the newest queued write is allowed to land.
   */
  persist() {
    const seq = ++this.#persistSeq;
    const activeId = this.activeTemplateId;
    if (!activeId) return;
    // A previewed board is not the visitor's to save. Every editing path is
    // already closed to them, so nothing should reach here — this is the
    // backstop that keeps a link from overwriting an island they own.
    if (this.isPreview) return;

    // Compare payloads, never encoded codes: DEFLATE is only required to
    // round-trip, so two engines may emit different bytes for the same board.
    if (blueprintKey(this.grid, this.placements) === this.#pristineKey) {
      delete this.savedGrids[activeId];
      this.#saveState();
      return;
    }

    void this.#writeBlueprint(activeId, seq);
  }

  async #writeBlueprint(templateId: string, seq: number) {
    /*
     * encodeBlueprint snapshots grid + placements synchronously, so this
     * captures the state as it was when persist() was called.
     *
     * No tier table, unlike `exportBlueprint`. This board is the player's own
     * and is meant to pick up upgrades bought since it was saved — the rule
     * `#applySaved` applies on load and `rebasePlacements` applies live.
     * Recording tiers here would freeze them into the save and leave those two
     * arguing with the file.
     */
    const code = await encodeBlueprint(this.grid, this.placements);
    if (seq !== this.#persistSeq) return; // superseded by a later persist()
    if (!code) return;

    this.savedGrids[templateId] = { code };
    this.#saveState();
  }

  #saveState() {
    if (this.isPreview) return;
    gridStorage.saveGridState({
      activeTemplateId: this.activeTemplateId,
      savedGrids: this.savedGrids,
      customIslands: this.customIslands,
    });
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────

  get canUndo(): boolean {
    return this.undoDepth > 0;
  }

  get canRedo(): boolean {
    return this.redoDepth > 0;
  }

  /**
   * Opens a coalescing window: every write until `endStroke()` folds into a
   * single undo entry. Safe to open around a gesture that turns out to write
   * nothing — an empty stroke records nothing and costs nothing.
   */
  beginStroke() {
    this.#strokeOpen = true;
    this.#strokeCaptured = false;
    // Kept so `cancelStroke` can put it back: `#record` clears Redo on the
    // first write, and a stroke that never happened must not cost the user
    // the branch they had.
    this.#strokeFuture = this.#future.slice();
  }

  endStroke() {
    this.#strokeOpen = false;
  }

  /**
   * Closes the window and puts the board back as it stood when it opened,
   * leaving no undo entry behind.
   *
   * For a gesture that turns out to have been something else. The canvas
   * cannot know at `pointerdown` whether a press is a tap or the first finger
   * of a pinch — waiting to find out would put a delay on every placement —
   * so it writes immediately and takes it back if a second finger lands.
   *
   * Not the same as `undo()`, and the difference is the point: undo is a move
   * the user made and Redo can reach back through it. This is the erasure of a
   * write they never asked for, so it leaves no trace in either stack.
   *
   * `false` when the stroke wrote nothing, which is the common case.
   */
  cancelStroke(): boolean {
    const wrote = this.#strokeCaptured;
    this.#strokeOpen = false;
    this.#strokeCaptured = false;
    if (!wrote) return false;

    const before = this.#past.pop();
    if (!before) return false;

    this.#restore(before);
    this.#future = this.#strokeFuture.slice();
    this.#syncDepths();
    return true;
  }

  #snapshot(): BoardSnapshot {
    const types: TileType[] = [];
    for (const row of this.grid) {
      for (const tile of row) types.push(tile.type);
    }
    return {
      width: this.width,
      height: this.height,
      types,
      placements: this.placements.map((p) => ({ ...p })),
    };
  }

  #syncDepths() {
    this.undoDepth = this.#past.length;
    this.redoDepth = this.#future.length;
  }

  /**
   * Records the board as it stands *before* a change. Every verb that writes
   * one calls this, and nothing else does — loading a template is not an edit,
   * and `#clearHistory()` is what happens there instead.
   */
  #record() {
    // A previewed board is not the visitor's to edit, so it has nothing to
    // undo. Every write path is already closed to them; this is the backstop.
    if (this.isPreview) return;
    if (this.#strokeOpen && this.#strokeCaptured) return;

    this.#past.push(this.#snapshot());
    if (this.#past.length > MAX_HISTORY) this.#past.shift();
    // A fresh edit is a new branch, so whatever Redo was holding is now
    // unreachable — keeping it would let the arrow jump to a board that never
    // followed from the one on screen.
    this.#future.length = 0;

    if (this.#strokeOpen) this.#strokeCaptured = true;
    this.#syncDepths();
  }

  /**
   * Empties both stacks.
   *
   * **Every path that replaces the board must call this.** An undo that
   * reached across a template switch would paint one island's terrain onto
   * another, and there is no reading of the arrow under which that is what the
   * user asked for. `#applyBaseTemplate` and `loadPreview` are the two places
   * a board arrives from; everything else routes through one of them.
   */
  #clearHistory() {
    this.#past.length = 0;
    this.#future.length = 0;
    this.#strokeOpen = false;
    this.#strokeCaptured = false;
    this.#syncDepths();
  }

  #restore(snap: BoardSnapshot) {
    const grid: Tile[][] = [];
    for (let y = 0; y < snap.height; y++) {
      const row: Tile[] = [];
      for (let x = 0; x < snap.width; x++) {
        row.push({ x, y, type: snap.types[y * snap.width + x] });
      }
      grid.push(row);
    }
    this.width = snap.width;
    this.height = snap.height;
    this.grid = grid;
    this.placements = snap.placements.map((p) => ({ ...p }));

    // Re-scored rather than restored from the figures in the snapshot: a
    // board that came back through Undo is then scored by exactly the code
    // path that scores one built by hand, and the two cannot drift.
    this.recalculate();
    this.persist();
  }

  /** Steps one edit back. `false` when there was nothing to step to. */
  undo(): boolean {
    if (this.isPreview) return false;
    const previous = this.#past.pop();
    if (!previous) return false;

    this.#future.push(this.#snapshot());
    if (this.#future.length > MAX_HISTORY) this.#future.shift();
    this.#restore(previous);
    this.#syncDepths();
    return true;
  }

  /** Steps one undone edit forward again. */
  redo(): boolean {
    if (this.isPreview) return false;
    const next = this.#future.pop();
    if (!next) return false;

    this.#past.push(this.#snapshot());
    if (this.#past.length > MAX_HISTORY) this.#past.shift();
    this.#restore(next);
    this.#syncDepths();
    return true;
  }

  // ── Hand-placed buildings ────────────────────────────────────────────────

  addPlacement(building: PlacedBuilding) {
    this.#record();
    this.placements.push(building);
    this.recalculate();
    this.persist();
  }

  removePlacement(x: number, y: number) {
    const remaining = this.placements.filter((p) => !(p.x === x && p.y === y));
    if (remaining.length === this.placements.length) return;

    this.#record();
    this.placements = remaining;
    this.recalculate();
    this.persist();
  }

  /**
   * Replaces the hand-placed board with a copy of another layout — today, the
   * one the solver returned.
   *
   * A copy, not a reference: the two boards go on existing side by side, and
   * editing one must not reach into the other. Undoable like any other write,
   * which is what lets it overwrite an existing board without the caller
   * having to treat it as a one-way door.
   */
  adoptPlacements(placements: readonly PlacedBuilding[]) {
    if (this.isPreview) return;
    this.#record();
    this.placements = placements.map((p) => ({ ...p }));
    this.recalculate();
    this.persist();
  }

  /**
   * Drops every hand-placed building. Clearing the editor's held building is
   * the caller's job — see `TemplateSelector.svelte`.
   */
  clearPlacements() {
    if (this.placements.length === 0) return;
    // Undoable, and deliberately so: this is the readout's Reset, the most
    // destructive thing a player can do to their own board in one press.
    this.#record();
    this.placements = [];
    this.persist();
  }

  /**
   * Re-reads every placement's tier from the player's current unlocks, then
   * re-scores the board.
   *
   * A placement records the value it was placed at, so a tier bought afterwards
   * would leave the building on the board running at the old one — until the
   * next reload, where `#applySaved` rebuilds placements at the current level
   * and the numbers silently change. This is that same rule applied live, so a
   * board on screen and the same board reloaded never disagree.
   *
   * No `persist()`: the blueprint stores a building id and a tile, never a
   * value, so nothing about the save changes.
   */
  rebasePlacements(unlockedUpgrades: Record<string, number>) {
    if (this.placements.length === 0) return;
    // A previewed board is rated at its author's tiers, not the reader's, so
    // it is the one board the roster does not speak for.
    if (this.isPreview) return;

    const rebased = rebaseToUnlocks(this.placements, unlockedUpgrades);
    if (!rebased) return;

    this.placements = rebased;
    this.recalculate();
  }

  /**
   * Re-scores every hand-placed building. Called from each of the four places
   * that change what is on the board — a placement added or removed, one
   * evicted by a terrain write, and any dropped by a resize — because a
   * building's output depends on its neighbours, so one change re-scores a
   * whole cluster, not one tile.
   */
  recalculate() {
    if (this.placements.length === 0) return;
    this.placements = simulatePlacedBuildings(
      this.grid,
      BUILDINGS,
      this.placements,
    );
  }
}

export const layoutState = new LayoutState();
