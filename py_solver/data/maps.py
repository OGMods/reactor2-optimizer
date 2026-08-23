"""
The island maps, as blueprint codes.

Peer: `lib/data/maps.ts`, same format but deliberately NOT the same boards.
The TypeScript side ships the islands as the game hands them out, obstacles and
all, because that is what a player opens the app to. These are the same islands
as *this player has them now*, with the obstacles they have cleared already
cleared, because this tree exists to produce solves for that save. Expect
1-10% of the tiles to differ per island; that is the clearances, not drift.

Compare boards with `blueprint_key()` if you ever need to, never by comparing
the codes: CPython's zlib and the browser's CompressionStream emit different
bytes for the same payload, so equal boards routinely have unequal codes.

A code carries the grid's dimensions in its first two bytes, so a map is just a
number, a name and a code; there is no separate width to drift out of sync with
the terrain. Decode with `blueprint.decode_blueprint()`.

Map 0 is the small "custom" board; 1-8 are the shipped islands, numbered to
match `island1`..`island8` on the TypeScript side -- the same islands, at this
player's stage of the game.
"""

from dataclasses import dataclass
from typing import Dict, List


@dataclass(frozen=True)
class GameMap:
    num: int
    name: str
    code: str


MAPS: List[GameMap] = [
    GameMap(
        num=0,
        name="custom",
        code="eJzj5GJgYGRkBGMQC8RA4kEBI0INI6oaBrgaqHqIFJgGAA9xAEE",
    ),
    GameMap(
        num=1,
        name="island1",
        code="eJzj5WEAA0ZGRgYGOBPOg7AZ2ZA5jCgcRgZmZmQpFmQpDF3IhrOgWosCmFjAFAAuPQB3",
    ),
    GameMap(
        num=2,
        name="island2",
        code="eJzjE2AAA0YGJMDEwoADYEgwMqLyGJGYCB4jI5zLxMiIxGNhQOGi8Rjw8RjYUHioFiK5BQBBawCJ",
    ),
    GameMap(
        num=3,
        name="island3",
        code="eJzj52MAAUYQYIACRijAzofxGNkYGBhYEFyoPC4upmEQMexcRgZGLLrhKpngXDCNMBpMAwBOoACa",
    ),
    GameMap(
        num=4,
        name="island4",
        code="eJyV0UsKwCAMBNCJTT1Bofe_aXGEmh_YzkofajReN5gDv6JtjYUZZ6iTiZEMSkbZGesEGnaqm3Nvg8AsSXUrc9gtxseh2B66VBCVlys6rpk-5f2MBxd7API",
    ),
    GameMap(
        num=5,
        name="island5",
        code="eJyN0FEKACEIBNBmg07Q197_oEFlajmREIkPzPxr0gCAFAVGUFCSdAGKkgffEFtQuMg7RaPb7zvKMrshviYqe-XM_ArX47yJsXmC8kjyiUJfvxpH1ADv",
    ),
    GameMap(
        num=6,
        name="island6",
        code="eJyNkl0OgDAIg-kknkHvf1HjX2ClRPv40XXAtu32CIBJdfxDg1POGLAFuArl8uAoGCCOWXGb4OayIHKafIG7dmKuhfjboE9T8Susmas1VGU-kPad7C7OsW7P0F7_8yMOfjMBFw",
    ),
    GameMap(
        num=7,
        name="island7",
        code="eJx9kFEOwCAIQ9vJdoV97P73XDJUBGFNiOLTgjw3hqi6sIlT_rhGjvwhqo0ZZpYz2dCarJakRiioe43YCwBBhkLvsaz7Vv4mm0ZfmSJWz5pINsQPDnJYf2G-YDP3OZu-CtzVQvWNdmZMfPoC1awBOw",
    ),
    GameMap(
        num=8,
        name="island8",
        code="eJytkVkOgCAMRKcOegnuf0-TqpRufzYhgb7pypwwG_jbRFqgVshlWRdUBjrG5fWo1vt8hf_sG5AjIX29BwwTGdZt70GyWvYJ33-RjFxbz_UK7eldso7F1KHqztKA3fKBFgNkZB_1vkGDUU8bJicDtvo3MUEBZA",
    ),
]

MAPS_BY_NUM: Dict[int, GameMap] = {m.num: m for m in MAPS}

DEFAULT_MAP_NUM = 1
