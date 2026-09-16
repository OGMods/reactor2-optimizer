import {
  findBuilding,
  levelIndexForValue,
  type BuildingId,
} from "../data/buildings";
import type { PlacedBuilding, Tile, TileType } from "../solver/types";

/**
 * Binary layout codec — terrain *and* buildings in one payload.
 *
 * Wire format, before deflate + base64url:
 *
 *   byte 0        grid width
 *   byte 1        grid height
 *   byte 2..      one byte per tile, row-major
 *   [tier table]  optional, see below
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
 * This is the only layout format there is: island templates (`data/maps.ts`),
 * the app's saved layouts, share codes and the golden fixtures all use it.
 *
 * The byte tables below are a **compatibility surface**, not an implementation
 * detail. A renumbered building decodes as a *different* building rather than
 * failing, so a code a player saved last year would silently become a
 * different board. Append; never renumber. `tests/blueprint.test.ts` holds
 * every shipped building to a round-trip for exactly that reason.
 */

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

  const payload = new Uint8Array(
    2 + tiles.length + (table.length > 0 ? 1 + table.length : 0),
  );
  payload[0] = width;
  payload[1] = height;
  payload.set(tiles, 2);
  if (table.length > 0) {
    payload[2 + tiles.length] = table.length / 2;
    payload.set(table, 3 + tiles.length);
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
 * Encodes a layout. Pass `tiers` to record what each building was rated for —
 * share codes do, saved layouts do not; see the module header.
 */
export async function encodeBlueprint(
  grid: Tile[][],
  placements: readonly BlueprintPlacement[] = [],
  tiers?: BlueprintTiers,
): Promise<string> {
  if (!grid || !grid.length || !grid[0]?.length) return "";

  const compressed = await compress(buildPayload(grid, placements, tiers));
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
    return { width: 0, height: 0, grid: [], placements: [], tiers: {} };

  const compressedBytes = base64UrlToUint8Array(code);
  const data = await decompress(compressedBytes);

  const width = data[0];
  const height = data[1];

  if (!width || !height || data.length < 2 + width * height) {
    throw new Error("Blueprint payload is truncated or malformed");
  }

  const grid: Tile[][] = [];
  const placements: BlueprintPlacement[] = [];

  for (let y = 0; y < height; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x++) {
      const byteVal = data[2 + (y * width + x)];
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
  const tableAt = 2 + width * height;
  if (data.length > tableAt) {
    const entries = data[tableAt];
    for (let i = 0; i < entries; i++) {
      const at = tableAt + 1 + i * 2;
      if (at + 1 >= data.length) break;
      const buildingId = REV_BUILDING_BYTE_MAP[data[at]];
      if (buildingId !== undefined) tiers[buildingId] = data[at + 1];
    }
  }

  return { width, height, grid, placements, tiers };
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
