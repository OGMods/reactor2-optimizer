import {
  findBuilding,
  levelIndexForValue,
  type BuildingId,
} from "../data/buildings";
import type {
  AnomalyId,
  PlacedBuilding,
  PrestigeUpgradeId,
  Tile,
  TileType,
} from "../solver/types";

/**
 * Binary layout codec — terrain *and* buildings in one payload.
 *
 * Wire format, before deflate + base64url:
 *
 *   byte 0        format version
 *   byte 1        grid width
 *   byte 2        grid height
 *   byte 3..      one byte per tile, row-major
 *   [tier table]  optional, see below
 *   [rules]       optional, see below
 *
 * **The version byte, and how a code without one is recognised.** Codes written
 * before it existed begin with the width, so the two are told apart by value
 * rather than by a flag: a board is at least `MIN_GRID_DIM` (5) tiles on a
 * side, so a first byte *below* that cannot be a width and is a version.
 * Versions therefore have five usable values before the trick runs out, which
 * is ample for a format whose last two changes were both appended optional
 * sections — and if it ever is not, version 4 can spend a byte on a longer
 * header.
 *
 * This is why `MIN_GRID_DIM` lives in this package rather than in the size
 * stepper that enforces it: it stopped being a UI limit the moment the wire
 * format began reading codes by it.
 *
 * Each tile byte is either a terrain id (0-6) or a building id (10+). A
 * building byte implies the tile beneath it is grass, which is the only terrain
 * a building can stand on — that is what lets one byte carry both layers.
 *
 * Width and height are one byte each, so this tops out at a 255x255 grid; the
 * app caps dimensions at 30.
 *
 * **The tier table.** A tile byte says *which* building stands there but not
 * what it is rated for, and the same layout at tier 1 and at tier 8 is two
 * very different boards. So a code may carry one more section after the tiles:
 *
 *   byte 2+w*h    n — how many entries follow
 *   then n pairs  [building byte][upgrade index]
 *
 * One entry **per building id, not per tile**: every placement of a given
 * building on a board is at the same tier, because a placement's tier is read
 * from the player's unlock level and `rebasePlacements` re-reads all of them
 * together. So a board using six kinds of building spends 13 bytes here, not
 * one pair per tile.
 *
 * The section is optional in both directions, which is what makes it a
 * backward- and forward-compatible addition: a code written before it existed
 * simply ends after the tiles, and a reader that predates it stops there too
 * (the length check was always `>=`, never `===`). A code with no table means
 * "tiers unknown", and the caller resolves them from the player's own unlocks
 * — which is exactly what every reader did before the table existed.
 *
 * It is written for **share codes only**. A saved layout in `localStorage`
 * deliberately carries no tiers: that board is the player's own and is meant
 * to pick up upgrades bought since it was saved, which is the rule
 * `#applySaved` and `rebasePlacements` both apply. Freezing tiers into the
 * save would put those two in permanent disagreement.
 *
 * **The rules section.** Tiers say what the buildings were, and that is no
 * longer the whole story: the timeline's anomaly and its Time Lab research
 * change what those same tiers are worth, so a board shared out of a
 * ×5-cooling timeline is not the board a reader without that research would
 * get. One more optional section carries them:
 *
 *   byte a        anomaly id byte
 *   byte a+1      m — how many research entries follow
 *   then m pairs  [research byte][level index]
 *
 * It follows the tier table and is read only after it, so **a code carrying
 * rules must carry a tier count byte first**, even a zero one. That costs a
 * byte and buys a strictly sequential parse; writing a zero count is not a
 * contradiction, since an empty table already means "tiers unknown" rather
 * than "tiers are zero".
 *
 * Optional in both directions on the same terms as the tier table: an older
 * code stops earlier, an older reader stops earlier, and **no rules section
 * means "rules unknown"** — never "no anomaly and no research", which is a
 * thing a code can also say explicitly and is not the same claim. Share codes
 * carry it; saved layouts do not, for the reason above — a save should pick up
 * the research bought since, not argue with it.
 *
 * This is the only layout format there is: island templates (`data/maps.ts`),
 * the app's saved layouts, share codes and the golden fixtures all use it.
 *
 * The byte tables below are a **compatibility surface**, not an implementation
 * detail. A renumbered building decodes as a *different* building rather than
 * failing, so a code a player saved last year would silently become a
 * different board. Append; never renumber. `tests/blueprint.test.ts` holds
 * every shipped building to a round-trip for exactly that reason.
 */

