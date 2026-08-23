/**
 * The two-press confirmation, which now stands between the player and three
 * buttons that throw away work: the readout's Reset, and the template list's
 * Reset and Delete.
 *
 * It is pinned because every rule here is a way the guard could fail *open* —
 * a press going straight through, or a second armed button quietly staying
 * live for a press aimed at the first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfirmArm } from "./confirmArm.svelte";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createConfirmArm", () => {
  it("does not go through on the first press", () => {
    const confirm = createConfirmArm<"reset">();
    expect(confirm.press("reset")).toBe(false);
    expect(confirm.armed).toBe("reset");
  });

  it("goes through on the second press of the same key", () => {
    const confirm = createConfirmArm<"reset">();
    confirm.press("reset");
    expect(confirm.press("reset")).toBe(true);
  });

  it("disarms once it has gone through, so a third press asks again", () => {
    const confirm = createConfirmArm<"reset">();
    confirm.press("reset");
    confirm.press("reset");
    expect(confirm.armed).toBe(null);
    expect(confirm.press("reset")).toBe(false);
  });

  it("arms nothing but the newest key — one live confirmation at a time", () => {
    // The readout's head holds two of these and the template list one per row.
    // If arming the second left the first live, a press meant for the second
    // would find the first already armed and destroy the wrong board.
    const confirm = createConfirmArm<"reset" | "copy">();
    confirm.press("reset");
    confirm.press("copy");
    expect(confirm.armed).toBe("copy");
    expect(confirm.press("reset")).toBe(false);
    expect(confirm.armed).toBe("reset");
  });

  it("gives up after the timeout, so a stray press leaves nothing live", () => {
    const confirm = createConfirmArm<"reset">(3000);
    confirm.press("reset");

    vi.advanceTimersByTime(2999);
    expect(confirm.armed).toBe("reset");

    vi.advanceTimersByTime(1);
    expect(confirm.armed).toBe(null);
    // And the press that lands after it has expired asks again rather than
    // going through on what the user will read as a first press.
    expect(confirm.press("reset")).toBe(false);
  });

  it("restarts the clock when a different key is armed", () => {
    const confirm = createConfirmArm<"reset" | "copy">(3000);
    confirm.press("reset");
    vi.advanceTimersByTime(2000);
    confirm.press("copy");

    vi.advanceTimersByTime(2000);
    expect(confirm.armed).toBe("copy");
    vi.advanceTimersByTime(1000);
    expect(confirm.armed).toBe(null);
  });

  it("cancels the timer on disarm, so it cannot fire after unmount", () => {
    // Both callers wire `disarm` to `onDestroy` — the sidebar unmounts every
    // time it collapses — and a surviving timer would write to dead state.
    const confirm = createConfirmArm<"reset">(3000);
    confirm.press("reset");
    confirm.disarm();

    expect(confirm.armed).toBe(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is safe to disarm when nothing is armed", () => {
    const confirm = createConfirmArm<"reset">();
    expect(() => confirm.disarm()).not.toThrow();
    expect(confirm.armed).toBe(null);
  });
});
