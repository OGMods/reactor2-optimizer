/**
 * The transfer code carries a whole browser to another one, so the one rule
 * that matters is that everything comes back as it went — boards as codes
 * that decode to the same board, solves as the same shapes.
 */
import { describe, expect, it } from "vitest";
import {
  BUILDINGS,
  blueprintKey,
  decodeBlueprint,
  encodeBlueprint,
  ISLAND_TEMPLATES,
} from "@reactor2/solver";
import type { SavedGameImport } from "../storage/storage";
import {
  buildTransferUrl,
  decodeTransfer,
  encodeTransfer,
  isTransferCode,
  readTransferLink,
  type TransferBundle,
} from "./transfer";

async function bundle(): Promise<TransferBundle> {
  const base = await decodeBlueprint(ISLAND_TEMPLATES[0].code);
  const edited = await encodeBlueprint(base.grid, [
    { buildingId: "cooler1", x: 3, y: 4 },
  ]);
  const solved = await encodeBlueprint(base.grid, [
    { buildingId: "cooler1", x: 3, y: 4 },
    { buildingId: "cooler2", x: 5, y: 6 },
  ]);
  const game: SavedGameImport = {
    version: 1,
    importedAt: 1_700_000_000_000,
    gameVersion: "1.1.11",
    anomalyId: "none",
    anomalyBalance: 0,
    research: {
      chronon_reactor: 3,
      quantum_replicator: 0,
      research_building_cooler1: 2,
      // One the game added after this build: it travels by name.
      FutureEconomyResearchSO: 4,
    },
    researchInProgress: [
      { id: "phase_breaker", level: 2, secondsLeft: 600 },
      { id: "AnotherFutureResearchSO", level: 1, secondsLeft: 60 },
    ],
    clearing: [{ x: -13, y: -8, secondsLeft: 100 }],
    islands: { [ISLAND_TEMPLATES[0].id]: edited },
    lockedTemplateIds: [],
    energyPerTick: 12.5,
    timeline: null,
  };
  return {
    buildingUpgrades: { cooler1: 2, cooler2: 0 },
    prestigeLevels: { stellar_forge: 2 },
    anomalyId: "none",
    upgradePlan: [{ buildingId: "cooler1", level: 3 }],
    activeTemplateId: ISLAND_TEMPLATES[0].id,
    customIslands: [{ id: "custom-1", name: "Mine" }],
    boards: { [ISLAND_TEMPLATES[0].id]: edited, "custom-1": edited },
    solves: {
      [ISLAND_TEMPLATES[0].id]: {
        code: solved,
        anomalyId: "none",
        planKey: "",
        durationMs: 30_000,
        finishedAt: 1_700_000_100_000,
      },
    },
    gameImport: game,
    chrononTarget: 12_000,
  };
}

describe("the transfer code", () => {
  it("brings everything back as it went", async () => {
    const sent = await bundle();
    const code = await encodeTransfer(sent);
    expect(isTransferCode(code)).toBe(true);
    const got = await decodeTransfer(code);

    const { boards, gameImport, solves, ...rest } = got;
    const {
      boards: sentBoards,
      gameImport: sentGame,
      solves: sentSolves,
      ...sentRest
    } = sent;
    expect(rest).toEqual(sentRest);
    // Boards by content: deflate need not give back the same bytes.
    const sameBoard = async (x: string, y: string) => {
      const [a, b] = await Promise.all([
        decodeBlueprint(x),
        decodeBlueprint(y),
      ]);
      expect(blueprintKey(b.grid, b.placements)).toBe(
        blueprintKey(a.grid, a.placements),
      );
    };
    for (const [id, c] of Object.entries(sentBoards))
      await sameBoard(c, boards[id]);
    for (const [id, s] of Object.entries(sentSolves)) {
      expect({ ...solves[id], code: "" }).toEqual({ ...s, code: "" });
      await sameBoard(s.code, solves[id].code);
    }
    expect(gameImport!.islands).toHaveProperty(ISLAND_TEMPLATES[0].id);
    expect({ ...gameImport!, islands: {} }).toEqual({
      ...sentGame!,
      islands: {},
      // Level 0 and the building nodes are left behind; nothing reads them.
      research: { chronon_reactor: 3, FutureEconomyResearchSO: 4 },
    });
  });

  it("sends a mostly unlocked roster in table order", async () => {
    const sent = await bundle();
    const all = Object.fromEntries(BUILDINGS.map((b, i) => [b.id, i % 4]));
    delete all[BUILDINGS[3].id];
    sent.buildingUpgrades = all;
    const got = await decodeTransfer(await encodeTransfer(sent));
    expect(got.buildingUpgrades).toEqual(all);
  });

  it("rides in the link's fragment", async () => {
    const code = await encodeTransfer(await bundle());
    const url = buildTransferUrl(code, {
      origin: "https://example.test",
      pathname: "/app/",
    });
    expect(url.startsWith("https://example.test/app/#t=R2T1.")).toBe(true);
    expect(readTransferLink({ hash: new URL(url).hash })).toBe(code);
    expect(readTransferLink({ hash: "#other" })).toBeNull();
  });

  it("says so when a code is cut short", async () => {
    const code = await encodeTransfer(await bundle());
    await expect(decodeTransfer(code.slice(0, 40))).rejects.toThrow(
      /incomplete/,
    );
  });
});