/**
 * The current format version, written as byte 0 of every new code.
 *
 * Bump it only for a change a reader cannot absorb by stopping early — the
 * optional-section rule below covers appending, which is why this is still 1
 * after two sections were added. A code naming a version this build does not
 * know is refused rather than guessed at: the tiles are positional, so reading
 * a later payload as this one would not fail, it would quietly produce a
 * different board.
 */
export const BLUEPRINT_VERSION = 1;

/**
 * The smallest a board may be on either side, as the size stepper enforces it.
 *
 * It is a **wire constant** now rather than a UI one, because it is what makes
 * a version byte distinguishable from the width byte an older code starts with.
 * The claim it rests on is historical and settled: every code written before
 * versioning came from a board at least this wide — the shipped islands are 13
 * across at the narrowest, a blank custom island is 10, and the stepper has
 * always clamped here.
 *
 * Note it constrains **old codes only**. A versioned code says its width in
 * byte 1, where no value is ambiguous, so the fixtures' 4x4 test boards encode
 * and decode perfectly well. Lowering this would not shrink any board; it would
 * only make some old codes unreadable.
 */
export const MIN_GRID_DIM = 5;

/**
 * Anomaly and research ids, as bytes.
 *
 * The same **compatibility surface** as the building map below: renumber one
 * and a code shared last month decodes as a different anomaly rather than
 * failing. Append; never renumber. Both start their real entries at 1, leaving
 * 0 free — for anomalies it is the genuine "no anomaly" choice, and for
 * research it is a value no writer emits, so a stray zero decodes as nothing
 * rather than as the first upgrade.
 *
 * Both are keyed on their **closed id union** rather than on `string`, so an
 * anomaly or a research added to `ANOMALIES` / `PRESTIGE_UPGRADES` without a
 * byte here fails to compile. Those two tables are hand-owned — a new anomaly is
 * brought across by hand — and the failure a missing byte produces is silent in
 * both directions: an anomaly would be written as 0 and a research dropped
 * altogether, so the recipient rates the board under rules its author never ran
 * and a figure is printed for it either way. A compile error is the only check
 * that arrives before the code is shared.
 */
const ANOMALY_BYTE_MAP: Record<AnomalyId, number> = {
  none: 0,
  cryo_nexus: 1,
  tidal_ascendancy: 2,
  singularity_isolation: 3,
};

const RESEARCH_BYTE_MAP: Record<PrestigeUpgradeId, number> = {
  absolute_zero: 1,
  infinite_grid: 2,
  stellar_forge: 3,
};

const REV_ANOMALY_BYTE_MAP: Record<number, string> = Object.fromEntries(
  Object.entries(ANOMALY_BYTE_MAP).map(([id, byte]) => [byte, id]),
);

const REV_RESEARCH_BYTE_MAP: Record<number, string> = Object.fromEntries(
  Object.entries(RESEARCH_BYTE_MAP).map(([id, byte]) => [byte, id]),
);

/** Terrain ids. Buildings start at 10 so the two ranges never collide. */
const TILE_BYTE_MAP: Record<TileType, number> = {
  water: 0,
  grass: 1,
  rock: 2,
  tree1: 3,
  tree2: 4,
  pond: 5,
  transformer: 6,
};

