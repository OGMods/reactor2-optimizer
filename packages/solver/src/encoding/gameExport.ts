import { base64UrlToUint8Array, pipeThrough } from "./streams";

/**
 * Reader for the code the game's **Export to Optimizer** button writes.
 *
 * This is the game's format, not ours: it was specified for the game's
 * developer (`docs/game-export.md`) and is written by the game with a
 * .NET `BinaryWriter`. That is why it differs from a blueprint in the three
 * places a blueprint would have been easier to read:
 *
 * - **Ids are strings, through a palette.** The code opens with a list of the
 *   terrain and building ids it uses and each cell is one byte indexing into
 *   it, so the game keeps no fixed byte table and we are handed the game's own
 *   ids — which `data/gameImport.ts` maps onto ours.
 * - **Raw deflate**, which is what `DeflateStream` writes; a blueprint is
 *   zlib-wrapped.
 * - **Grid coordinates are the game's.** Every island is one box cut out of the
 *   game's single world grid, in that grid's cell coordinates. Turning that
 *   into one of our boards is `gameImport.ts`'s job too; this file only reads
 *   the bytes.
 *
 * Wire format, after the `R2X<version>.` prefix and base64url + raw inflate:
 *
 *   1. header    string game version · string anomaly id · byte balance
 *   2. palette   byte n · n × string id
 *   3. islands   byte n · per island: string area id · byte flags (bit 0 =
 *                unlocked) · int16 minX · int16 minY · byte width · byte height
 *                · width × height palette indexes, row y = minY first
 *   4. research  uint16 n · n × (string id · uint16 level)
 *   5. ongoing   uint16 n · n × (string id · uint16 target level · int32 secs)
 *   6. clearing  uint16 n · n × (int16 x · int16 y · int32 secs)
 *
 * Integers are little-endian; a string is a 7-bit-encoded length followed by
 * UTF-8. A section appended after these is ignored rather than refused, so the
 * game can grow the format without a version bump; anything else is a new
 * version, and an unknown version is refused rather than guessed at.
 */

/** The only format version this build reads. */
export const GAME_EXPORT_VERSION = 1;

const PREFIX = /^R2X(\d+)\./;

/** One island as the game wrote it: a box of the world grid, cell ids resolved. */
export interface GameExportIsland {
  /** The game's area id, `area_1` … `area_8`. */
  areaId: string;
  unlocked: boolean;
  minX: number;
  minY: number;
  width: number;
  height: number;
  /**
   * The palette id on each cell, row-major from `(minX, minY)`: a terrain id
   * (`TileGrass`, `Map_Rock`, …) or a building id. Cells outside the area are
   * `TileWater`.
   */
  cells: string[];
}

export interface GameExportProgress {
  id: string;
  /** The level the research will reach — levels purchased, not an index. */
  level: number;
  secondsLeft: number;
}

export interface GameExportClearing {
  x: number;
  y: number;
  secondsLeft: number;
}

export interface GameExport {
  version: number;
  gameVersion: string;
  /** The game's anomaly id, `"none"` when the timeline has none. */
  anomalyId: string;
  anomalyBalance: number;
  /** The ids the cell bytes index into, terrain first. */
  palette: string[];
  islands: GameExportIsland[];
  /** Every research node, by the game's id, at its level (0 = not bought). */
  research: Record<string, number>;
  researchInProgress: GameExportProgress[];
  clearing: GameExportClearing[];
}

/**
 * Whether `text` is a game export rather than a share code — the prefix alone,
 * so the import dialog can route a paste before trying to decode it.
 */
export function isGameExportCode(text: string): boolean {
  return PREFIX.test(text.trim());
}

