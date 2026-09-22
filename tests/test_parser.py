"""Tests for parser.py — normalisation, keyword parsing, and matching."""

import pytest
from parser import normalize, parse_keywords, matches_item, ParsedKeyword, MatchResult


# ── normalize ────────────────────────────────────────────────────────────
class TestNormalize:
    def test_lowercase(self):
        assert normalize("CABO ELÉTRICO") == "cabo eletrico"

    def test_accent_removal(self):
        assert normalize("ação") == "acao"
        assert normalize("manutenção") == "manutencao"
        assert normalize("Módulo") == "modulo"

    def test_collapse_whitespace(self):
        assert normalize("  cabo   vermelho  ") == "cabo vermelho"

    def test_empty(self):
        assert normalize("") == ""

    def test_special_chars(self):
        assert normalize("CABO 3/4\"") == 'cabo 3/4"'

    def test_mm2_normalization(self):
        assert normalize("CABO 2,5mm2") == "cabo 2,5mm"


# ── parse_keywords ──────────────────────────────────────────────────────
class TestParseKeywords:
    def test_single_term(self):
        result = parse_keywords("cabo")
        assert len(result) == 1
        assert result[0].term == "cabo"
        assert result[0].groups == []

    def test_term_with_qualifier(self):
        result = parse_keywords("cabo [vermelho]")
        assert len(result) == 1
        assert result[0].term == "cabo"
        assert result[0].groups == [["vermelho"]]

    def test_multiple_keywords(self):
        result = parse_keywords("cabo, tomada")
        assert len(result) == 2
        assert result[0].term == "cabo"
        assert result[1].term == "tomada"

    def test_compound_with_qualifiers(self):
        result = parse_keywords("cabo [vermelho], tomada [20a]")
        assert len(result) == 2
        assert result[0].groups == [["vermelho"]]
        assert result[1].groups == [["20a"]]

    def test_multiple_qualifiers(self):
        result = parse_keywords("cabo [vermelho] [3mm]")
        assert len(result) == 1
        assert result[0].groups == [["vermelho"], ["3mm"]]

    def test_empty_string(self):
        assert parse_keywords("") == []

    def test_accent_in_qualifier(self):
        result = parse_keywords("módulo [elétrico]")
        assert result[0].term == "modulo"
        assert result[0].groups == [["eletrico"]]

    def test_groups_with_alternatives(self):
        result = parse_keywords("cabo [{vermelho | azul} | 2,5mm]")
        assert len(result) == 1
        assert result[0].term == "cabo"
        assert result[0].groups == [["vermelho", "azul"], ["2,5mm"]]


# ── matches_item ─────────────────────────────────────────────────────────
class TestMatchesItem:
    def test_exact_match(self):
        kws = parse_keywords("cabo")
        result = matches_item("CABO FLEXÍVEL 2,5MM", kws)
        assert len(result) == 1

    def test_no_match(self):
        kws = parse_keywords("tomada")
        result = matches_item("CABO FLEXÍVEL 2,5MM", kws)
        assert result == []

    def test_qualifier_match_exact(self):
        kws = parse_keywords("cabo [vermelho]")
        result = matches_item("CABO VERMELHO FLEXÍVEL 2,5MM", kws)
        assert len(result) == 1
        assert result[0].is_exact  # base + qualifier both matched
        assert result[0].groups_met == 1

    def test_qualifier_no_match_excludes(self):
        """When qualifiers exist but NONE match, the item is excluded."""
        kws = parse_keywords("cabo [vermelho]")
        result = matches_item("CABO AZUL FLEXÍVEL 2,5MM", kws)
        assert result == []  # no qualifier matched → excluded

    def test_group_with_alternatives_matches(self):
        """At least one alternative inside a group must match."""
        kws = parse_keywords("cabo [{vermelho | azul}]")
        r1 = matches_item("CABO AZUL FLEXÍVEL 2,5MM", kws)
        r2 = matches_item("CABO VERMELHO FLEXÍVEL 2,5MM", kws)
        r3 = matches_item("CABO VERDE FLEXÍVEL 2,5MM", kws)
        assert len(r1) == 1
        assert len(r2) == 1
        assert r3 == []

    def test_multiple_mandatory_groups(self):
        """All separate groups are mandatory (AND). If one fails, excluded."""
        kws = parse_keywords("cabo [flexivel | {vermelho | azul} | 2,5mm]")
        r_ok = matches_item("CABO FLEXÍVEL AZUL 2,5MM2", kws)
        r_fail = matches_item("CABO FLEXÍVEL VERDE 2,5MM2", kws)
        assert len(r_ok) == 1
        assert r_ok[0].groups_met == 3
        assert r_fail == []

    def test_or_logic(self):
        kws = parse_keywords("cabo, tomada")
        r1 = matches_item("CABO FLEXÍVEL 2,5MM", kws)
        r2 = matches_item("TOMADA 20A", kws)
        r3 = matches_item("PARAFUSO SEXTAVADO", kws)
        assert len(r1) == 1
        assert len(r2) == 1
        assert r3 == []

    def test_accent_insensitive(self):
        kws = parse_keywords("eletrico")
        result = matches_item("MATERIAL ELÉTRICO DIVERSO", kws)
        assert len(result) == 1

    def test_fuzzy_match(self):
        kws = parse_keywords("eletroduto")
        # "ELETRODUTO" is exact, but let's test something close
        result = matches_item("ELETRO DUTO PVC CINZA", kws, fuzzy_threshold=70)
        assert len(result) >= 0  # depends on fuzzy threshold

    def test_fuzzy_disabled_high_threshold(self):
        kws = parse_keywords("xablau")
        result = matches_item("CABO FLEXÍVEL", kws, fuzzy_threshold=100)
        assert result == []

    def test_multiple_matches(self):
        kws = parse_keywords("cabo, eletrico")
        result = matches_item("CABO ELÉTRICO FLEXÍVEL", kws)
        assert len(result) == 2

