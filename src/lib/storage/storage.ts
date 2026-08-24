import type { CustomIsland } from "../types/building";
import type { ImageScale, PlacementView } from "../types/ui";
import { DEFAULT_SOLVE_MODE, type SolveModeId } from "../worker/solveModes";
import type { OptimizationResult } from "../solver/types";

export interface SavedTemplateData {
  /** Blueprint code — terrain and hand-placed buildings, see `lib/encoding/blueprint.ts`. */
  code: string;
}

export interface StoragePayload {
  activeTemplateId: string;
  savedGrids: Record<string, SavedTemplateData>;
  /** User-created islands. Their terrain lives in `savedGrids`, keyed by id. */
  customIslands?: CustomIsland[];
}

const KEYS = {
  GRID_STATE: "grid_state",
  BUILDINGS: "buildings",
  UI: "ui_prefs",
  SOLVE: "solver_result",
} as const;

export interface UiPrefs {
  /** Desktop only. The mobile sheet always opens closed, by design. */
  sidebarCollapsed: boolean;
  /**
   * Which board the canvas draws. Persisted alongside the solve itself, so a
   * reload puts the user back in front of the layout they were looking at
   * rather than silently swapping to the other one.
   */
  placementView: PlacementView;
  /**
   * Compact viewports only: whether the corner readout is folded to a single
   * line. It sits over the map on a small screen, so hiding it is a real
   * preference rather than a transient toggle.
   */
  statsCardCollapsed: boolean;
  /**
   * How a run spends its time — one long search or several short ones. A
   * preference rather than a per-run question: it is about how much
   * wall-clock the player is willing to give the optimizer, which does not
   * change from one island to the next.
   */
  solveMode: SolveModeId;
  /**
   * Whether the board animates — see `uiState.animations`.
   *
   * **Optional on purpose.** Absent is not `false`; it means the user has
   * never said, and the app follows `prefers-reduced-motion` instead. Giving
   * it a default here would collapse that third state and lock every viewer
   * to one answer on their first visit.
   */
  animations?: boolean;
  /**
   * Whether an edit that lands buzzes — see `uiState.haptics`.
   *
   * Not optional, unlike `animations` directly above, and the asymmetry is
   * deliberate: there is no `prefers-reduced-motion` for touch, so there is no
   * system answer to defer to and no third state to preserve. On by default,
   * because on the devices that have it the feedback is worth more than the
   * novelty costs.
   */
  haptics: boolean;
  /**
   * Whether usage collection is switched **off** — see
   * `uiState.analyticsDisabled`. The negative, because gtag's own switch is
   * `ga-disable-<id>` and the default is to collect.
   *
   * **Optional on purpose, like `animations` above.** Absent means the user
   * has never said, and the app follows the browser's do-not-track signal.
   */
  analyticsDisabled?: boolean;
  /** How far `saveLayoutImage` scales the exported PNG up. */
  imageScale: ImageScale;
}

const DEFAULT_UI_PREFS: UiPrefs = {
  sidebarCollapsed: false,
  placementView: "solver",
  statsCardCollapsed: false,
  solveMode: DEFAULT_SOLVE_MODE,
  haptics: true,
  imageScale: 1,
};

/**
 * A completed solve, kept so a reload does not throw away a run that can take
 * five minutes to reproduce.
 *
 * One record **per island**: switching islands puts a solve out of sight, not
 * out of existence, and coming back brings it up again. A single global record
 * meant every switch destroyed the last run.
 *
 * A result is only meaningful for the board and roster it was computed
 * against, so the identity of both is stored with it and checked on restore —
 * see `solverState.restore()`.
 */
export interface SavedSolveData {
  /** Which island the solve was for. */
  templateId: string;
  /** Terrain + roster identity at the time of the solve. */
  signature: string;
  /** The layout the user picked — `variants[selectedVariant]`, scored. */
  result: OptimizationResult;
  /**
   * Every layout the solve found at that power, the picked one included, as
   * bare shape.
   *
   * A scored layout carries nine figures per building and a solve can hold
   * ten of them across eight islands, which is megabytes of `localStorage`
   * for numbers that are all recomputable: `simulatePlacedBuildings` scores
   * a shape in a millisecond. So only the shape is written, and only the
   * picked variant is stored scored — which it has to be anyway, since it is
   * what a restore hangs on screen.
   *
   * Absent on records written before variants existed; such a solve restores
   * as a shortlist of one.
   */
  variants?: StoredPlacement[][];
  /** Which entry of `variants` the user applied. */
  selectedVariant?: number;
  /** Wall-clock length of the run, in ms. */
  durationMs: number;
  /** When it finished, epoch ms. Shown as "solved N ago". */
  finishedAt: number;
}

