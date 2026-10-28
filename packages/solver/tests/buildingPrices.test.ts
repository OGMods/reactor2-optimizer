/**
 * The game's building prices: copies compound, the two reductions multiply,
 * and a sale refunds a share of the current price. Held against the player's
 * own research levels as a game export reports them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPrice, priceRules, sellRefund } from "../src/data/buildingPrices";
import { decodeGameExport } from "../src/encoding/gameExport";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "gameExports");

describe("priceRules", () => {
  it("is the plain game with no research", () => {
    expect(priceRules({})).toEqual({ scaler: 1.14, discount: 1, refund: 0.5 });
  });

  it("reads a player's research off their export", async () => {
    const exp = await decodeGameExport(
      readFileSync(join(DIR, "gen2_city52_9c43e4b7_server.txt"), "utf8"),
    );
    // Standardized Builds 9, Construction Permits 10, Salvage Protocols 10,
    // Quantum Replicator 6.
    expect(exp.research.BuildingsCostMultiplierResearchSO).toBe(9);
    const rules = priceRules(exp.research);
    expect(rules.scaler).toBe(1.02);
    expect(rules.refund).toBe(0.98);
    expect(rules.discount).toBeCloseTo((1 - 0.55) * (1 - 0.58), 12);
  });

  it("clamps a level past the table", () => {
    expect(priceRules({ BuildingsCostMultiplierResearchSO: 40 }).scaler).toBe(
      1.02,
    );
  });
});

describe("buildPrice and sellRefund", () => {
  const rules = { scaler: 1.14, discount: 0.5, refund: 0.6 };

  it("compounds with every copy and takes the discount off", () => {
    expect(buildPrice(100, 0, rules)).toBe(50);
    expect(buildPrice(100, 2, rules)).toBeCloseTo(100 * 1.14 ** 2 * 0.5, 9);
  });

  it("refunds a share of the current price, and nothing with none standing", () => {
    expect(sellRefund(100, 3, rules)).toBeCloseTo(
      buildPrice(100, 3, rules) * 0.6,
      9,
    );
    expect(sellRefund(100, 0, rules)).toBe(0);
  });
});
