import { describe, expect, it } from "vitest";
import { getAnomaly } from "@reactor2/solver";
import { anomalyIconFor, STATE_ICON } from "./boardIcons";

describe("anomalyIconFor", () => {
  const SINGULARITY = getAnomaly("singularity_isolation");
  const TIDAL = getAnomaly("tidal_ascendancy");
  const CRYO = getAnomaly("cryo_nexus");

  it("shows nothing where the scorer moved nothing", () => {
    expect(anomalyIconFor(SINGULARITY, null, "generator")).toBeNull();
    expect(anomalyIconFor(getAnomaly(undefined), "up", "reactor")).toBeNull();
  });

  it("has both of the game's Singularity icons", () => {
    expect(anomalyIconFor(SINGULARITY, "up", "generator")).toBe(
      "anomaly_buff_isolated",
    );
    expect(anomalyIconFor(SINGULARITY, "down", "generator")).toBe(
      "anomaly_buff_crowded",
    );
  });

  it("marks a waterside building under Tidal, and a cooler under Cryo", () => {
    expect(anomalyIconFor(TIDAL, "up", "reactor")).toBe(
      "anomaly_buff_waterside",
    );
    expect(anomalyIconFor(CRYO, "down", "cooler")).toBe(
      "anomaly_buff_cooling_pool",
    );
    expect(anomalyIconFor(CRYO, "down", "generator")).toBeNull();
  });
});

describe("STATE_ICON", () => {
  it("marks every state that needs the player, and nothing that is fine", () => {
    expect(STATE_ICON).toEqual({
      offline: "status_offline",
      idle: "status_idle",
      overheated: "status_overheated",
      wasting_heat: "status_gauge",
      stable: null,
      online: null,
    });
  });
});