/**
 * One building of a stored variant: what it is, where it stands, and the tier
 * it was placed at. Everything else about it is derived by re-scoring.
 *
 * A tuple rather than an object because there are thousands of them in a
 * record and the key names would be most of the bytes.
 */
export type StoredPlacement = [
  buildingId: string,
  x: number,
  y: number,
  baseValue: number,
];

/**
 * Generic helper to safely read and parse JSON from localStorage with SSR guarding.
 */
function getItem<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const item = localStorage.getItem(key);
    return item ? (JSON.parse(item) as T) : fallback;
  } catch (e) {
    console.error(`[Storage] Failed to parse key "${key}":`, e);
    return fallback;
  }
}

/**
 * Generic helper to safely remove a key from localStorage.
 */
function removeItem(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.error(`[Storage] Failed to clear key "${key}":`, e);
  }
}

/**
 * Generic helper to safely serialize and save data to localStorage.
 */
function setItem<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`[Storage] Failed to save key "${key}":`, e);
  }
}

// Domain-specific storage adapters
export const buildingStorage = {
  loadBuildings: (): Record<string, number> => getItem(KEYS.BUILDINGS, {}),
  saveBuildings: (data: Record<string, number>): void =>
    setItem(KEYS.BUILDINGS, data),
};

export const uiStorage = {
  loadPrefs: (): UiPrefs => ({
    ...DEFAULT_UI_PREFS,
    ...getItem<Partial<UiPrefs>>(KEYS.UI, {}),
  }),
  /**
   * Merges over what is already stored. Callers save the one preference they
   * just changed, and a whole-object write would silently reset the others.
   */
  savePrefs: (patch: Partial<UiPrefs>): void =>
    setItem(KEYS.UI, { ...uiStorage.loadPrefs(), ...patch }),
};

/**
 * How many islands' solves to keep. A solve carries every placement on its
 * board, so a dozen large ones is megabytes — past this the oldest are dropped
 * rather than letting a silent quota error start losing writes at random.
 */
const MAX_STORED_SOLVES = 8;

type SolveRecords = Record<string, SavedSolveData>;

/**
 * Reads the whole store, adopting the single-record shape an earlier build
 * wrote. That record is one island's solve, so it becomes that island's entry;
 * anything unrecognisable is dropped rather than left to collide with a real
 * template id.
 */
function loadSolveRecords(): SolveRecords {
  const raw = getItem<SolveRecords & { result?: unknown }>(KEYS.SOLVE, {});
  if (!raw || typeof raw !== "object") return {};
  if (!("result" in raw)) return raw;

  const legacy = raw as unknown as SavedSolveData;
  return typeof legacy.templateId === "string"
    ? { [legacy.templateId]: legacy }
    : {};
}

export const solverStorage = {
  loadSolve: (templateId: string): SavedSolveData | null =>
    loadSolveRecords()[templateId] ?? null,

  saveSolve: (data: SavedSolveData): void => {
    const records = loadSolveRecords();
    records[data.templateId] = data;

    const ids = Object.keys(records);
    if (ids.length > MAX_STORED_SOLVES) {
      ids.sort(
        (a, b) => (records[a]?.finishedAt ?? 0) - (records[b]?.finishedAt ?? 0),
      );
      for (const id of ids.slice(0, ids.length - MAX_STORED_SOLVES))
        delete records[id];
    }

    setItem(KEYS.SOLVE, records);
  },

  /** Forgets one island's solve, or the whole store when it empties. */
  clearSolve: (templateId: string): void => {
    const records = loadSolveRecords();
    if (!(templateId in records)) return;

    delete records[templateId];
    if (Object.keys(records).length === 0) removeItem(KEYS.SOLVE);
    else setItem(KEYS.SOLVE, records);
  },
};

export const gridStorage = {
  loadGridState: (): StoragePayload | null =>
    getItem<StoragePayload | null>(KEYS.GRID_STATE, null),
  saveGridState: (data: StoragePayload): void => setItem(KEYS.GRID_STATE, data),
};
