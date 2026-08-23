"""
Compact number formatting for the console report and for solve filenames.

The game shows huge figures with a two-letter suffix ladder (K, M, B, T,
then AA, AB, ...); `format_number` reproduces it so the solver's output can
be read against the game's own UI. Peer: `lib/utils/formatters.ts`.
"""

import math
import re
import string
from typing import List, Union

# ---------------------------------------------------------------------------
# Suffix table
# ---------------------------------------------------------------------------
LETTERS = string.ascii_uppercase


def _build_suffixes() -> List[str]:
    list_suffixes = ["", "K", "M", "B", "T"]
    for c1 in LETTERS:
        for c2 in LETTERS:
            list_suffixes.append(c1 + c2)
    return list_suffixes


SUFFIXES = _build_suffixes()  # index n -> represents 10^(3n)
SUFFIX_MAP = {suffix: idx for idx, suffix in enumerate(SUFFIXES)}


# ---------------------------------------------------------------------------
# format_number
# ---------------------------------------------------------------------------
def format_number(n: float) -> str:
    """
    Formats a (possibly huge) number to a compact string like:
      0        -> "0"
      1500     -> "1.50K"
      1.5e15   -> "1.50AA"
      7.17e19  -> "71.7AB"

    Precision rules:
      value >= 100 -> integer   (e.g. "123K")
      value >= 10  -> 1 decimal (e.g. "12.3K")
      otherwise    -> 2 decimals(e.g. "1.23K")
    """
    if n == 0:
        return "0"
    if math.isinf(n):
        return "∞" if n > 0 else "-∞"
    if math.isnan(n):
        return "NaN"

    neg = n < 0
    abs_val = abs(n)

    # Tier index: each tier is 1000x the previous
    tier_idx = math.floor(math.log10(abs_val) / 3)
    clamped = max(0, min(tier_idx, len(SUFFIXES) - 1))

    if clamped == 0:
        raw = round(float(abs_val), 2)
        raw_str = f"{int(raw)}" if raw.is_integer() else f"{raw}"
        return f"-{raw_str}" if neg else raw_str

    divisor = 10.0 ** (clamped * 3)
    val = abs_val / divisor

    if val >= 100:
        formatted = str(round(val))
    elif val >= 10:
        formatted = f"{round(val, 1):.1f}"
    else:
        formatted = f"{round(val, 2):.2f}"

    prefix = "-" if neg else ""
    return f"{prefix}{formatted}{SUFFIXES[clamped]}"


# ---------------------------------------------------------------------------
# parse_huge_number
# ---------------------------------------------------------------------------
def parse_huge_number(input_val: Union[str, float, int]) -> float:
    """
    Parses a number from either:
      - Standard Python float/int or e-notation: "1.5e30", "2E-3"
      - Suffix notation: "1.5AA", "20K", "3.14B"

    Returns float('nan') if string is unparseable.
    """
    if isinstance(input_val, (int, float)):
        return float(input_val)

    s = str(input_val).strip().upper()
    if not s or s == "NAN":
        return float("nan")

    # Plain float or standard e/E notation (e.g. "1.5E30")
    try:
        return float(s)
    except ValueError:
        pass

    # Number + suffix (e.g. "1.5AA", "20K")
    match = re.match(r"^(-?[\d.]+)\s*([A-Z]+)$", s)
    if not match:
        return float("nan")

    try:
        num = float(match[1])
    except ValueError:
        return float("nan")

    suffix = match[2]
    if suffix not in SUFFIX_MAP:
        return float("nan")

    idx = SUFFIX_MAP[suffix]
    return num * (10.0 ** (idx * 3))


# ---------------------------------------------------------------------------
# format_for_filename
# ---------------------------------------------------------------------------
def format_for_filename(n: float) -> str:
    """
    Formats a power value for use in a filename, keeping two tiers of precision
    and no characters that need escaping (e.g. 12.3456e15 -> "12AF_345AE").
    """
    if n <= 0 or math.isnan(n) or math.isinf(n):
        return "0"

    tier_idx = math.floor(math.log10(n) / 3)
    clamped_tier = max(0, min(tier_idx, len(SUFFIXES) - 1))

    major_divisor = 10.0 ** (clamped_tier * 3)
    major_val = int(n // major_divisor)
    major_suffix = SUFFIXES[clamped_tier]

    remainder = n - (major_val * major_divisor)

    if clamped_tier == 0:
        minor_val = int(remainder)
        return f"{major_val}_{minor_val}" if minor_val > 0 else f"{major_val}"

    minor_tier = clamped_tier - 1
    minor_val = int(remainder // (10.0 ** (minor_tier * 3)))
    if minor_val > 0:
        return f"{major_val}{major_suffix}_{minor_val}{SUFFIXES[minor_tier]}"
    return f"{major_val}{major_suffix}"
