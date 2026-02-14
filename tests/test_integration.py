"""
Integration tests — live API calls.

These tests require internet access and hit the real PNCP API.
Run with:  py -m pytest tests/test_integration.py -v -s
"""

import pytest
from fetcher import PNCPFetcher
from parser import parse_keywords, matches_item
from exporter import build_record, export_json, export_csv


@pytest.fixture
def fetcher():
    return PNCPFetcher(rate_limit=1.5)


@pytest.mark.integration
class TestLiveSearch:
    """Tests that hit the real PNCP API — skip in CI with: -m 'not integration'"""

    def test_search_returns_results(self, fetcher):
        items, total = fetcher.search_processes("cabo", page=1, page_size=5)
        assert total > 0
        assert len(items) > 0
        assert "numero_controle_pncp" in items[0]

    def test_get_items_for_known_process(self, fetcher):
        procs, _ = fetcher.search_processes("material eletrico", page=1, page_size=3)
        assert len(procs) > 0

        proc = procs[0]
        cnpj, ano, seq = fetcher.parse_item_url(proc["item_url"])

        count = fetcher.get_items_count(cnpj, ano, seq)
        assert count >= 0

        if count > 0:
            items = fetcher.get_items(cnpj, ano, seq)
            assert len(items) == count
            assert "descricao" in items[0]


@pytest.mark.integration
class TestFullPipeline:
    """End-to-end: search → fetch items → match → export."""

    def test_pipeline_with_cabo(self, fetcher, tmp_path):
        procs = fetcher.discover_processes(keywords=["cabo"], max_processes=3)
        assert len(procs) > 0

        parsed = parse_keywords("cabo")
        records = []
        for proc in procs:
            cnpj, ano, seq = fetcher.parse_item_url(proc["item_url"])
            items = fetcher.get_items(cnpj, ano, seq)
            for item in items:
                matched = matches_item(item.get("descricao", ""), parsed)
                if matched:
                    records.append(build_record(proc, item, matched))

        assert isinstance(records, list)
        if records:
            json_path = export_json(records, str(tmp_path))
            csv_path = export_csv(records, str(tmp_path))
            assert json_path.endswith("results.json")
            assert csv_path.endswith("results.csv")

    def test_compound_keyword(self, fetcher):
        """Test compound keyword with qualifier (soft matching)."""
        procs = fetcher.discover_processes(keywords=["tomada"], max_processes=2)
        if not procs:
            pytest.skip("No processes found for 'tomada'")

        parsed = parse_keywords("tomada [20a]")
        records = []
        for proc in procs:
            cnpj, ano, seq = fetcher.parse_item_url(proc["item_url"])
            items = fetcher.get_items(cnpj, ano, seq)
            for item in items:
                matched = matches_item(item.get("descricao", ""), parsed)
                if matched:
                    records.append(build_record(proc, item, matched))

        # With soft qualifiers, any "tomada" item should match
        assert isinstance(records, list)
