/**
 * The two time formats the timeline panel speaks in: a span of game time, and
 * a moment ahead on the device's clock.
 */
import { describe, expect, it } from "vitest";
import { formatClockTime, formatSpan } from "./formatters";

describe("formatSpan", () => {
  it("reads to its two largest units", () => {
    expect(formatSpan(37)).toBe("37s");
    expect(formatSpan(242)).toBe("4m 02s");
    expect(formatSpan(4 * 3600 + 17 * 60 + 5)).toBe("4h 17m");
    expect(formatSpan(13 * 86400 + 4 * 3600 + 59)).toBe("13d 4h");
  });

  it("never goes below zero or into fractions", () => {
    expect(formatSpan(-5)).toBe("0s");
    expect(formatSpan(59.9)).toBe("59s");
  });
});

describe("formatClockTime", () => {
  // Local noon, so neither an hour ahead nor behind crosses a day boundary.
  const now = new Date(2026, 9, 22, 12, 0).getTime();
  const hours = (h: number) => now + h * 3600 * 1000;

  it("names today and tomorrow", () => {
    expect(formatClockTime(hours(3), now)).toMatch(/^today /);
    expect(formatClockTime(hours(20), now)).toMatch(/^tomorrow /);
  });

  it("names the weekday within the week, and the date past it", () => {
    const inThree = hours(24 * 3);
    const weekday = new Date(inThree).toLocaleDateString(undefined, {
      weekday: "short",
    });
    expect(formatClockTime(inThree, now).startsWith(`${weekday} `)).toBe(true);

    const inNine = hours(24 * 9);
    const date = new Date(inNine).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(formatClockTime(inNine, now).startsWith(`${date} `)).toBe(true);
  });

  it("names no moment past the range a date can hold", () => {
    expect(formatClockTime(now + 1e9 * 86400 * 1000, now)).toBe("—");
  });

  it("reads a moment already past as today", () => {
    expect(formatClockTime(hours(-1), now)).toMatch(/^today /);
  });
});
