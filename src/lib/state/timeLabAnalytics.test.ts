/**
 * What the Time Lab reports to analytics.
 *
 * Every rule here fails silently in the app and only shows up as a wrong
 * figure in GA: an anomaly counted twice for a press on the card already
 * chosen, or a research level off by one against the tier button the player
 * pressed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("../utils/analytics", () => ({ trackEvent }));

import { configState } from "./config.svelte";

beforeEach(() => {
  configState.setAnomaly("none");
  for (const id of Object.keys(configState.prestigeLevels))
    configState.toggleResearch(id);
  trackEvent.mockClear();
});

describe("anomaly_select", () => {
  it("names the new anomaly and the one it replaced", () => {
    configState.setAnomaly("tidal_ascendancy");
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledWith("anomaly_select", {
      anomaly: "tidal_ascendancy",
      from: "none",
    });
  });

  it("is not sent for the anomaly already chosen", () => {
    configState.setAnomaly("none");
    expect(trackEvent).not.toHaveBeenCalled();
  });
});

describe("research_set", () => {
  it("numbers levels from 1, and 0 for switched off", () => {
    configState.toggleResearch("absolute_zero");
    configState.setResearchLevel("absolute_zero", 4);
    configState.toggleResearch("absolute_zero");
    expect(trackEvent.mock.calls).toEqual([
      ["research_set", { research: "absolute_zero", level: 1 }],
      ["research_set", { research: "absolute_zero", level: 5 }],
      ["research_set", { research: "absolute_zero", level: 0 }],
    ]);
  });

  it("is not sent for the level already set", () => {
    configState.toggleResearch("infinite_grid");
    trackEvent.mockClear();
    configState.setResearchLevel("infinite_grid", 0);
    expect(trackEvent).not.toHaveBeenCalled();
  });
});

describe("rulesParams", () => {
  it("says none when nothing is researched", () => {
    expect(configState.rulesParams()).toEqual({
      anomaly: "none",
      research: "none",
    });
  });

  it("lists research sorted by id, numbered from 1", () => {
    configState.setAnomaly("cryo_nexus");
    configState.toggleResearch("stellar_forge");
    configState.toggleResearch("absolute_zero");
    configState.setResearchLevel("absolute_zero", 2);
    expect(configState.rulesParams()).toEqual({
      anomaly: "cryo_nexus",
      research: "absolute_zero:3,stellar_forge:1",
    });
  });

  it("reports an unknown stored id as the baseline it resolves to", () => {
    configState.setAnomaly("not_an_anomaly");
    expect(configState.rulesParams().anomaly).toBe("none");
  });
});