const BUILDING_BYTE_MAP: Record<BuildingId, number> = {
  // Coolers (10-16)
  cooler1: 10,
  cooler2: 11,
  cooler3: 12,
  cooler4: 13,
  cooler5: 14,
  cooler6: 15,
  cooler7: 16,

  // Generators (20-26)
  generator: 20,
  generator2: 21,
  generator3: 22,
  generator4: 23,
  generator5: 24,
  generator6: 25,
  generator7: 26,

  // Heat Producers (30-53)
  wind_turbine: 30,
  solar_panel: 31,
  coal_plant: 32,
  hydro_plant: 33,
  gas_plant: 34,
  heliothermal_plant: 35,
  geothermal_plant: 36,
  biomass_plant: 37,
  nuclear_reactor: 38,
  fusion_reactor: 39,
  arc_reactor: 40,
  antimatter_plant: 41,
  quantum_reactor: 42,
  gravitron_plant: 43,
  black_hole_reactor: 44,
  hyper_space_core: 45,
  zero_point_reactor: 46,
  divine_reactor: 47,
  chaos_core: 48,
  psionic_tower: 49,
  sauron_eye: 50,
  neuro_grid_reactor: 51,
  flux_reactor: 52,
  doomStar_reactor: 53,
};

const REV_TILE_BYTE_MAP: Record<number, TileType> = Object.fromEntries(
  Object.entries(TILE_BYTE_MAP).map(([type, byte]) => [byte, type as TileType]),
);

const REV_BUILDING_BYTE_MAP: Record<number, BuildingId> = Object.fromEntries(
  Object.entries(BUILDING_BYTE_MAP).map(([id, byte]) => [
    byte,
    id as BuildingId,
  ]),
);

/**
 * The part of a placement the wire format carries. Everything else on
 * `PlacedBuilding` (power, heat, cooling) is derived by the simulator from the
 * grid and the player's unlock levels, so encoding it would only let it go
 * stale.
 */
export type BlueprintPlacement = Pick<PlacedBuilding, "x" | "y" | "buildingId">;

/**
 * The tier table: building id -> the upgrade index its placements were at.
 *
 * One entry per building id rather than per tile — see the module header for
 * why that is lossless. An id absent from the table is not "tier 0"; it is
 * "this code does not say", and the caller falls back to the reader's own
 * unlock level. That is the only reading under which a code written before the
 * table existed still means what it meant.
 */
export type BlueprintTiers = Record<string, number>;

/**
 * The rules a board was built under: which anomaly was running and what Time
 * Lab research the author had.
 *
 * `research` is keyed and indexed exactly like the player's own record — the
 * level **index**, and a key's presence is what "researched" means, so an id
 * that is absent was not researched at all.
 */
export interface BlueprintRules {
  anomalyId: string;
  research: Record<string, number>;
}

// --- Browser Compression & Base64URL Helpers ---

/**
 * Runs `bytes` through a transform stream and collects the result.
 *
 * Note the shape: the payload is piped in from a Blob and the whole stream is
 * handed to `Response`, so reading and writing are driven together. Grabbing a
 * writer and awaiting `write()`/`close()` before starting to read — the
 * obvious-looking version — deadlocks: `close()` cannot settle until the
 * readable side is drained, and nothing is draining it yet.
 */
