/**
 * The game's number ladder: how a figure is spelled on screen, in a filename,
 * and read back from something a person typed.
 *
 * The expectations here started as the literal output of the Python reference
 * this package replaced, and are kept as a frozen table rather than recomputed:
 * a board saved today should sort beside the same board saved a year ago, so
 * the spelling is a compatibility promise, not an implementation detail.
 */
import { describe, expect, it } from "vitest";
import {
  SUFFIXES,
  formatNumber,
  formatNumberForFilename,
  parseHugeNumber,
} from "../src/utils/formatters";
import { expectClose } from "./helpers";

describe("the suffix table", () => {
  it("has index n represent ten to the three n", () => {
    expect(SUFFIXES[0]).toBe("");
    expect(SUFFIXES[1]).toBe("K");
    expect(SUFFIXES[4]).toBe("T");
    expect(SUFFIXES[5], "the letter pairs start right after T").toBe("AA");
    expect(SUFFIXES[6]).toBe("AB");
  });

  it("covers the whole two-letter range", () => {
    expect(SUFFIXES.length).toBe(5 + 26 * 26);
  });
});

describe("a figure spelled for the screen", () => {
  it("narrows its precision as the mantissa grows", () => {
    expect(formatNumber(1500)).toBe("1.50K"); // < 10  -> 2 decimals
    expect(formatNumber(12345)).toBe("12.3K"); // < 100 -> 1 decimal
    expect(formatNumber(123456)).toBe("123K"); // >= 100 -> integer
  });

  it("leaves values below one thousand untouched", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(999)).toBe("999");
  });

  it("uses letter pairs for the large tiers", () => {
    expect(formatNumber(1.5e15)).toBe("1.50AA");
    expect(formatNumber(7.17e19)).toBe("71.7AB");
  });

  it("keeps a negative sign", () => {
    expect(formatNumber(-2500)).toBe("-2.50K");
  });

  it("names the non-finite values rather than guessing at them", () => {
    expect(formatNumber(Infinity)).toBe("∞");
    expect(formatNumber(-Infinity)).toBe("-∞");
    // Not "-∞": NaN is unknown, not enormous and negative.
    expect(formatNumber(NaN)).toBe("NaN");
  });
});

describe("reading a figure back", () => {
  it("parses suffix notation", () => {
    expectClose(parseHugeNumber("20K"), 20e3);
    expectClose(parseHugeNumber("1.5AA"), 1.5e15);
  });

  it("parses plain and exponent notation", () => {
    expectClose(parseHugeNumber("1.5e30"), 1.5e30);
    expectClose(parseHugeNumber("2E-3"), 2e-3);
    expectClose(parseHugeNumber(1234), 1234);
  });

  it("gives NaN for anything it cannot read", () => {
    expect(parseHugeNumber("not a number")).toBeNaN();
    expect(parseHugeNumber("5ZZZ")).toBeNaN();
    expect(parseHugeNumber("")).toBeNaN();
  });

  it("round-trips through formatNumber", () => {
    for (const value of [1, 1500, 2.5e6, 7.5e18, 3.2e30]) {
      // formatNumber rounds to three significant digits.
      expectClose(parseHugeNumber(formatNumber(value)), value, 5e-3);
    }
  });
});

describe("a power figure spelled for a filename", () => {
  /** The ladder as the reference solver spelled it. */
  const cases: [number, string][] = [
    [1, "1"],
    [999, "999"],
    [1000, "1K"],
    [1500, "1K-500"],
    [2500, "2K-500"],
    [999999, "999K-999"],
    [1e6, "1M"],
    [1234567, "1M-234K"],
    [5e6, "5M"],
    [1.23456e16, "12AA-345T"],
    [7.17e19, "71AB-700AA"],
    [1e30, "1AF"],
  ];

  for (const [input, expected] of cases) {
    it(`spells ${input} as ${expected}`, () => {
      expect(formatNumberForFilename(input)).toBe(expected);
    });
  }

  /*
   * A filename is no place to explain a figure that should not exist, so
   * everything that is not a positive number collapses to the same "0" the
   * reference produced — including an empty board, which is the one of these
   * a user can actually reach.
   */
  it("gives nothing but zero a name", () => {
    for (const n of [0, -5, NaN, Infinity, -Infinity]) {
      expect(formatNumberForFilename(n)).toBe("0");
    }
  });

  /* The minor tier is dropped when it says nothing — `5M`, never `5M-0`. */
  it("leaves the minor tier off a round figure", () => {
    expect(formatNumberForFilename(3e9)).toBe("3B");
    expect(formatNumberForFilename(3e9 + 4e6)).toBe("3B-4M");
    expect(formatNumberForFilename(5000)).toBe("5K");
    expect(formatNumberForFilename(42)).toBe("42");
  });

  /*
   * The separator is a hyphen where the reference solver used an underscore:
   * these names reach a user's download folder rather than a scratch directory,
   * and a hyphen is what the rest of the filename already uses. Either way the
   * point is the same — nothing in here needs escaping, and no dot can be read
   * as an extension.
   */
  it("produces a filesystem-safe name", () => {
    for (const value of [0, 42, 5500, 1.2345e16, 6.38e22]) {
      expect(formatNumberForFilename(value)).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
});
