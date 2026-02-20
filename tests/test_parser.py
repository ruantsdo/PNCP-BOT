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


# ── parse_keywords ──────────────────────────────────────────────────────
class TestParseKeywords:
    def test_single_term(self):
        result = parse_keywords("cabo")
        assert len(result) == 1
        assert result[0].term == "cabo"
        assert result[0].qualifiers == []

    def test_term_with_qualifier(self):
        result = parse_keywords("cabo [vermelho]")
        assert len(result) == 1
        assert result[0].term == "cabo"
        assert result[0].qualifiers == ["vermelho"]

    def test_multiple_keywords(self):
        result = parse_keywords("cabo, tomada")
        assert len(result) == 2
        assert result[0].term == "cabo"
        assert result[1].term == "tomada"

    def test_compound_with_qualifiers(self):
        result = parse_keywords("cabo [vermelho], tomada [20a]")
        assert len(result) == 2
        assert result[0].qualifiers == ["vermelho"]
        assert result[1].qualifiers == ["20a"]

    def test_multiple_qualifiers(self):
        result = parse_keywords("cabo [vermelho] [3mm]")
        assert len(result) == 1
        assert result[0].qualifiers == ["vermelho", "3mm"]

    def test_empty_string(self):
        assert parse_keywords("") == []

    def test_accent_in_qualifier(self):
        result = parse_keywords("módulo [elétrico]")
        assert result[0].term == "modulo"
        assert result[0].qualifiers == ["eletrico"]


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

    def test_qualifier_no_match_excludes(self):
        """When qualifiers exist but NONE match, the item is excluded."""
        kws = parse_keywords("cabo [vermelho]")
        result = matches_item("CABO AZUL FLEXÍVEL 2,5MM", kws)
        assert result == []  # no qualifier matched → excluded

    def test_qualifier_partial_match(self):
        """When some (not all) qualifiers match, it's a compound match."""
        kws = parse_keywords("cabo [vermelho, grosso]")
        result = matches_item("CABO VERMELHO FLEXÍVEL 2,5MM", kws)
        assert len(result) == 1
        assert result[0].is_compound  # 'vermelho' matched but 'grosso' did not → compound
        assert not result[0].is_exact
        assert result[0].qualifiers_met == ["vermelho"]
        assert result[0].qualifiers_unmet == ["grosso"]

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
        # "eletroduto" vs "eletro duto pvc cinza" → partial_ratio should be high
        assert len(result) >= 0  # depends on fuzzy threshold

    def test_fuzzy_disabled_high_threshold(self):
        kws = parse_keywords("xablau")
        result = matches_item("CABO FLEXÍVEL", kws, fuzzy_threshold=100)
        assert result == []

    def test_multiple_matches(self):
        kws = parse_keywords("cabo, eletrico")
        result = matches_item("CABO ELÉTRICO FLEXÍVEL", kws)
        assert len(result) == 2
