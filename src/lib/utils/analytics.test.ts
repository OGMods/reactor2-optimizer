import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every branch here fails either open (a page view sent for someone who said
 * no) or closed (the tag silently off for everyone), and neither is visible in
 * the app.
 *
 * No DOM, so the module gets stand-ins for the three globals it reads. Each
 * test re-imports it, because "already fetched" is module state.
 */

const MEASUREMENT_ID = "G-L2GPXHN8RP";
const DISABLE_FLAG = `ga-disable-${MEASUREMENT_ID}`;

interface FakeScript {
  async?: boolean;
  src?: string;
}

function stubBrowser(
  nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean } = {},
  winDnt?: string,
) {
  const appended: FakeScript[] = [];
  const win: Record<string, unknown> = {};
  if (winDnt !== undefined) win.doNotTrack = winDnt;

  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("document", {
    createElement: (): FakeScript => ({}),
    head: { appendChild: (el: FakeScript) => appended.push(el) },
  });

  return { win, appended };
}

async function loadModule() {
  vi.resetModules();
  return await import("./analytics");
}

afterEach(() => vi.unstubAllGlobals());

describe("doNotTrackRequested", () => {
  it("reads Global Privacy Control", async () => {
    stubBrowser({ globalPrivacyControl: true });
    expect((await loadModule()).doNotTrackRequested()).toBe(true);
  });

  it("reads navigator.doNotTrack", async () => {
    stubBrowser({ doNotTrack: "1" });
    expect((await loadModule()).doNotTrackRequested()).toBe(true);
  });

  it("reads window.doNotTrack", async () => {
    stubBrowser({}, "1");
    expect((await loadModule()).doNotTrackRequested()).toBe(true);
  });

  /* `"0"` is permission, and it is truthy — a coerced test would invert it. */
  it('treats "0" as permission, not refusal', async () => {
    stubBrowser({ doNotTrack: "0" });
    expect((await loadModule()).doNotTrackRequested()).toBe(false);
  });

  it("is false when the browser says nothing", async () => {
    stubBrowser();
    expect((await loadModule()).doNotTrackRequested()).toBe(false);
  });

  it("is false with no window", async () => {
    vi.stubGlobal("window", undefined);
    expect((await loadModule()).doNotTrackRequested()).toBe(false);
  });
});

describe("analyticsOptedOut", () => {
  it("follows do-not-track while nobody has chosen", async () => {
    stubBrowser({ globalPrivacyControl: true });
    expect((await loadModule()).analyticsOptedOut(null)).toBe(true);
  });

  it("collects by default when the browser says nothing", async () => {
    stubBrowser();
    expect((await loadModule()).analyticsOptedOut(null)).toBe(false);
  });

  it("lets an explicit opt-in beat do-not-track", async () => {
    stubBrowser({ doNotTrack: "1" });
    expect((await loadModule()).analyticsOptedOut(false)).toBe(false);
  });

  it("keeps an explicit opt-out with no signal set", async () => {
    stubBrowser();
    expect((await loadModule()).analyticsOptedOut(true)).toBe(true);
  });
});

describe("setAnalyticsEnabled", () => {
  it("never fetches the tag for a visitor who is opted out", async () => {
    const { win, appended } = stubBrowser();
    (await loadModule()).setAnalyticsEnabled(false);

    expect(appended).toHaveLength(0);
    expect(win[DISABLE_FLAG]).toBe(true);
  });

  it("fetches the tag once and primes the queue", async () => {
    const { win, appended } = stubBrowser();
    const { setAnalyticsEnabled } = await loadModule();

    setAnalyticsEnabled(true);
    expect(win[DISABLE_FLAG]).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.async).toBe(true);
    expect(appended[0]?.src).toContain(MEASUREMENT_ID);
    expect((win.dataLayer as unknown[]).length).toBe(2);

    // A second enable is not a second page view.
    setAnalyticsEnabled(true);
    expect(appended).toHaveLength(1);
    expect((win.dataLayer as unknown[]).length).toBe(2);
  });

  /* The point of the flag: silence a tag that is already in the page. */
  it("disables a tag already loaded, without re-fetching on re-enable", async () => {
    const { win, appended } = stubBrowser();
    const { setAnalyticsEnabled } = await loadModule();

    setAnalyticsEnabled(true);
    setAnalyticsEnabled(false);
    expect(win[DISABLE_FLAG]).toBe(true);
    expect(appended).toHaveLength(1);

    setAnalyticsEnabled(true);
    expect(win[DISABLE_FLAG]).toBe(false);
    expect(appended).toHaveLength(1);
  });
});

describe("trackEvent", () => {
  it("holds events fired before the tag lands, then flushes them in order", async () => {
    const { win } = stubBrowser();
    const { setAnalyticsEnabled, trackEvent } = await loadModule();

    trackEvent("solve_run", { mode: "deep" });
    trackEvent("solve_done", { power: 12 });
    expect(win.dataLayer).toBeUndefined();

    setAnalyticsEnabled(true);
    const sent = (win.dataLayer as IArguments[]).map((a) => [...a]);
    // `js`, `config`, then the two buffered events.
    expect(sent).toHaveLength(4);
    expect(sent[2]).toEqual(["event", "solve_run", { mode: "deep" }]);
    expect(sent[3]).toEqual(["event", "solve_done", { power: 12 }]);
  });

  it("never sends what was buffered before an opt-out", async () => {
    const { win } = stubBrowser();
    const { setAnalyticsEnabled, trackEvent } = await loadModule();

    trackEvent("solve_run", { mode: "quick" });
    setAnalyticsEnabled(false);
    setAnalyticsEnabled(true);

    const sent = (win.dataLayer as IArguments[]).map((a) => [...a]);
    expect(sent).toHaveLength(2);
    expect(sent.some(([, name]) => name === "solve_run")).toBe(false);
  });

  it("caps the buffer so an opted-out session cannot grow it forever", async () => {
    const { win } = stubBrowser();
    const { setAnalyticsEnabled, trackEvent } = await loadModule();

    for (let i = 0; i < 50; i++) trackEvent("solve_run", { i });
    setAnalyticsEnabled(true);

    // 20 buffered, plus `js` and `config`.
    expect((win.dataLayer as unknown[]).length).toBe(22);
  });

  it("sends straight through once the tag is in the page", async () => {
    const { win } = stubBrowser();
    const { setAnalyticsEnabled, trackEvent } = await loadModule();

    setAnalyticsEnabled(true);
    trackEvent("share_copy", { form: "link" });

    const sent = (win.dataLayer as IArguments[]).map((a) => [...a]);
    expect(sent[2]).toEqual(["event", "share_copy", { form: "link" }]);
  });
});
