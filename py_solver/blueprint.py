"""
Binary layout codec -- terrain *and* buildings in one payload.

Peer: `lib/encoding/blueprint.ts`. This is the wire format for maps, saved
layouts and share codes on both sides.

Wire format, before deflate + base64url:

    byte 0        grid width
    byte 1        grid height
    byte 2..      one byte per tile, row-major
    [tier table]  optional, see below

Each tile byte is either a terrain id (0-6) or a building id (10+). A building
byte implies the tile beneath it is grass, which is the only terrain a building
can stand on -- that is what lets one byte carry both layers.

Width and height are one byte each, so this tops out at a 255x255 grid.

THE TIER TABLE
--------------
A tile byte says *which* building stands there but not what it is rated for,
and the same layout at tier 1 and at tier 8 is two very different boards. So a
code may carry one more section after the tiles:

    byte 2+w*h    n -- how many entries follow
    then n pairs  [building byte][upgrade index]

One entry **per building id, not per tile**: every placement of a given
building on a board is at the same tier, because a placement's tier is read
from the player's unlock level and they are all re-read together.

The section is optional in both directions, which is what makes it a backward-
and forward-compatible addition: a code written before it existed simply ends
after the tiles, and a reader that predates it stops there too (the length
check was always `>=`, never `==`). An empty table means "tiers unknown", and
the caller resolves them from the player's own unlocks -- which is exactly what
every reader did before the table existed.

It is written for share codes only. A saved layout deliberately carries no
tiers: that board is the player's own and is meant to pick up upgrades bought
since it was saved.

TWO THINGS THAT MUST STAY TRUE ACROSS THE TREES
-----------------------------------------------
1. The byte tables below must match `lib/encoding/blueprint.ts` exactly. A code
   written by one side is read by the other, so a renumbered building silently
   turns into a different building rather than an error. `tests/test_blueprint.py`
   pins the tables against the TypeScript source.

2. **Codes are not comparable, payloads are.** DEFLATE only guarantees that a
   stream round-trips; nothing requires two implementations to emit identical
   bytes for identical input, and CPython's zlib and the browser's
   `CompressionStream` do in fact differ. To ask "are these two layouts the
   same?", compare `blueprint_key()` -- the uncompressed payload -- never the
   encoded string. `lib/encoding/blueprint.ts` carries the same warning.
"""

import base64
import zlib
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from solver.types import Tile

# Terrain ids. Buildings start at 10 so the two ranges never collide.
_TILE_BYTE_MAP: Dict[str, int] = {
    "water": 0,
    "grass": 1,
    "rock": 2,
    "tree1": 3,
    "tree2": 4,
    "pond": 5,
    "transformer": 6,
}

_BUILDING_BYTE_MAP: Dict[str, int] = {
    # Coolers (10-16)
    "cooler1": 10, "cooler2": 11, "cooler3": 12, "cooler4": 13,
    "cooler5": 14, "cooler6": 15, "cooler7": 16,

    # Generators (20-26)
    "generator": 20, "generator2": 21, "generator3": 22, "generator4": 23,
    "generator5": 24, "generator6": 25, "generator7": 26,

    # Heat Producers (30-53)
    "wind_turbine": 30, "solar_panel": 31, "coal_plant": 32, "hydro_plant": 33,
    "gas_plant": 34, "heliothermal_plant": 35, "geothermal_plant": 36,
    "biomass_plant": 37, "nuclear_reactor": 38, "fusion_reactor": 39,
    "arc_reactor": 40, "antimatter_plant": 41, "quantum_reactor": 42,
    "gravitron_plant": 43, "black_hole_reactor": 44, "hyper_space_core": 45,
    "zero_point_reactor": 46, "divine_reactor": 47, "chaos_core": 48,
    "psionic_tower": 49, "sauron_eye": 50, "neuro_grid_reactor": 51,
    "flux_reactor": 52, "doomStar_reactor": 53,
}

_REV_TILE_BYTE_MAP: Dict[int, str] = {v: k for k, v in _TILE_BYTE_MAP.items()}
_REV_BUILDING_BYTE_MAP: Dict[int, str] = {v: k for k, v in _BUILDING_BYTE_MAP.items()}


@dataclass(frozen=True)
class BlueprintPlacement:
    """
    The part of a placement the wire format carries.

    Everything else on a `PlacedBuilding` (power, heat, cooling) is derived by
    the simulator from the grid and the player's unlock levels, so encoding it
    would only let it go stale.
    """

    x: int
    y: int
    building_id: str


