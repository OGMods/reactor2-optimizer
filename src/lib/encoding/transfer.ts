/**
 * The transfer code: everything this browser holds, in one string another
 * browser can load — the roster, Time Lab, anomaly and upgrade plan, every
 * island's board, each island's picked solve, the last game import and the
 * Chronon target. It is how a player solves on a PC and carries the result to
 * the phone the game runs on, or the other way.
 *
 * Unlike a share code it is not a layout and does not open in preview: loading
 * one **replaces** what the receiving browser had, which is the point of it.
 *
 *     R2T1.<base41(raw deflate(payload))>
 *
 * Built to fit a QR code, which is the easy way onto a phone. What gets it
 * there, largest first:
 *
 * - **The text is base41**, not base64: digits, capitals and `$+-/:`, every one
 *   of them in the QR code's alphanumeric mode, which stores a character in
 *   5.5 bits where its byte mode needs 8 for base64's 6. Three characters
 *   carry two bytes, so one QR code holds about 30% more. The digits go out
 *   least significant first, which makes the last character of the code a
 *   digit, capital, `$`, `+` or `-` — never the `/` or `:` a chat app trims
 *   off the end of a link.
 * - **Binary, like a blueprint.** A building, a Time Lab research or a shipped
 *   island is one byte: its index in the package's own tables. A roster with
 *   most buildings unlocked goes as one byte for each, in table order, with no
 *   ids at all. Both browsers
 *   must agree on those tables, so the payload opens with a fingerprint of
 *   them and a code from a build with other tables is refused, not misread.
 *   The game's own ids (research, anomalies) are indices too, into lists kept
 *   here; one the game adds later goes as its name until the list has it.
 * - **Boards travel as their blueprint's raw payload**, the bytes before its
 *   own deflate. A code is already compressed, so eight of them deflate to
 *   nothing less; raw, they share terrain with each other, and one deflate
 *   over all of it is about half the size. An identical board goes once — the
 *   game import's copy of an island is often the board the player has.
 * - **A solve is only the picked layout, as a board** — the island's terrain
 *   with the solve's buildings, one byte a tile. Beside the island's own board
 *   it deflates to the tiles that differ; as a list of positions it cost three
 *   times as much. The receiving app re-scores it at its own tiers, as it does
 *   a stored solve after any roster change.
 * - **The game import's research map drops level-0 entries**, which everything
 *   reading it takes as 0, and the building nodes (`research_*`): a building's
 *   unlock travels as the roster, and nothing reads the record's copy.
 */
import {
  BUILDINGS,
  ISLAND_TEMPLATES,
  PRESTIGE_UPGRADES,
  type UpgradeStep,
} from "@reactor2/solver";
import type { CustomIsland } from "../types/building";
import type { SavedGameImport } from "../storage/storage";

const PREFIX = "R2T1.";
const FORMAT = 1;

/** One island's picked solve, as the sending browser had it stored. */
export interface TransferSolve {
  /**
   * The solve as a blueprint: the island's board with the solve's buildings
   * on it. A grid rather than a list of positions, because it compresses to
   * almost nothing beside the board the code already carries — only the tiles
   * with buildings differ.
   */
  code: string;
  /** The anomaly the layout was searched under. */
  anomalyId: string;
  /** The upgrade plan it was searched under, as `configState.planKey`. */
  planKey: string;
  durationMs: number;
  finishedAt: number;
}

export interface TransferBundle {
  buildingUpgrades: Record<string, number>;
  prestigeLevels: Record<string, number>;
  anomalyId: string;
  upgradePlan: UpgradeStep[];
  activeTemplateId: string;
  customIslands: CustomIsland[];
  /** Template or custom island id -> blueprint code; absent = untouched map. */
  boards: Record<string, string>;
  solves: Record<string, TransferSolve>;
  gameImport: SavedGameImport | null;
  chrononTarget: number | null;
}

export function isTransferCode(text: string): boolean {
  return text.trim().startsWith(PREFIX);
}

// --- The tables both ends index into -----------------------------------------

const BUILDING_IDS = BUILDINGS.map((b) => b.id);
const PRESTIGE_IDS = PRESTIGE_UPGRADES.map((u) => u.id);
const TEMPLATE_IDS = ISLAND_TEMPLATES.map((t) => t.id);

