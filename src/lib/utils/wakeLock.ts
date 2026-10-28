/**
 * Keeps the screen on while a solve runs.
 *
 * A solve takes long enough for a phone to dim and lock, and a locked phone
 * throttles or freezes the page — a run left on the desk comes back stalled,
 * and Solve all waits for the page to be visible before each island. The
 * Screen Wake Lock API asks the browser not to sleep the display while the
 * lock is held.
 *
 * **Best-effort by design**, like `haptics.ts`: browsers without the API, or
 * a page not served over HTTPS, simply get no lock. The browser also drops the
 * lock whenever the page is hidden, so it is taken again when the page comes
 * back while the solve is still running.
 */

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || sentinel !== null || document.visibilityState !== "visible")
    return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    // The solve may have finished while the request was in flight.
    if (!wanted) {
      void lock.release();
      return;
    }
    sentinel = lock;
    lock.addEventListener("release", () => {
      if (sentinel === lock) sentinel = null;
    });
  } catch {
    // Refused (battery saver, no permission): the solve runs regardless.
  }
}

function onVisibility(): void {
  void acquire();
}

/** Holds the screen awake while `on` is true; releases it when it is not. */
export function keepScreenAwake(on: boolean): void {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
  if (on === wanted) return;
  wanted = on;
  if (on) {
    document.addEventListener("visibilitychange", onVisibility);
    void acquire();
  } else {
    document.removeEventListener("visibilitychange", onVisibility);
    const lock = sentinel;
    sentinel = null;
    void lock?.release();
  }
}
