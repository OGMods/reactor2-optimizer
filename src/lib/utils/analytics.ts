/**
 * Google Analytics, loaded late and only with the user's leave.
 *
 * The tag is deliberately not in `index.html`: a `<head>` script fires its
 * `page_view` before any preference has been read, and it would compete with
 * the sprite atlas for the first frame. `main.ts` starts it on idle instead.
 */

/** Public by construction — it ships in the bundle. */
const MEASUREMENT_ID = "G-L2GPXHN8RP";

/** gtag's own kill switch, which the loaded script checks before every send. */
const DISABLE_FLAG = `ga-disable-${MEASUREMENT_ID}`;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Whether the browser is asking, on the user's behalf, not to be tracked.
 *
 * GPC as well as `doNotTrack`, because DNT is gone from Safari and never had a
 * UI in Chrome. Compared to `"1"` rather than coerced: `"0"` means *yes, you
 * may*, and it is truthy.
 */
export function doNotTrackRequested(): boolean {
  // Guarded on `window`, not `navigator` — Node defines a global `navigator`,
  // so that guard would let the `window` read below through and throw.
  if (typeof window === "undefined") return false;

  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const win = window as Window & { doNotTrack?: string | null };

  return (
    nav.globalPrivacyControl === true ||
    nav.doNotTrack === "1" ||
    win.doNotTrack === "1"
  );
}

/**
 * Is this visitor opted out, given their stored choice — `null` meaning they
 * have never made one?
 *
 * Three states, like `uiState.animations`: the browser answers until someone
 * chooses, and an explicit choice then wins in both directions. One function
 * because `main.ts` resolves it at boot and `uiState` resolves it for the
 * switch, and the two cannot disagree.
 */
export function analyticsOptedOut(choice: boolean | null): boolean {
  return choice ?? doNotTrackRequested();
}

export type EventParams = Record<string, string | number>;

let requested = false;
let enabled = false;

/**
 * Events fired before the tag has loaded, since it is fetched on idle and the
 * app is usable well before that. Bounded, because an opted-out session never
 * flushes and a leak here would be unbounded.
 */
const pending: Array<[string, EventParams]> = [];
const MAX_PENDING = 20;

/**
 * Records one event, or holds it until the tag arrives.
 *
 * A buffer rather than a push straight into `dataLayer`, because gtag.js wants
 * `js` and `config` ahead of any event and `setAnalyticsEnabled` is what sends
 * those. Nothing buffered before an opt-out is ever sent.
 */
export function trackEvent(name: string, params: EventParams = {}): void {
  if (typeof window === "undefined") return;

  if (!enabled) {
    if (pending.length < MAX_PENDING) pending.push([name, params]);
    return;
  }
  window.gtag?.("event", name, params);
}

/**
 * Turns collection on or off, fetching the tag on the first `true`.
 *
 * Idempotent in both directions: called at boot with the resolved preference
 * and again on every flip of the Settings switch.
 */
export function setAnalyticsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;

  // Before the fetch, never after: a tag that loaded while the flag was
  // absent has already sent its first page_view.
  (window as unknown as Record<string, boolean>)[DISABLE_FLAG] = !on;
  enabled = on;

  if (!on) {
    pending.length = 0;
    return;
  }

  if (requested) {
    flushPending();
    return;
  }
  requested = true;

  window.dataLayer ??= [];
  // `arguments` rather than a rest array, because gtag.js reads the pushed
  // object positionally and this is the shape Google documents.
  window.gtag ??= function gtag() {
    window.dataLayer!.push(arguments);
  };

  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID);

  const tag = document.createElement("script");
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(tag);

  flushPending();
}

function flushPending(): void {
  for (const [name, params] of pending.splice(0))
    window.gtag?.("event", name, params);
}
