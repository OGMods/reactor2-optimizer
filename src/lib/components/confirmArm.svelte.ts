/**
 * The app's two-press confirmation, in one place.
 *
 * Three buttons destroy work a player cannot get back by pressing again — the
 * readout's Reset, the template list's Reset and its Delete — and all three ask
 * the same way: the first press arms, the second goes through, and an armed
 * button gives up after a few seconds so a stray tap never leaves a live
 * "Sure?" sitting there for a later, unrelated one to hit.
 *
 * Written once here rather than per component: a copy each is a chance for the
 * timeout, the disarm-on-unmount or the arming rules to drift apart — and the
 * whole value of an idiom is that a player who has met it once knows what the
 * next one will do.
 *
 * **Armed state is a key, not a boolean.** Both call sites hold more than one
 * of these at a time (two buttons in the readout's head, one per row in the
 * template list), and arming one has to disarm the other or a second press
 * lands on whichever happened to still be live. A single field makes "only one
 * armed at a time" a property of the type rather than an invariant each caller
 * remembers.
 */

/**
 * How long an armed button stays armed.
 *
 * Long enough to read the word that replaced the label and press again;
 * short enough that walking away disarms it.
 */
const CONFIRM_TIMEOUT_MS = 3000;

export interface ConfirmArm<T extends string> {
  /** Which key is armed, or `null`. Read this to render the armed state. */
  readonly armed: T | null;
  /** `true` once the second press lands; arms and waits on the first. */
  press(key: T): boolean;
  /** Drops any armed key. Idempotent, and safe to call from `onDestroy`. */
  disarm(): void;
}

/**
 * Creates one confirmation. `T` is whatever names the buttons sharing it — a
 * union of literals for a fixed pair, `string` for a list keyed by row id.
 *
 * Callers must wire `disarm` to `onDestroy`: the sidebar unmounts when it
 * collapses, and a pending timer would be left poking at state that is gone.
 */
export function createConfirmArm<T extends string>(
  timeoutMs: number = CONFIRM_TIMEOUT_MS,
): ConfirmArm<T> {
  let armed = $state<T | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function disarm() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    armed = null;
  }

  return {
    get armed() {
      return armed;
    },
    press(key: T): boolean {
      if (armed === key) {
        disarm();
        return true;
      }
      // Arming a different key disarms the one before it, so the list can
      // never hold two live confirmations at once.
      disarm();
      armed = key;
      timer = setTimeout(disarm, timeoutMs);
      return false;
    },
    disarm,
  };
}
