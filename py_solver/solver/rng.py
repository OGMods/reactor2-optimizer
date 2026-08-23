"""
Deterministic, portable PRNG for the solver's stochastic stages.

`random.Random` (Mersenne Twister) would be fine for Python alone, but this
solver is the reference implementation for a JS port, and `Math.random()` is
not seedable -- the port needs its own generator either way. mulberry32 is
used so both sides can share one: its canonical implementation is four lines
of JS, and every operation below maps 1:1 onto JS int32/uint32 semantics
(`Math.imul`, `>>>`), so the two implementations produce bit-identical
streams for the same seed. That makes a seeded Python run replayable in the
port and vice versa.

Canonical JS counterpart:

    function mulberry32(a) {
      return function() {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

`choice`/`shuffle` derive indices via `int(random() * n)` rather than modulo
so the JS side can use `Math.floor(rng() * n)` unchanged; both languages use
IEEE doubles, so the results match exactly.

`tests/test_rng.py` pins the first outputs of several seeds; those golden
values were cross-checked against the JS reference above under Node.
"""

from typing import MutableSequence, Sequence, TypeVar

_MASK = 0xFFFFFFFF

T = TypeVar("T")


class Rng:
    """mulberry32 with the few draw helpers the search actually uses."""

    def __init__(self, seed: int):
        self._state = seed & _MASK

    def random(self) -> float:
        """Next float in [0, 1), bit-identical to the JS reference."""
        self._state = (self._state + 0x6D2B79F5) & _MASK
        t = self._state
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
        t = (t ^ (t + (((t ^ (t >> 7)) * (t | 61)) & _MASK))) & _MASK
        return ((t ^ (t >> 14)) & _MASK) / 4294967296.0

    def choice(self, seq: Sequence[T]) -> T:
        return seq[int(self.random() * len(seq))]

    def shuffle(self, seq: MutableSequence[T]) -> None:
        """Fisher-Yates, consuming one draw per element after the first."""
        for i in range(len(seq) - 1, 0, -1):
            j = int(self.random() * (i + 1))
            seq[i], seq[j] = seq[j], seq[i]
