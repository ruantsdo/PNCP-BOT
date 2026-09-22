"""Unit tests for search cancellation and partial results preservation."""

import pytest
from unittest.mock import patch, MagicMock
from pipeline import ExtractionParams, run_extraction, ExtractionResult
from fetcher import PNCPFetcher
from webapp import app, jobs


class TestCancellation:
    """Test cancellation in pipeline and fetcher."""

    def test_fetcher_discover_processes_cancelled_immediately(self):
        fetcher = PNCPFetcher()
        is_cancelled = lambda: True
        results = fetcher.discover_processes(["cabo"], is_cancelled=is_cancelled)
        assert results == []

    @patch("fetcher.PNCPFetcher.search_processes")
    def test_fetcher_discover_processes_cancelled_midway(self, mock_search):
        fetcher = PNCPFetcher()
        mock_search.return_value = ([
            {"numero_controle_pncp": "111", "data_publicacao_pncp": "2026-01-01"},
            {"numero_controle_pncp": "222", "data_publicacao_pncp": "2026-01-01"},
        ], 2)
        
        call_count = 0
        def check_cancel():
            nonlocal call_count
            call_count += 1
            return call_count > 2

        results = fetcher.discover_processes(["cabo", "fio"], is_cancelled=check_cancel)
        assert len(results) <= 2

    @patch("pipeline.PNCPFetcher")
    def test_pipeline_cancelled_during_processing_keeps_records(self, mock_fetcher_cls, tmp_path):
        mock_fetcher = MagicMock()
        mock_fetcher_cls.return_value = mock_fetcher

        mock_fetcher.discover_processes.return_value = [
            {"numero_controle_pncp": "PROC1", "item_url": "/compras/123/2026/1", "orgao_nome": "Órgão A", "data_publicacao_pncp": "2026-01-01"},
            {"numero_controle_pncp": "PROC2", "item_url": "/compras/123/2026/2", "orgao_nome": "Órgão B", "data_publicacao_pncp": "2026-01-01"},
        ]
        mock_fetcher.parse_item_url.side_effect = [
            ("123", 2026, 1),
            ("123", 2026, 2),
        ]
        mock_fetcher.get_items.side_effect = [
            [{"numeroItem": 1, "descricao": "cabo de cobre flexivel", "quantidade": 10}],
            [{"numeroItem": 2, "descricao": "cabo de cobre flexivel", "quantidade": 20}],
        ]

        recorded = []
        cancelled_state = [False]

        def on_rec(r):
            recorded.append(r)
            # Cancel after first record
            cancelled_state[0] = True

        params = ExtractionParams(
            keywords="cabo de cobre [flexivel]",
            output_dir=str(tmp_path),
        )

        res = run_extraction(
            params,
            is_cancelled=lambda: cancelled_state[0],
            on_record=on_rec,
        )

        assert res.status == "cancelled"
        assert len(res.records) == 1
        assert len(recorded) == 1
        assert res.records[0]["descricao"] == "cabo de cobre flexivel"


class TestWebappCancellationEndpoint:
    """Test Flask /api/job/<job_id>/cancel endpoint."""

    def test_cancel_nonexistent_job(self):
        client = app.test_client()
        resp = client.post("/api/job/fake999/cancel")
        assert resp.status_code == 404

    def test_cancel_active_job(self):
        client = app.test_client()
        import threading
        job_id = "testjob1"
        cancel_evt = threading.Event()
        jobs[job_id] = {
            "id": job_id,
            "status": "running",
            "results": [{"item_id": 1, "descricao": "cabo test"}],
            "logs": ["Iniciando..."],
            "progress": None,
            "items_verified": 5,
            "_cancel_event": cancel_evt,
        }

        resp = client.post(f"/api/job/{job_id}/cancel")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "cancelled"
        assert data["total_results"] == 1
        assert data["results"][0]["descricao"] == "cabo test"
        assert cancel_evt.is_set()
