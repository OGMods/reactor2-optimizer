/**
 * `formatNumberForFilename` against its Python peer.
 *
 * The two are a pair like every other file in `docs/PARITY.md`'s table:
 * `py_solver/formatters.py`'s `format_for_filename` names the renders the
 * reference solver writes into `py_solver/solves/`, and this names the PNGs
 * the app hands the user. A board saved from either should sort beside the
 * same board saved from the other, so the expectations below are the literal
 * output of the Python function for the same inputs.
 */
import { describe, expect, it } from "vitest";
import { formatNumberForFilename } from "./formatters";

describe("a power figure spelled for a filename", () => {
  /** Verbatim from `python -c "from formatters import format_for_filename"`. */
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
   * Python peer produces — including an empty board, which is the one of these
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
  });
});
