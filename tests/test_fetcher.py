"""Tests for fetcher.py — API client with mocked HTTP responses."""

import json
import pytest
from unittest.mock import patch, MagicMock

from fetcher import PNCPFetcher, CaptchaDetected


# ── Fixture ──────────────────────────────────────────────────────────────
@pytest.fixture
def fetcher():
    f = PNCPFetcher(rate_limit=0)  # disable throttle in tests
    return f


# ── parse_item_url ───────────────────────────────────────────────────────
class TestParseItemUrl:
    def test_valid(self):
        cnpj, ano, seq = PNCPFetcher.parse_item_url("/compras/12345678000199/2026/42")
        assert cnpj == "12345678000199"
        assert ano == 2026
        assert seq == 42

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            PNCPFetcher.parse_item_url("/invalid/url")


# ── search_processes (mocked) ────────────────────────────────────────────
class TestSearchProcesses:
    def test_search_returns_items_and_total(self, fetcher):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = {
            "items": [{"numero_controle_pncp": "TEST-001"}],
            "total": 1,
        }

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            items, total = fetcher.search_processes("cabo", page=1)
            assert len(items) == 1
            assert total == 1
            assert items[0]["numero_controle_pncp"] == "TEST-001"

    def test_search_empty_results(self, fetcher):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = {"items": [], "total": 0}

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            items, total = fetcher.search_processes("xyznonexistent")
            assert items == []
            assert total == 0


# ── get_items (mocked) ──────────────────────────────────────────────────
class TestGetItems:
    def test_returns_item_list(self, fetcher):
        mock_items = [
            {"numeroItem": 1, "descricao": "CABO FLEXÍVEL", "quantidade": 100},
            {"numeroItem": 2, "descricao": "TOMADA 20A", "quantidade": 50},
        ]
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = mock_items

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            items = fetcher.get_items("12345678000199", 2026, 1)
            assert len(items) == 2
            assert items[0]["descricao"] == "CABO FLEXÍVEL"


# ── get_items_count (mocked) ────────────────────────────────────────────
class TestGetItemsCount:
    def test_returns_count(self, fetcher):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = 14

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            count = fetcher.get_items_count("12345678000199", 2026, 1)
            assert count == 14


# ── CAPTCHA detection ────────────────────────────────────────────────────
class TestCaptchaDetection:
    def test_captcha_raises(self, fetcher):
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_resp.headers = {"Content-Type": "text/html"}
        mock_resp.text = "<html>captcha challenge</html>"

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            with pytest.raises(CaptchaDetected):
                fetcher.search_processes("cabo")


# ── discover_processes (mocked) ─────────────────────────────────────────
class TestDiscoverProcesses:
    def test_uf_filter(self, fetcher):
        page1 = {
            "items": [
                {"numero_controle_pncp": "P1", "uf": "BA", "item_url": "/compras/111/2026/1",
                 "data_publicacao_pncp": "2026-01-15T10:00:00", "orgao_nome": "ORGAO BA"},
                {"numero_controle_pncp": "P2", "uf": "SP", "item_url": "/compras/222/2026/2",
                 "data_publicacao_pncp": "2026-01-15T10:00:00", "orgao_nome": "ORGAO SP"},
            ],
            "total": 2,
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = page1

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            results = fetcher.discover_processes(["cabo"], uf="BA")
            assert len(results) == 1
            assert results[0]["numero_controle_pncp"] == "P1"

    def test_deduplication(self, fetcher):
        page1 = {
            "items": [
                {"numero_controle_pncp": "P1", "uf": "BA", "item_url": "/compras/111/2026/1",
                 "data_publicacao_pncp": "2026-01-15T10:00:00", "orgao_nome": "ORG1"},
            ],
            "total": 1,
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = page1

        with patch.object(fetcher.session, "get", return_value=mock_resp):
            # search two keywords that both find the same process
            results = fetcher.discover_processes(["cabo", "eletrico"], uf="BA")
            assert len(results) == 1
