/**
 * Which set of buildings the canvas draws when both exist: the ones the user
 * placed by hand, or the ones the last solve produced. Only ever a choice
 * while a solve result is around — with none, there is only the user's board.
 */
export type PlacementView = "user" | "solver";