@dataclass(frozen=True)
class DecodedBlueprint:
    width: int
    height: int
    grid: List[List[Tile]]
    placements: List[BlueprintPlacement] = field(default_factory=list)
    #: building id -> upgrade index, where the code says so. Empty means the
    #: code carries no tier table, not that everything is at tier 0.
    tiers: Dict[str, int] = field(default_factory=dict)


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _base64url_decode(code: str) -> bytes:
    padded = code + "=" * (-len(code) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _build_payload(
    grid: Sequence[Sequence[Tile]],
    placements: Iterable[BlueprintPlacement] = (),
    tiers: Optional[Dict[str, int]] = None,
) -> bytes:
    """
    Builds the uncompressed payload.

    The tier table is written only for building bytes that actually reached the
    board -- a placement whose id the catalogue does not carry never gets a tile
    byte, so a tier for it would describe nothing. Passing no `tiers` at all
    reproduces the pre-table payload byte for byte, which is what lets
    `blueprint_key` keep its meaning.
    """
    height = len(grid)
    width = len(grid[0])
    payload = bytearray(2 + width * height)

    payload[0] = width
    payload[1] = height

    placed_at: Dict[Tuple[int, int], str] = {
        (p.x, p.y): p.building_id for p in placements
    }

    # Building bytes as they land on the board, so the table is deterministic:
    # two encodes of the same board must produce one payload.
    placed_bytes = set()

    for y in range(height):
        for x in range(width):
            building_id = placed_at.get((x, y))
            byte: Optional[int] = (
                None if building_id is None else _BUILDING_BYTE_MAP.get(building_id)
            )
            if byte is None:
                byte = _TILE_BYTE_MAP.get(grid[y][x].type, _TILE_BYTE_MAP["water"])
            else:
                placed_bytes.add(byte)
            payload[2 + (y * width + x)] = byte

    if tiers:
        table = bytearray()
        for byte in sorted(placed_bytes):
            level = tiers.get(_REV_BUILDING_BYTE_MAP[byte])
            if level is None:
                continue
            table.append(byte)
            table.append(max(0, min(255, int(level))))
        if table:
            payload.append(len(table) // 2)
            payload.extend(table)

    return bytes(payload)


def blueprint_key(
    grid: Sequence[Sequence[Tile]],
    placements: Iterable[BlueprintPlacement] = (),
) -> bytes:
    """
    A deterministic identity for a layout -- the uncompressed payload.

    Use this, never the encoded code, to test whether two layouts are the same;
    see the module docstring. Peer: `blueprintKey()` in `blueprint.ts`, which
    returns the same bytes as a string.

    Tiers are deliberately not part of it: this answers "is this the same
    layout?", and that means the arrangement, not what the roster currently
    rates it at.
    """
    if not grid or not grid[0]:
        return b""
    return _build_payload(grid, placements)


def encode_blueprint(
    grid: Sequence[Sequence[Tile]],
    placements: Iterable[BlueprintPlacement] = (),
    tiers: Optional[Dict[str, int]] = None,
) -> str:
    """
    Encodes grid terrain and building placements into a URL-safe string.

    Pass `tiers` to record what each building was rated for -- share codes do,
    saved layouts do not; see the module docstring.
    """
    if not grid or not grid[0]:
        return ""
    return _base64url_encode(
        zlib.compress(_build_payload(grid, placements, tiers))
    )


def decode_blueprint(code: str) -> DecodedBlueprint:
    """
    Decodes a blueprint code back into a grid and its placements.

    Raises `ValueError` if the code is not a readable blueprint -- callers
    handling untrusted input (pasted share codes) should catch rather than
    assume.
    """
    if not code:
        return DecodedBlueprint(
            width=0, height=0, grid=[], placements=[], tiers={}
        )

    try:
        data = zlib.decompress(_base64url_decode(code))
    except Exception as err:  # binascii.Error, zlib.error
        raise ValueError(f"Not a readable blueprint code: {err}") from err

    if len(data) < 2:
        raise ValueError("Blueprint payload is truncated or malformed")

    width, height = data[0], data[1]
    if not width or not height or len(data) < 2 + width * height:
        raise ValueError("Blueprint payload is truncated or malformed")

    grid: List[List[Tile]] = []
    placements: List[BlueprintPlacement] = []

    for y in range(height):
        row: List[Tile] = []
        for x in range(width):
            byte_val = data[2 + (y * width + x)]
            building_id = _REV_BUILDING_BYTE_MAP.get(byte_val)

            if building_id is not None:
                # A building byte implies grass underneath.
                row.append(Tile(x=x, y=y, type="grass"))
                placements.append(BlueprintPlacement(x=x, y=y, building_id=building_id))
            else:
                row.append(
                    Tile(x=x, y=y, type=_REV_TILE_BYTE_MAP.get(byte_val, "water"))
                )
        grid.append(row)

    # The tier table, if this code carries one. Everything here is optional and
    # bounds-checked: a code from an older build simply ends at the tiles, and
    # one truncated mid-table gives up the rest of the table rather than the
    # whole layout -- the tiles are the part that cannot be reconstructed, and
    # they have already been read.
    tiers: Dict[str, int] = {}
    table_at = 2 + width * height
    if len(data) > table_at:
        for i in range(data[table_at]):
            at = table_at + 1 + i * 2
            if at + 1 >= len(data):
                break
            building_id = _REV_BUILDING_BYTE_MAP.get(data[at])
            if building_id is not None:
                tiers[building_id] = data[at + 1]

    return DecodedBlueprint(
        width=width,
        height=height,
        grid=grid,
        placements=placements,
        tiers=tiers,
    )