async function pipeThrough(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function compress(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return pipeThrough(bytes, new CompressionStream("deflate"));
}

function decompress(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return pipeThrough(bytes, new DecompressionStream("deflate"));
}

function uint8ArrayToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToUint8Array(code: string): Uint8Array<ArrayBuffer> {
  let base64 = code.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ==========================================
// UNIFIED ENCODE & DECODE
// ==========================================

/**
 * Encodes grid terrain and building placements into a URL-safe string.
 *
 * The byte payload is built synchronously, so callers get a snapshot of `grid`
 * and `placements` as they were at call time even though the result is awaited.
 *
 * The tier table is written only for the building bytes that actually reached
 * the board — a placement whose id the catalogue does not carry never gets a
 * tile byte, so a tier for it would describe nothing. Passing no `tiers` at all
 * reproduces the pre-table payload byte for byte, which is what lets
 * `blueprintKey` keep its meaning.
 */
function buildPayload(
  grid: Tile[][],
  placements: readonly BlueprintPlacement[],
  tiers?: BlueprintTiers,
  rules?: BlueprintRules,
): Uint8Array<ArrayBuffer> {
  const height = grid.length;
  const width = grid[0].length;
  const tiles = new Uint8Array(width * height);

  const placedAt = new Map<string, string>();
  for (const p of placements) {
    placedAt.set(`${p.x},${p.y}`, p.buildingId);
  }

  // Building bytes as they land on the board, in byte order so the table is
  // deterministic — two encodes of the same board must produce one payload.
  const placedBytes = new Set<number>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const buildingId = placedAt.get(`${x},${y}`);
      const buildingByte =
        buildingId === undefined
          ? undefined
          : BUILDING_BYTE_MAP[buildingId as BuildingId];

      if (buildingByte !== undefined) placedBytes.add(buildingByte);
      tiles[y * width + x] =
        buildingByte ?? TILE_BYTE_MAP[grid[y][x].type] ?? TILE_BYTE_MAP.water;
    }
  }

  const table: number[] = [];
  if (tiers) {
    for (const byte of [...placedBytes].sort((a, b) => a - b)) {
      const level = tiers[REV_BUILDING_BYTE_MAP[byte]];
      if (level === undefined) continue;
      table.push(byte, Math.max(0, Math.min(255, Math.round(level))));
    }
  }

  /*
   * The rules section, in the order the reader walks it. Research entries go
   * out in byte order for the same reason the tier table does: two encodes of
   * one board must produce one payload, and object key order is not something
   * to rely on for that.
   */
  const ruleBytes: number[] = [];
  if (rules) {
    const research: number[] = [];
    for (const [id, byte] of Object.entries(RESEARCH_BYTE_MAP).sort(
      (a, b) => a[1] - b[1],
    )) {
      const level = rules.research[id];
      if (level === undefined) continue;
      research.push(byte, Math.max(0, Math.min(255, Math.round(level))));
    }
    /*
     * The fallback can no longer be a shipped anomaly missing a byte — the map
     * is keyed on `AnomalyId`, so that would not have compiled. What is left is
     * a `rules.anomalyId` that is not an anomaly id at all, which is reachable
     * because the field is a plain string: it arrives from `localStorage` and
     * across the worker boundary. Writing 0 for one says "no anomaly", which is
     * the same total reading `getAnomaly` makes of an id it does not know.
     */
    ruleBytes.push(
      ANOMALY_BYTE_MAP[rules.anomalyId as AnomalyId] ?? ANOMALY_BYTE_MAP.none,
      research.length / 2,
      ...research,
    );
  }

  // A rules section is read only after a tier count byte, so writing one means
  // writing that byte even when there are no tiers to declare. Zero there says
  // "tiers unknown", which is true and is what it has always meant.
  const writeTable = table.length > 0 || ruleBytes.length > 0;

  const payload = new Uint8Array(
    3 + tiles.length + (writeTable ? 1 + table.length : 0) + ruleBytes.length,
  );
  payload[0] = BLUEPRINT_VERSION;
  payload[1] = width;
  payload[2] = height;
  payload.set(tiles, 3);
  if (writeTable) {
    payload[3 + tiles.length] = table.length / 2;
    payload.set(table, 4 + tiles.length);
    if (ruleBytes.length > 0)
      payload.set(ruleBytes, 4 + tiles.length + table.length);
  }

  return payload;
}

/**
 * A synchronous identity for a layout — the uncompressed payload as a string.
 *
 * Use this, never the encoded code, to test whether two layouts are the same.
 * DEFLATE output is only guaranteed to *round-trip*; nothing requires two
 * implementations to emit identical bytes for identical input, so comparing
 * codes across browsers can report a difference that is not there. The payload
 * this is built from is fully determined by the grid and its placements.
 *
 * Tiers are deliberately **not** part of it. This answers "is this the same
 * layout?", and the callers that ask — `persist()` against the pristine
 * template, the solver's board signature — mean the arrangement, not what the
 * roster currently rates it at. The roster is already tracked separately where
 * it matters, and folding it in here would make an upgrade purchase read as a
 * repainted board.
 */