/** Sequential reader over the payload, failing loudly past the end. */
class Reader {
  #view: DataView;
  #bytes: Uint8Array;
  #at = 0;
  #text = new TextDecoder("utf-8", { fatal: true });

  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #need(n: number) {
    if (this.#at + n > this.#bytes.length) {
      throw new Error("The code ends early — was it cut off when copied?");
    }
  }

  u8(): number {
    this.#need(1);
    return this.#bytes[this.#at++];
  }

  i16(): number {
    this.#need(2);
    const v = this.#view.getInt16(this.#at, true);
    this.#at += 2;
    return v;
  }

  u16(): number {
    this.#need(2);
    const v = this.#view.getUint16(this.#at, true);
    this.#at += 2;
    return v;
  }

  i32(): number {
    this.#need(4);
    const v = this.#view.getInt32(this.#at, true);
    this.#at += 4;
    return v;
  }

  /** `BinaryWriter.Write(string)`: a 7-bit-encoded length, then UTF-8. */
  str(): string {
    let length = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 28) throw new Error("The code has a malformed string.");
      const b = this.u8();
      length |= (b & 0x7f) << shift;
      if (b < 0x80) break;
    }
    this.#need(length);
    const s = this.#text.decode(
      this.#bytes.subarray(this.#at, this.#at + length),
    );
    this.#at += length;
    return s;
  }

  bytes(n: number): Uint8Array {
    this.#need(n);
    const out = this.#bytes.subarray(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
}

/**
 * Reads a game export. Throws with a message meant to be shown as-is.
 *
 * Anything outside the base64url alphabet is dropped from the body before
 * decoding: a code pasted out of a chat app arrives wrapped in line breaks and
 * spaces, and the samples the game produced picked up a stray character at the
 * end. A body damaged in the middle still fails, at the inflate.
 */
export async function decodeGameExport(text: string): Promise<GameExport> {
  const trimmed = text.trim();
  const match = PREFIX.exec(trimmed);
  if (!match) throw new Error("That is not a code from the game.");

  const version = Number(match[1]);
  if (version !== GAME_EXPORT_VERSION) {
    throw new Error(
      `That code is format ${version}; this version of the optimizer reads format ${GAME_EXPORT_VERSION}. Reload the page to update.`,
    );
  }

  const body = trimmed.slice(match[0].length).replace(/[^A-Za-z0-9_-]/g, "");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await pipeThrough(
      base64UrlToUint8Array(body),
      new DecompressionStream("deflate-raw"),
    );
  } catch {
    throw new Error(
      "That code could not be read — it may have been cut off when copied.",
    );
  }

  const r = new Reader(bytes);

  const gameVersion = r.str();
  const anomalyId = r.str();
  const anomalyBalance = r.u8();

  const palette: string[] = [];
  for (let n = r.u8(); n > 0; n--) palette.push(r.str());

  const islands: GameExportIsland[] = [];
  for (let n = r.u8(); n > 0; n--) {
    const areaId = r.str();
    const unlocked = (r.u8() & 1) === 1;
    const minX = r.i16();
    const minY = r.i16();
    const width = r.u8();
    const height = r.u8();
    const cells = Array.from(r.bytes(width * height), (i) => {
      const id = palette[i];
      if (id === undefined) {
        throw new Error("The code points at a tile type it never listed.");
      }
      return id;
    });
    islands.push({ areaId, unlocked, minX, minY, width, height, cells });
  }

  const research: Record<string, number> = {};
  for (let n = r.u16(); n > 0; n--) {
    const id = r.str();
    research[id] = r.u16();
  }

  const researchInProgress: GameExportProgress[] = [];
  for (let n = r.u16(); n > 0; n--) {
    researchInProgress.push({
      id: r.str(),
      level: r.u16(),
      secondsLeft: r.i32(),
    });
  }

  const clearing: GameExportClearing[] = [];
  for (let n = r.u16(); n > 0; n--) {
    clearing.push({ x: r.i16(), y: r.i16(), secondsLeft: r.i32() });
  }

  return {
    version,
    gameVersion,
    anomalyId,
    anomalyBalance,
    palette,
    islands,
    research,
    researchInProgress,
    clearing,
  };
}
