/**
 * Which set of buildings the canvas draws when both exist: the ones the user
 * placed by hand, or the ones the last solve produced. Only ever a choice
 * while a solve result is around — with none, there is only the user's board.
 */
export type PlacementView = "user" | "solver";

/**
 * How far the saved PNG is scaled above the board's authored sprite size.
 * A closed set rather than a number, so a stored value cannot reach the
 * renderer as a resolution it refuses.
 *
 * 2x is where the export used to be fixed, and it is the ceiling rather than
 * the default: it puts a large board past 5MB, which is most of the reason
 * this is a setting at all.
 */
export type ImageScale = 1 | 2;