/**
 * The game's own ids, as its export spells them — trailing spaces included,
 * which two of its research ids carry. Its economy research, its Time Lab and
 * the Chrono Seed; the building nodes (`research_*`) never travel. Read off
 * every export in `packages/solver/tests/gameExports`.
 *
 * **Append; never reorder.** An id the game adds later is not an error: it is
 * written as its name behind `UNLISTED` until it is added here.
 */
const GAME_RESEARCH_IDS = [
  "BuildCreditAmountResearchSO",
  "BuildingPriceReductionResearchSO",
  "BuildingSellRefundResearchSO",
  "BuildingsCostMultiplierResearchSO",
  "CashCapResearchSO",
  "CityDemandPriceResearchSO",
  "CityResearchSO",
  "CitySurplusPriceResearchSO",
  "ContractMainRewardResearchSO",
  "ContractSlotsResearchSO",
  "ContractTimeReductionResearchSO",
  "DepositsInterestResearchSO",
  "DepositsSlotsResearchSO ",
  "DepositsTimeReductionResearchSO",
  "FreeSpeedupResearchSO",
  "IslandPriceReductionResearchSO ",
  "ObstacleRemovalTimeResearchSO",
  "OfflineEarningsResearchSO",
  "QuickCashMultiplierResearchSO",
  "QuickRpMultiplierResearchSO",
  "ResearchBuildingTimeReductionResearchSO",
  "ResearchEconomyTimeReductionResearchSO",
  "ResearchPointsCapResearchSO",
  "ResearchPointsIncomeResearchSO",
  "ResearchResearchPointsCostReductionResearchSO",
  "VideoAdSpeedupTimeResearchSO",
  "absolute_zero",
  "archives_beyond_time",
  "chrono_accelerator",
  "chronon_reactor",
  "erased_from_time",
  "infinite_grid",
  "phase_breaker",
  "quantum_exchange",
  "quantum_replicator",
  "stellar_forge",
  "zero_time_protocol",
  "TimeLabSkipCityResearchSO",
];

/** The game's anomaly ids, and ours, which are the same strings. Append-only. */
const GAME_ANOMALY_IDS = [
  "none",
  "cryo_nexus",
  "tidal_ascendancy",
  "singularity_isolation",
  "tidal_ascendancy_legacy",
];

/** A listed id's byte when the name follows instead. */
const UNLISTED = 0xff;