export function blueprintKey(
  grid: Tile[][],
  placements: readonly BlueprintPlacement[] = [],
): string {
  if (!grid?.length || !grid[0]?.length) return "";
  const payload = buildPayload(grid, placements);
  let key = "";
  for (let i = 0; i < payload.length; i++)
    key += String.fromCharCode(payload[i]);
  return key;
}

/**
 * Encodes a layout. Pass `tiers` to record what each building was rated for and
 * `rules` to record the anomaly and research it was built under — share codes
 * pass both, saved layouts pass neither; see the module header.
 *
 * The argument order is the payload order, which is also the order they may be
 * dropped in: a code can carry tiers without rules, but not rules without a
 * tier count byte ahead of them. Passing `rules` alone is legal and writes that
 * byte as zero, meaning "tiers unknown".
 */
export async function encodeBlueprint(
  grid: Tile[][],
  placements: readonly BlueprintPlacement[] = [],
  tiers?: BlueprintTiers,
  rules?: BlueprintRules,
): Promise<string> {
  if (!grid || !grid.length || !grid[0]?.length) return "";

  const compressed = await compress(
    buildPayload(grid, placements, tiers, rules),
  );
  return uint8ArrayToBase64Url(compressed);
}

export interface DecodedBlueprint {
  width: number;
  height: number;
  grid: Tile[][];
  placements: BlueprintPlacement[];
  /**
   * What the author's buildings were rated for, where the code says so. Empty
   * for a code carrying no tier table, which every code written before the
   * table existed is — so an empty object means "resolve them yourself", not
   * "everything is at tier 0".
   */
  tiers: BlueprintTiers;
  /**
   * The anomaly and research the board was built under, or **null** where the
   * code does not say — which every code written before this section existed
   * is, and every saved layout still is.
   *
   * Null rather than a zeroed record, because "the author had no anomaly and no
   * research" is a different claim a code can also make explicitly, and a
   * reader that confused the two would rate someone else's board at nothing.
   */
  rules: BlueprintRules | null;
}

/**
 * Decodes a blueprint code back into a grid and its placements.
 *
 * Throws if `code` is not a valid blueprint — callers that accept untrusted
 * input (pasted share codes, `localStorage` written by an older build) should
 * catch rather than assume.
 */
