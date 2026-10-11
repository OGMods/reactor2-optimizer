/**
 * The byte plumbing both wire formats share: `blueprint.ts` (the optimizer's
 * own layout codes) and `gameExport.ts` (the code the game's Export to
 * Optimizer button writes). Not re-exported from the package entry point — it
 * is an implementation detail of the two codecs, not part of either format.
 */

/**
 * Runs `bytes` through a transform stream and collects the result.
 *
 * Note the shape: the payload is piped in from a Blob and the whole stream is
 * handed to `Response`, so reading and writing are driven together. Grabbing a
 * writer and awaiting `write()`/`close()` before starting to read — the
 * obvious-looking version — deadlocks: `close()` cannot settle until the
 * readable side is drained, and nothing is draining it yet.
 */
export async function pipeThrough(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export function base64UrlToUint8Array(code: string): Uint8Array<ArrayBuffer> {
  let base64 = code.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
