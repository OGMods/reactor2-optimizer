/**
 * The share *link*: a blueprint code carried in the page URL.
 *
 * A code is the portable thing — it survives a chat window, a forum post and a
 * paste into the Import dialog. A link is the convenient thing: it opens the
 * board rather than describing it. The two are the same payload, and this
 * module is the whole of the difference between them, so nothing else in the
 * app has to know the parameter's name.
 *
 * Arriving with one puts the app in **preview**: a board that is read-only and
 * unsaved until the visitor imports it. See `layoutState.loadPreview`.
 */

/**
 * The query parameter a shared link carries its blueprint in.
 *
 * Deliberately not exported: this module *is* the knowledge of the parameter's
 * name, and a second reader of it somewhere else is exactly the drift it
 * exists to prevent. Everything outside goes through the four functions below.
 */
const SHARE_PARAM = "bp";

/**
 * The code in the current URL, if there is one.
 *
 * Read at startup, before anything is mounted. It is not validated here —
 * whether the string is a *readable* blueprint is `decodeBlueprint`'s answer,
 * and this only reports what the address bar says.
 */
export function readSharedCode(
  location: { search: string } = window.location,
): string | null {
  const code = new URLSearchParams(location.search).get(SHARE_PARAM);
  return code && code.trim() ? code.trim() : null;
}

/**
 * Builds the link for a code, against wherever the app is being served from.
 *
 * Origin and path come from the live location rather than a configured base,
 * because this app ships to a GitHub Pages subpath (`vite.config.ts` sets
 * `base: "./"`) and to a dev server on localhost, and a link that is right in
 * one and wrong in the other is worse than no link. Any existing query or
 * fragment is dropped: a link built while previewing someone else's board must
 * not carry their code alongside the new one.
 */
export function buildShareUrl(
  code: string,
  location: { origin: string; pathname: string } = window.location,
): string {
  if (!code) return "";
  const params = new URLSearchParams({ [SHARE_PARAM]: code });
  return `${location.origin}${location.pathname}?${params}`;
}

/**
 * Drops the share parameter from the address bar, leaving the rest of the URL
 * alone.
 *
 * Called when the visitor leaves preview — by exiting it or by importing the
 * board as their own. `replaceState` rather than `pushState`, because the
 * parameter is not a place the Back button should return to: going back to it
 * would drop the user into the preview they just chose to leave.
 */
export function clearSharedCode(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SHARE_PARAM)) return;
  url.searchParams.delete(SHARE_PARAM);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}