export async function decodeBlueprint(code: string): Promise<DecodedBlueprint> {
  if (!code)
    return {
      width: 0,
      height: 0,
      grid: [],
      placements: [],
      tiers: {},
      rules: null,
    };

  const compressedBytes = base64UrlToUint8Array(code);
  const data = await decompress(compressedBytes);

  /*
   * Versioned or not, told apart by value — see the module header. A first byte
   * below `MIN_GRID_DIM` is too small to be a width, so it is a version; at or
   * above it, this is a code from before the byte existed and that value is the
   * width.
   */
  const versioned = data[0] < MIN_GRID_DIM;
  if (versioned && data[0] !== BLUEPRINT_VERSION) {
    throw new Error(
      `Blueprint is format version ${data[0]}; this build reads ${BLUEPRINT_VERSION}`,
    );
  }

  const head = versioned ? 3 : 2;
  const width = data[head - 2];
  const height = data[head - 1];

  if (!width || !height || data.length < head + width * height) {
    throw new Error("Blueprint payload is truncated or malformed");
  }

  const grid: Tile[][] = [];
  const placements: BlueprintPlacement[] = [];

  for (let y = 0; y < height; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x++) {
      const byteVal = data[head + (y * width + x)];
      const buildingId = REV_BUILDING_BYTE_MAP[byteVal];

      if (buildingId !== undefined) {
        // A building byte implies grass underneath.
        row.push({ x, y, type: "grass" });
        placements.push({ x, y, buildingId });
      } else {
        row.push({ x, y, type: REV_TILE_BYTE_MAP[byteVal] ?? "water" });
      }
    }
    grid.push(row);
  }

  /*
   * The tier table, if this code carries one. Everything here is optional and
   * everything is bounds-checked: a code from an older build simply ends at
   * the tiles, and one truncated mid-table gives up the rest of the table
   * rather than the whole layout — the tiles are the part that cannot be
   * reconstructed, and they have already been read.
   */
  const tiers: BlueprintTiers = {};
  const tableAt = head + width * height;
  let entries = 0;
  if (data.length > tableAt) {
    entries = data[tableAt];
    for (let i = 0; i < entries; i++) {
      const at = tableAt + 1 + i * 2;
      if (at + 1 >= data.length) break;
      const buildingId = REV_BUILDING_BYTE_MAP[data[at]];
      if (buildingId !== undefined) tiers[buildingId] = data[at + 1];
    }
  }

  /*
   * The rules section, which begins past the tier table the count byte
   * *declared* — not past the entries that fitted. A truncated table therefore
   * takes the rules with it rather than letting the walk resume at an offset
   * that means nothing, which is the same "give up the rest, keep the tiles"
   * rule the table itself follows.
   */
  let rules: BlueprintRules | null = null;
  const rulesAt = tableAt + 1 + entries * 2;
  if (data.length > tableAt && data.length > rulesAt) {
    const research: Record<string, number> = {};
    const count = rulesAt + 1 < data.length ? data[rulesAt + 1] : 0;
    for (let i = 0; i < count; i++) {
      const at = rulesAt + 2 + i * 2;
      if (at + 1 >= data.length) break;
      const id = REV_RESEARCH_BYTE_MAP[data[at]];
      if (id !== undefined) research[id] = data[at + 1];
    }
    rules = {
      // An anomaly byte this build has never heard of reads as none, the same
      // fallback `getAnomaly` makes for an unrecognised id.
      anomalyId: REV_ANOMALY_BYTE_MAP[data[rulesAt]] ?? "none",
      research,
    };
  }

  return { width, height, grid, placements, tiers, rules };
}

/**
 * The tier table for a board: every building id on it, mapped to the upgrade
 * index its placements are standing at — the `tiers` argument
 * `encodeBlueprint` takes.
 *
 * It lives here beside the format it feeds rather than with the app's other
 * placement helpers, because both writers of a share code need it: the app's
 * Share button and the CLI, which has no app to borrow it from.
 *
 * Read from each placement's own `baseValue` rather than from the roster, so
 * the table describes the buildings that are actually there. The two are the
 * same number right up until an upgrade is bought behind a standing building,
 * and at that moment the board is the one telling the truth — which is the same
 * reason the readout and the scorer both go through `effectiveAtValue`.
 *
 * One entry per id: every placement of a building shares a tier, because
 * `rebasePlacements` re-reads them all together. Where a board somehow carries
 * two, the first wins, which is the same arbitrary-but-stable answer the wire
 * format could hold anyway.
 */
export function placementTiers(
  placements: readonly PlacedBuilding[],
): BlueprintTiers {
  const tiers: Record<string, number> = {};
  for (const p of placements) {
    if (p.buildingId in tiers) continue;
    const def = findBuilding(p.buildingId);
    if (!def) continue;
    tiers[p.buildingId] = levelIndexForValue(def, p.baseValue);
  }
  return tiers;
}

/**
 * The rules record for a share code: the anomaly running and the research the
 * player has.
 *
 * Beside `placementTiers` above and for the same reason — the app's Share button
 * and the CLI both write share codes, and neither should be spelling this out
 * itself. Research is copied rather than filtered: an id this build does not
 * carry a byte for is simply dropped at encode time, which is where the format's
 * own compatibility rule lives.
 *
 * An **empty** `research` is a statement, not an omission: it says the author
 * had none, which is what the CLI (which has no research input) truthfully
 * knows. Omitting the whole section instead would say "rules unknown" and leave
 * a reader rating the board under its own timeline.
 */
export function blueprintRules(
  anomalyId: string,
  research: Record<string, number>,
): BlueprintRules {
  return { anomalyId, research: { ...research } };
}
