"""Tests for exporter.py — JSON / CSV output structure."""

import json
import csv
import pytest
from pathlib import Path

from exporter import build_record, export_json, export_csv, FIELDS


# ── Fixtures ─────────────────────────────────────────────────────────────
@pytest.fixture
def sample_process():
    return {
        "numero_controle_pncp": "12345678000199-1-000010/2026",
        "orgao_nome": "MUNICIPIO TESTE",
        "orgao_cnpj": "12345678000199",
        "ano": "2026",
        "numero_sequencial": "10",
        "data_publicacao_pncp": "2026-02-14T10:00:00",
    }


@pytest.fixture
def sample_item():
    return {
        "numeroItem": 3,
        "descricao": "CABO FLEXÍVEL 2,5MM VERMELHO",
        "quantidade": 100.0,
        "unidadeMedida": "Metro",
        "valorUnitarioEstimado": 1.50,
        "valorTotal": 150.00,
        "temResultado": False,
    }


@pytest.fixture
def sample_record(sample_process, sample_item):
    from parser import parse_keywords, matches_item
    kws = parse_keywords("cabo [vermelho]")
    # Run through matches_item to get MatchResult objects (like the real pipeline)
    matched = matches_item(sample_item["descricao"], kws)
    return build_record(sample_process, sample_item, matched)


# ── build_record ─────────────────────────────────────────────────────────
class TestBuildRecord:
    def test_all_fields_present(self, sample_record):
        for field in FIELDS:
            assert field in sample_record, f"Missing field: {field}"

    def test_values(self, sample_record):
        assert sample_record["process_id"] == "12345678000199-1-000010/2026"
        assert sample_record["item_id"] == 3
        assert sample_record["quantidade"] == 100.0
        assert sample_record["valor_unitario"] == 1.50
        assert sample_record["contratante"] == "MUNICIPIO TESTE"
        assert sample_record["status"] == "pending"

    def test_source_url(self, sample_record):
        assert "pncp.gov.br" in sample_record["source_url"]
        assert "12345678000199" in sample_record["source_url"]


# ── export_json ──────────────────────────────────────────────────────────
class TestExportJson:
    def test_creates_file(self, sample_record, tmp_path):
        path = export_json([sample_record], str(tmp_path))
        assert Path(path).exists()

        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        assert len(data) == 1
        assert data[0]["process_id"] == sample_record["process_id"]


# ── export_csv ───────────────────────────────────────────────────────────
class TestExportCsv:
    def test_creates_file(self, sample_record, tmp_path):
        path = export_csv([sample_record], str(tmp_path))
        assert Path(path).exists()

        with open(path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        assert len(rows) == 1
        assert rows[0]["process_id"] == sample_record["process_id"]
        assert rows[0]["descricao"] == sample_record["descricao"]

    def test_headers_match_fields(self, sample_record, tmp_path):
        path = export_csv([sample_record], str(tmp_path))
        with open(path, encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            headers = next(reader)
        assert headers == FIELDS
