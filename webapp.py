#!/usr/bin/env python3
"""
PNCP Bot — Web Application.

A Flask-based web interface that combines search, extraction, and review
into a single unified UI.  Run with:

    py webapp.py

Then open http://localhost:5000
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import uuid
from pathlib import Path

import requests as http_requests
from flask import Flask, jsonify, render_template, request, send_from_directory

import config
from pipeline import ExtractionParams, run_extraction
from exporter import export_json, export_csv

# ── App setup ────────────────────────────────────────────────────────────────
app = Flask(__name__, template_folder="web", static_folder="web/static")
app.secret_key = os.environ.get("SECRET_KEY", "pncp-bot-dev-secret")

OUTPUT_DIR = Path(config.DEFAULT_OUTPUT_DIR)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── In-memory job store ──────────────────────────────────────────────────────
jobs: dict[str, dict] = {}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("pncp.webapp")


# ── Background extraction worker ────────────────────────────────────────────
def _worker(job_id: str, params: dict) -> None:
    """Run extraction in a background thread, updating the job dict."""
    job = jobs[job_id]
    job["status"] = "running"

    def on_log(msg: str) -> None:
        job["logs"].append(msg)

    def on_progress(current: int, total: int, label: str) -> None:
        job["progress"] = {"current": current, "total": total, "label": label}

    extraction_params = ExtractionParams.from_dict(params)
    extraction_params.output_dir = str(OUTPUT_DIR)  # always use server output dir

    try:
        result = run_extraction(extraction_params, on_log=on_log, on_progress=on_progress)
        job["results"] = result.records
        job["status"] = result.status
    except Exception as exc:
        job["status"] = "error"
        job["logs"].append(f"Erro fatal: {exc}")
        log.exception("Worker error for job %s", job_id)


# ── Routes ───────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html", uf_codes=config.UF_CODES)


@app.route("/api/search", methods=["POST"])
def api_search():
    data = request.json or {}
    job_id = str(uuid.uuid4())[:8]

    jobs[job_id] = {
        "id": job_id,
        "status": "queued",
        "results": [],
        "logs": [],
        "progress": None,
        "params": data,
    }

    thread = threading.Thread(target=_worker, args=(job_id, data), daemon=True)
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/job/<job_id>")
def api_job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "results": job["results"],
        "logs": job["logs"][-30:],
        "total_results": len(job["results"]),
    })


@app.route("/api/export", methods=["POST"])
def api_export():
    data = request.json or {}
    records = data.get("records", [])
    if not records:
        return jsonify({"error": "No records to export"}), 400

    out = str(OUTPUT_DIR)
    json_path = export_json(records, out)
    csv_path = export_csv(records, out)
    return jsonify({"json_path": json_path, "csv_path": csv_path, "count": len(records)})


@app.route("/api/check-results")
def api_check_results():
    """Proxy to the PNCP results endpoint (avoids CORS)."""
    url = request.args.get("url", "")
    if not url or not url.startswith("https://pncp.gov.br/"):
        return jsonify({"has_data": False, "error": "URL inválida"}), 400
    try:
        resp = http_requests.get(url, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            has_data = isinstance(data, list) and len(data) > 0
            return jsonify({"has_data": has_data, "data": data})
        return jsonify({"has_data": False, "error": f"HTTP {resp.status_code}"})
    except Exception as exc:
        return jsonify({"has_data": False, "error": str(exc)})


@app.route("/output/<path:filename>")
def serve_output(filename):
    return send_from_directory(str(OUTPUT_DIR), filename)


# ── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("RENDER") is None  # disable debug in production
    log.info("═" * 50)
    log.info("  PNCP Bot — Web Interface")
    log.info("  http://localhost:%d", port)
    log.info("═" * 50)
    app.run(host="0.0.0.0", port=port, debug=debug)
