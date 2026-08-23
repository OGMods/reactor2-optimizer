/**
 * Handing the user a file the app made.
 *
 * One helper rather than an inline `<a download>` at each call site, because
 * the two easy-to-miss parts are the same every time: the anchor has to be in
 * the document for Firefox to honour the click, and the object URL has to be
 * revoked afterwards or the blob is pinned in memory for the life of the tab.
 *
 * The revoke is deferred a tick rather than run straight after `click()` —
 * the download is started asynchronously, and pulling the URL out from under
 * it in the same frame is a race some browsers lose.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Turns a name into something every filesystem will take: letters, digits and
 * single dashes, nothing else. Windows rejects half of ASCII punctuation in a
 * filename, and an island the user named "Bob's / island" is otherwise a
 * download that silently fails.
 */
export function toFileSlug(name: string, fallback = "layout"): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}
