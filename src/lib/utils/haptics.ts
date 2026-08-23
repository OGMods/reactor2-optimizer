/**
 * A short confirmation buzz for an edit that has landed.
 *
 * The board is isometric, the tiles are small and a thumb covers several at
 * once, so a misplace on a phone is not carelessness — it is the input method.
 * Touch is the one sense that can confirm a tap without the finger moving off
 * what it is covering, which is exactly the moment the screen cannot.
 *
 * **Best-effort by design.** iOS Safari implements none of the Vibration API,
 * and Android requires the call to follow a user gesture. So this is never
 * the only signal that something happened: everything it confirms, the board
 * has already redrawn.
 */

/** Long enough to feel, short enough not to read as a buzz. */
const TAP_MS = 10;

export function hapticTap(): void {
  if (typeof navigator === "undefined") return;
  navigator.vibrate?.(TAP_MS);
}