/** FNV-1a over every table's ids, in order: equal only for equal tables. */
const TABLES_FINGERPRINT = (() => {
  let h = 0x811c9dc5;
  for (const ch of [
    BUILDING_IDS,
    PRESTIGE_IDS,
    TEMPLATE_IDS,
    GAME_RESEARCH_IDS,
    GAME_ANOMALY_IDS,
  ]
    .map((t) => t.join(","))
    .join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
})();

/** The roster's count byte when every building follows, in table order. */
const ROSTER_DENSE = 0xff;
/** A building's byte in the dense roster when it is not unlocked. */
const LOCKED = 0xff;

/** An island: its template's index, or a custom island's id after 0xff. */
const CUSTOM_ISLAND = 0xff;

const STAMP_SOURCES = ["server", "device"] as const;

// --- Encode -----------------------------------------------------------------

class Writer {
  #bytes: number[] = [];
  u8(v: number) {
    this.#bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number) {
    this.u16(v);
    this.u16(v >>> 16);
  }
  i16(v: number) {
    this.u16(v & 0xffff);
  }
  i32(v: number) {
    this.u32(v >>> 0);
  }
  f64(v: number) {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    for (const x of b) this.u8(x);
  }
  /** A number, or null, behind a presence byte. */
  f64OrNull(v: number | null) {
    this.u8(v === null ? 0 : 1);
    if (v !== null) this.f64(v);
  }
  /** LEB128 length, then UTF-8 — `BinaryWriter`'s string, as the game's. */
  str(s: string) {
    const b = new TextEncoder().encode(s);
    let n = b.length;
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.u8(n);
    for (const x of b) this.u8(x);
  }
  bytes(b: Uint8Array) {
    this.u16(b.length);
    for (const x of b) this.u8(x);
  }
  /** An id's index in `table`, or `UNLISTED` and the id itself. */
  known(table: readonly string[], id: string) {
    const i = table.indexOf(id);
    if (i >= 0 && i < UNLISTED) this.u8(i);
    else {
      this.u8(UNLISTED);
      this.str(id);
    }
  }
  island(id: string) {
    const i = TEMPLATE_IDS.indexOf(id);
    if (i >= 0) this.u8(i);
    else {
      this.u8(CUSTOM_ISLAND);
      this.str(id);
    }
  }
  /** A table index, or throws: an id outside the table cannot travel. */
  index(table: readonly string[], id: string) {
    const i = table.indexOf(id);
    if (i < 0) throw new Error(`"${id}" is not in this build's tables.`);
    this.u8(i);
  }
  done(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#bytes);
  }
}

export async function encodeTransfer(bundle: TransferBundle): Promise<string> {
  // Boards first, as a table the rest points into, so a board the game
  // import shares with the player's own goes once.
  const blobs: Uint8Array[] = [];
  const seen = new Map<string, number>();
  const blob = (bytes: Uint8Array): number => {
    let key = "";
    for (const b of bytes) key += String.fromCharCode(b);
    let i = seen.get(key);
    if (i === undefined) {
      i = blobs.push(bytes) - 1;
      seen.set(key, i);
    }
    return i;
  };
  const gi = bundle.gameImport;
  const boardRefs = async (codes: Readonly<Record<string, string>>) => {
    const out: [string, number][] = [];
    for (const [id, code] of Object.entries(codes))
      out.push([id, blob(await rawOf(code))]);
    return out;
  };
  const boards = await boardRefs(bundle.boards);
  const gameBoards = gi ? await boardRefs(gi.islands) : [];
  const solves = Object.entries(bundle.solves);
  const solveRefs = await boardRefs(
    Object.fromEntries(solves.map(([id, s]) => [id, s.code])),
  );

  const w = new Writer();
  w.u8(FORMAT);
  w.u32(TABLES_FINGERPRINT);

  w.u8(blobs.length);
  for (const b of blobs) w.bytes(b);

  // The roster in whichever form is shorter: every building in table order,
  // a byte each (locked is 0xff), once more than half are unlocked; below
  // that, a pair of bytes for each unlocked one.
  const roster = Object.entries(bundle.buildingUpgrades);
  if (roster.length * 2 > BUILDING_IDS.length) {
    w.u8(ROSTER_DENSE);
    for (const id of BUILDING_IDS) w.u8(bundle.buildingUpgrades[id] ?? LOCKED);
  } else {
    w.u8(roster.length);
    for (const [id, tier] of roster) {
      w.index(BUILDING_IDS, id);
      w.u8(tier);
    }
  }
  const prestige = Object.entries(bundle.prestigeLevels);
  w.u8(prestige.length);
  for (const [id, level] of prestige) {
    w.index(PRESTIGE_IDS, id);
    w.u8(level);
  }
  w.known(GAME_ANOMALY_IDS, bundle.anomalyId);
  w.u8(bundle.upgradePlan.length);
  for (const step of bundle.upgradePlan) {
    w.index(BUILDING_IDS, step.buildingId);
    w.u8(step.level);
  }

  w.island(bundle.activeTemplateId);
  w.u8(bundle.customIslands.length);
  for (const c of bundle.customIslands) {
    w.str(c.id);
    w.str(c.name);
  }
  w.u8(boards.length);
  for (const [id, ref] of boards) {
    w.island(id);
    w.u8(ref);
  }

  w.u8(solves.length);
  for (const [i, [id, s]] of solves.entries()) {
    w.island(id);
    w.u8(solveRefs[i][1]);
    w.known(GAME_ANOMALY_IDS, s.anomalyId);
    w.str(s.planKey);
    w.u32(Math.round(s.durationMs));
    w.f64(s.finishedAt);
  }

  w.f64OrNull(bundle.chrononTarget);

  w.u8(gi ? 1 : 0);
  if (gi) {
    w.f64(gi.importedAt);
    w.str(gi.gameVersion);
    w.known(GAME_ANOMALY_IDS, gi.anomalyId);
    w.u8(gi.anomalyBalance);
    const research = Object.entries(gi.research).filter(
      ([id, level]) => level !== 0 && !id.startsWith("research_"),
    );
    w.u8(research.length);
    for (const [id, level] of research) {
      w.known(GAME_RESEARCH_IDS, id);
      w.u16(level);
    }
    w.u8(gi.researchInProgress.length);
    for (const p of gi.researchInProgress) {
      w.known(GAME_RESEARCH_IDS, p.id);
      w.u16(p.level);
      w.i32(p.secondsLeft);
    }
    w.u16(gi.clearing.length);
    for (const c of gi.clearing) {
      w.i16(c.x);
      w.i16(c.y);
      w.i32(c.secondsLeft);
    }
    w.u8(gameBoards.length);
    for (const [id, ref] of gameBoards) {
      w.island(id);
      w.u8(ref);
    }
    w.u8(gi.lockedTemplateIds.length);
    for (const id of gi.lockedTemplateIds) w.island(id);
    w.f64(gi.energyPerTick);
    const t = gi.timeline;
    w.u8(t ? 1 : 0);
    if (t) {
      w.f64(t.exportedAt);
      w.f64(t.chronons);
      w.f64(t.energy);
      w.f64(t.elapsedSeconds);
      w.f64(t.jumpAward);
      w.u8(t.anomaliesEntered.length);
      for (const a of t.anomaliesEntered) w.known(GAME_ANOMALY_IDS, a);
      w.i32(t.generation);
      w.f64OrNull(t.cash);
      w.f64OrNull(t.researchPoints);
      w.u8(
        t.stampSource === null ? 0xff : STAMP_SOURCES.indexOf(t.stampSource),
      );
    }
  }

  const packed = await pipe(w.done(), new CompressionStream("deflate-raw"));
  return PREFIX + toBase41(packed);
}

// --- Decode -----------------------------------------------------------------

class Reader {
  #at = 0;
  #view: DataView;
  #buf: Uint8Array<ArrayBuffer>;
  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.#buf = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }
  #take(n: number): number {
    const at = this.#at;
    if (at + n > this.#buf.length) throw new RangeError("Ran out of bytes");
    this.#at += n;
    return at;
  }
  u8() {
    return this.#view.getUint8(this.#take(1));
  }
  u16() {
    return this.#view.getUint16(this.#take(2), true);
  }
  u32() {
    return this.#view.getUint32(this.#take(4), true);
  }
  i16() {
    return this.#view.getInt16(this.#take(2), true);
  }
  i32() {
    return this.#view.getInt32(this.#take(4), true);
  }
  f64() {
    return this.#view.getFloat64(this.#take(8), true);
  }
  f64OrNull() {
    return this.u8() ? this.f64() : null;
  }
  str() {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = this.u8();
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    const at = this.#take(n);
    return new TextDecoder().decode(this.#buf.subarray(at, at + n));
  }
  bytes() {
    const n = this.u16();
    const at = this.#take(n);
    return this.#buf.slice(at, at + n);
  }
  known(table: readonly string[]) {
    const i = this.u8();
    return i === UNLISTED ? this.str() : at(table, i);
  }
  island() {
    const i = this.u8();
    return i === CUSTOM_ISLAND ? this.str() : at(TEMPLATE_IDS, i);
  }
  index(table: readonly string[]) {
    return at(table, this.u8());
  }
}

function at(table: readonly string[], i: number): string {
  const id = table[i];
  if (id === undefined) throw new RangeError(`No entry ${i}`);
  return id;
}

/**
 * Reads a transfer code. Throws with a message fit for the player on anything
 * that is not one this build can load.
 */
export async function decodeTransfer(text: string): Promise<TransferBundle> {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error("Not a transfer code.");
  let r: Reader;
  try {
    r = new Reader(
      await pipe(
        fromBase41(trimmed.slice(PREFIX.length)),
        new DecompressionStream("deflate-raw"),
      ),
    );
  } catch {
    throw new Error("That transfer code is incomplete. Copy it again.");
  }
  try {
    if (r.u8() !== FORMAT) throw new Error("format");
    if (r.u32() !== TABLES_FINGERPRINT) throw new Error("format");
  } catch {
    throw new Error(
      "That code is from another version of the optimizer. Reload the page " +
        "on both devices and transfer again.",
    );
  }

  try {
    const blobs: Uint8Array<ArrayBuffer>[] = [];
    for (let n = r.u8(); n > 0; n--) blobs.push(r.bytes());
    const codes = new Map<number, Promise<string>>();
    const codeAt = (ref: number) => {
      if (!blobs[ref]) throw new RangeError(`No board ${ref}`);
      let c = codes.get(ref);
      if (!c) codes.set(ref, (c = codeOf(blobs[ref])));
      return c;
    };

    const buildingUpgrades: Record<string, number> = {};
    const rosterCount = r.u8();
    if (rosterCount === ROSTER_DENSE) {
      for (const id of BUILDING_IDS) {
        const tier = r.u8();
        if (tier !== LOCKED) buildingUpgrades[id] = tier;
      }
    } else {
      for (let n = rosterCount; n > 0; n--)
        buildingUpgrades[r.index(BUILDING_IDS)] = r.u8();
    }
    const prestigeLevels: Record<string, number> = {};
    for (let n = r.u8(); n > 0; n--)
      prestigeLevels[r.index(PRESTIGE_IDS)] = r.u8();
    const anomalyId = r.known(GAME_ANOMALY_IDS);
    const upgradePlan: UpgradeStep[] = [];
    for (let n = r.u8(); n > 0; n--)
      upgradePlan.push({ buildingId: r.index(BUILDING_IDS), level: r.u8() });

    const activeTemplateId = r.island();
    const customIslands: CustomIsland[] = [];
    for (let n = r.u8(); n > 0; n--)
      customIslands.push({ id: r.str(), name: r.str() });
    const boards: Record<string, string> = {};
    for (let n = r.u8(); n > 0; n--) {
      const id = r.island();
      boards[id] = await codeAt(r.u8());
    }

    const solves: Record<string, TransferSolve> = {};
    for (let n = r.u8(); n > 0; n--) {
      const id = r.island();
      solves[id] = {
        code: await codeAt(r.u8()),
        anomalyId: r.known(GAME_ANOMALY_IDS),
        planKey: r.str(),
        durationMs: r.u32(),
        finishedAt: r.f64(),
      };
    }

    const chrononTarget = r.f64OrNull();

    let gameImport: SavedGameImport | null = null;
    if (r.u8()) {
      const importedAt = r.f64();
      const gameVersion = r.str();
      const gameAnomaly = r.known(GAME_ANOMALY_IDS);
      const anomalyBalance = r.u8();
      const research: Record<string, number> = {};
      for (let n = r.u8(); n > 0; n--)
        research[r.known(GAME_RESEARCH_IDS)] = r.u16();
      const researchInProgress: SavedGameImport["researchInProgress"] = [];
      for (let n = r.u8(); n > 0; n--)
        researchInProgress.push({
          id: r.known(GAME_RESEARCH_IDS),
          level: r.u16(),
          secondsLeft: r.i32(),
        });
      const clearing: SavedGameImport["clearing"] = [];
      for (let n = r.u16(); n > 0; n--)
        clearing.push({ x: r.i16(), y: r.i16(), secondsLeft: r.i32() });
      const islands: Record<string, string> = {};
      for (let n = r.u8(); n > 0; n--) {
        const id = r.island();
        islands[id] = await codeAt(r.u8());
      }
      const lockedTemplateIds: string[] = [];
      for (let n = r.u8(); n > 0; n--) lockedTemplateIds.push(r.island());
      const energyPerTick = r.f64();
      let timeline: SavedGameImport["timeline"] = null;
      if (r.u8()) {
        const exportedAt = r.f64();
        const chronons = r.f64();
        const energy = r.f64();
        const elapsedSeconds = r.f64();
        const jumpAward = r.f64();
        const anomaliesEntered: string[] = [];
        for (let n = r.u8(); n > 0; n--)
          anomaliesEntered.push(r.known(GAME_ANOMALY_IDS));
        const generation = r.i32();
        const cash = r.f64OrNull();
        const researchPoints = r.f64OrNull();
        const source = r.u8();
        timeline = {
          exportedAt,
          chronons,
          energy,
          elapsedSeconds,
          jumpAward,
          anomaliesEntered,
          generation,
          cash,
          researchPoints,
          stampSource: STAMP_SOURCES[source] ?? null,
        };
      }
      gameImport = {
        version: 1,
        importedAt,
        gameVersion,
        anomalyId: gameAnomaly,
        anomalyBalance,
        research,
        researchInProgress,
        clearing,
        islands,
        lockedTemplateIds,
        energyPerTick,
        timeline,
      };
    }

    return {
      buildingUpgrades,
      prestigeLevels,
      anomalyId,
      upgradePlan,
      activeTemplateId,
      customIslands,
      boards,
      solves,
      gameImport,
      chrononTarget,
    };
  } catch {
    throw new Error("That transfer code is incomplete. Copy it again.");
  }
}

// --- The link ---------------------------------------------------------------

/**
 * In the fragment rather than the query, so the save never reaches a server
 * log — the page is static, and the code is read here, by the page.
 */
const HASH_KEY = "t=";

export function buildTransferUrl(
  code: string,
  location: { origin: string; pathname: string } = window.location,
): string {
  return `${transferUrlPrefix(location)}${code}`;
}

/**
 * Everything in the link before the code. A QR code writes this part in its
 * byte mode and the code after it in its denser alphanumeric mode.
 */
export function transferUrlPrefix(
  location: { origin: string; pathname: string } = window.location,
): string {
  return `${location.origin}${location.pathname}#${HASH_KEY}`;
}

/** The transfer code in the current URL, if it carries one. */
export function readTransferLink(
  location: { hash: string } = window.location,
): string | null {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith(HASH_KEY)) return null;
  const code = hash.slice(HASH_KEY.length);
  return isTransferCode(code) ? code : null;
}

/** Drops the code from the address bar, so a reload does not offer it again. */
export function clearTransferLink(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  if (!window.location.hash.startsWith(`#${HASH_KEY}`)) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

// --- Bytes ------------------------------------------------------------------

/**
 * The 41 characters: QR alphanumeric, less the space and `%` a URL would
 * escape, `*` that chat apps read as markdown, and `.`, which a link's end
 * loses to the sentence around it. `/` and `:` go last, where a group's final
 * digit — at most 65535 / 41² = 38 — never reaches.
 */
const BASE41 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$+-/:";

function toBase41(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const v = bytes[i] * 256 + bytes[i + 1];
      s += BASE41[v % 41] + BASE41[Math.floor(v / 41) % 41];
      s += BASE41[Math.floor(v / 1681)];
    } else {
      const v = bytes[i];
      s += BASE41[v % 41] + BASE41[Math.floor(v / 41)];
    }
  }
  return s;
}

function fromBase41(text: string): Uint8Array<ArrayBuffer> {
  const digit = (ch: string) => {
    const d = BASE41.indexOf(ch);
    if (d < 0) throw new Error(`Not a code character: ${ch}`);
    return d;
  };
  if (text.length % 3 === 1) throw new Error("Truncated code");
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 3) {
    if (i + 2 < text.length) {
      const v =
        digit(text[i]) + digit(text[i + 1]) * 41 + digit(text[i + 2]) * 1681;
      if (v > 0xffff) throw new Error("Not a code");
      out.push(v >> 8, v & 0xff);
    } else {
      const v = digit(text[i]) + digit(text[i + 1]) * 41;
      if (v > 0xff) throw new Error("Not a code");
      out.push(v);
    }
  }
  return new Uint8Array(out);
}

/** A blueprint code's raw payload. */
function rawOf(code: string): Promise<Uint8Array<ArrayBuffer>> {
  return pipe(fromBase64Url(code), new DecompressionStream("deflate"));
}

/** The blueprint code for a raw payload `rawOf` produced. */
async function codeOf(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(await pipe(raw, new CompressionStream("deflate")));
}

async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(code: string): Uint8Array<ArrayBuffer> {
  let base64 = code.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
