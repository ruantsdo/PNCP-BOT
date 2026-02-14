"""
PNCP Bot — Exporter module.

Export matched items to JSON / CSV and capture screenshots via Playwright.
"""

from __future__ import annotations

import csv
import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("pncp.exporter")

# ── Output field order ───────────────────────────────────────────────────────
FIELDS = [
    "process_id",
    "item_id",
    "descricao",
    "quantidade",
    "unidade",
    "valor_unitario",
    "valor_total",
    "fornecedor",
    "contratante",
    "data_publicacao",
    "source_url",
    "capture_path",
    "matched_keywords",
    "match_quality",     # exact (all qualifiers met) or partial
    "status",           # for review UI: pending / approved / rejected
]


# ── Build a single output record ────────────────────────────────────────────
def build_record(
    process: dict,
    item: dict,
    matched_keywords: list,
    capture_path: str = "",
) -> dict[str, Any]:
    """Merge process-level and item-level data into a flat output record."""
    cnpj = process.get("orgao_cnpj", "")
    ano = process.get("ano", "")
    seq = process.get("numero_sequencial", "")

    # Check if any match has all qualifiers met (exact match)
    has_exact = any(
        getattr(m, "is_exact", True) for m in matched_keywords
    )

    return {
        "process_id": process.get("numero_controle_pncp", ""),
        "item_id": item.get("numeroItem", ""),
        "descricao": item.get("descricao", ""),
        "quantidade": item.get("quantidade", 0),
        "unidade": item.get("unidadeMedida", ""),
        "valor_unitario": item.get("valorUnitarioEstimado", 0),
        "valor_total": item.get("valorTotal", 0),
        "fornecedor": _extract_fornecedor(item),
        "contratante": process.get("orgao_nome", ""),
        "data_publicacao": process.get("data_publicacao_pncp", ""),
        "source_url": f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}",
        "capture_path": capture_path,
        "matched_keywords": ", ".join(str(k) for k in matched_keywords),
        "match_quality": "exact" if has_exact else "partial",
        "status": "pending",
    }


def _extract_fornecedor(item: dict) -> str:
    """Try to extract supplier name; items without results return N/A."""
    if item.get("temResultado"):
        # result data would need an extra API call; mark as available
        return "(resultado disponível)"
    return "N/A"


# ── JSON export ──────────────────────────────────────────────────────────────
def export_json(records: list[dict], output_dir: str) -> str:
    path = Path(output_dir) / "results.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    log.info("Exported %d records → %s", len(records), path)
    return str(path)


# ── CSV export ───────────────────────────────────────────────────────────────
def export_csv(records: list[dict], output_dir: str) -> str:
    path = Path(output_dir) / "results.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)
    log.info("Exported %d records → %s", len(records), path)
    return str(path)


# ── Screenshot capture ───────────────────────────────────────────────────────
def capture_screenshots(
    records: list[dict],
    output_dir: str,
) -> None:
    """
    Open each process page in a headless browser and take a screenshot.
    Updates each record's ``capture_path`` in-place.
    """
    # Lazy-import so the rest of the tool works without Playwright installed
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log.warning("Playwright not installed — skipping screenshots.")
        return

    shots_dir = Path(output_dir) / "screenshots"
    shots_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        for rec in records:
            url = rec["source_url"]
            pid = rec["process_id"].replace("/", "_").replace("-", "_")
            iid = rec["item_id"]
            kw = rec["matched_keywords"].split(",")[0].strip().replace(" ", "_")
            filename = f"{pid}_{iid}_{kw}.png"
            filepath = shots_dir / filename

            try:
                page.goto(url, wait_until="networkidle", timeout=30000)
                page.wait_for_timeout(2000)  # extra settle time
                page.screenshot(path=str(filepath), full_page=True)
                rec["capture_path"] = str(filepath)
                log.info("Screenshot saved: %s", filepath)
            except Exception as exc:
                log.warning("Screenshot failed for %s: %s", url, exc)
                rec["capture_path"] = ""

        browser.close()
