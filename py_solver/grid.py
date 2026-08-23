"""
Tile predicates and the ASCII tile alphabet.

- `count_grass_tiles` / `is_island_tile` -- used by the solver and the
  renderer. Their TS equivalents live in `lib/solver/island.ts`.
- `TILE_CHAR_MAP` -- the alphabet tests are written in, via
  `tests.helpers.make_grid(["GGG", "G.G"])`, and the character table
  `parity/export_fixtures.py` writes its fixtures with.

The wire format is a blueprint code -- see `blueprint.py` and its peer
`lib/encoding/blueprint.ts`. Nothing here decodes one.
"""

from typing import Dict, List, Optional

from solver.types import Tile

# Tile character -> tile type. Only "grass" is buildable; every other type is
# scenery that blocks placement.
TILE_CHAR_MAP: Dict[str, str] = {
    ".": "water",
    "G": "grass",
    "R": "rock",
    "T": "tree1",
    "U": "tree2",
    "O": "pond",
    "X": "transformer",
}


def is_island_tile(tile: Optional[Tile]) -> bool:
    """True for any land tile (buildable or scenery), i.e. anything but water."""
    return tile is not None and tile.type != "water"


def count_grass_tiles(grid: List[List[Tile]]) -> int:
    return sum(1 for row in grid for tile in row if tile.type == "grass")
