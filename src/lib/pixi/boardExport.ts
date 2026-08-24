/**
 * The two fixed figures of the PNG export. Shared because Settings names the
 * cap in its hint, and a second copy of the number is a thing to get wrong.
 */

/**
 * How much of the board's own green frames the picture, in board pixels.
 * Enough that the outermost tiles are not cut flush against the edge; small
 * enough that a one-island board is not mostly margin.
 */
export const EXPORT_PADDING_PX = 32;

/**
 * The largest side an exported picture may have.
 *
 * The extract renders into a single render texture, and both WebGL and WebGPU
 * cap how big one may be — past the 4096 some mobile GPUs report it comes back
 * blank rather than large. The chosen scale is backed off to fit rather than
 * the picture being cropped.
 */
export const EXPORT_MAX_SIDE_PX = 4096;
