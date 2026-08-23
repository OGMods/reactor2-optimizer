"""Tests for the game's compact suffix notation (K/M/B/T then AA..ZZ)."""

import math

from formatters import SUFFIXES, format_for_filename, format_number, parse_huge_number
from tests.helpers import SimulationTestCase


class SuffixTableTests(SimulationTestCase):
    def test_index_n_represents_ten_to_the_three_n(self):
        self.assertEqual(SUFFIXES[0], "")
        self.assertEqual(SUFFIXES[1], "K")
        self.assertEqual(SUFFIXES[4], "T")
        self.assertEqual(SUFFIXES[5], "AA", "the letter pairs start right after T")
        self.assertEqual(SUFFIXES[6], "AB")

    def test_table_covers_the_whole_two_letter_range(self):
        self.assertEqual(len(SUFFIXES), 5 + 26 * 26)


class FormatNumberTests(SimulationTestCase):
    def test_precision_narrows_as_the_mantissa_grows(self):
        self.assertEqual(format_number(1500), "1.50K")     # < 10  -> 2 decimals
        self.assertEqual(format_number(12345), "12.3K")    # < 100 -> 1 decimal
        self.assertEqual(format_number(123456), "123K")    # >= 100 -> integer

    def test_values_below_one_thousand_are_untouched(self):
        self.assertEqual(format_number(0), "0")
        self.assertEqual(format_number(42), "42")
        self.assertEqual(format_number(999), "999")

    def test_large_tiers_use_letter_pairs(self):
        self.assertEqual(format_number(1.5e15), "1.50AA")
        self.assertEqual(format_number(7.17e19), "71.7AB")

    def test_negative_values_keep_their_sign(self):
        self.assertEqual(format_number(-2500), "-2.50K")

    def test_non_finite_values(self):
        self.assertEqual(format_number(float("inf")), "∞")
        self.assertEqual(format_number(float("-inf")), "-∞")
        self.assertEqual(format_number(float("nan")), "NaN")


class ParseHugeNumberTests(SimulationTestCase):
    def test_parses_suffix_notation(self):
        self.assertClose(parse_huge_number("20K"), 20e3)
        self.assertClose(parse_huge_number("1.5AA"), 1.5e15)

    def test_parses_plain_and_exponent_notation(self):
        self.assertClose(parse_huge_number("1.5e30"), 1.5e30)
        self.assertClose(parse_huge_number("2E-3"), 2e-3)
        self.assertClose(parse_huge_number(1234), 1234.0)

    def test_unparseable_input_is_nan(self):
        self.assertTrue(math.isnan(parse_huge_number("not a number")))
        self.assertTrue(math.isnan(parse_huge_number("5ZZZ")))
        self.assertTrue(math.isnan(parse_huge_number("")))

    def test_round_trips_through_format_number(self):
        for value in (1.0, 1500.0, 2.5e6, 7.5e18, 3.2e30):
            with self.subTest(value=value):
                parsed = parse_huge_number(format_number(value))
                # format_number rounds to 3 significant digits.
                self.assertClose(parsed, value, rel=5e-3)


class FormatForFilenameTests(SimulationTestCase):
    """Filenames need two tiers of precision and no '.' in the number."""

    def test_keeps_a_major_and_a_minor_tier(self):
        self.assertEqual(format_for_filename(1.2345e16), "12AA_345T")
        self.assertEqual(format_for_filename(5500), "5K_500")

    def test_omits_the_minor_tier_when_it_is_zero(self):
        self.assertEqual(format_for_filename(5000), "5K")
        self.assertEqual(format_for_filename(42), "42")

    def test_non_positive_and_non_finite_values_collapse_to_zero(self):
        self.assertEqual(format_for_filename(0), "0")
        self.assertEqual(format_for_filename(-5), "0")
        self.assertEqual(format_for_filename(float("nan")), "0")
        self.assertEqual(format_for_filename(float("inf")), "0")

    def test_output_is_filesystem_safe(self):
        for value in (0, 42, 5500, 1.2345e16, 6.38e22):
            with self.subTest(value=value):
                self.assertRegex(format_for_filename(value), r"^[A-Za-z0-9_]+$")
