"""
PNCP Bot — Exporter module.

Export matched items to JSON / CSV.
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
    "item_index",
    "descricao",
    "quantidade",
    "unidade",
    "valor_unitario",
    "valor_total",
    "fornecedor",
    "tem_resultado",
    "contratante",
    "data_publicacao",
    "source_url",
    "matched_keywords",
    "match_quality",     # exact / compound / partial
    "status",           # for review UI: pending / approved / rejected
]


# ── Build a single output record ────────────────────────────────────────────
def build_record(
    process: dict,
    item: dict,
    matched_keywords: list,
    item_index: int = 0,
) -> dict[str, Any]:
    """Merge process-level and item-level data into a flat output record."""
    cnpj = process.get("orgao_cnpj", "")
    ano = process.get("ano", "")
    seq = process.get("numero_sequencial", "")

    # Determine match quality:
    #   exact    = all qualifiers met
    #   compound = at least one qualifier met but not all
    #   partial  = no qualifiers defined (base term match only)
    quality = _determine_quality(matched_keywords)

    tem_resultado = bool(item.get("temResultado", False))
    initial_status = "to_analyze" if tem_resultado else "pending"

    return {
        "process_id": process.get("numero_controle_pncp", ""),
        "item_id": item.get("numeroItem", ""),
        "item_index": item_index,
        "descricao": item.get("descricao", ""),
        "quantidade": item.get("quantidade", 0),
        "unidade": item.get("unidadeMedida", ""),
        "valor_unitario": item.get("valorUnitarioEstimado", 0),
        "valor_total": item.get("valorTotal", 0),
        "fornecedor": _extract_fornecedor(item),
        "tem_resultado": tem_resultado,
        "contratante": process.get("orgao_nome", ""),
        "data_publicacao": process.get("data_publicacao_pncp", ""),
        "source_url": f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}",
        "matched_keywords": ", ".join(str(k) for k in matched_keywords),
        "match_quality": quality,
        "status": initial_status,
    }


def _determine_quality(matched_keywords: list) -> str:
    """Determine match quality from list of MatchResult objects.
    In strict mode every matched item satisfies all groups, so quality is always 'exact'.
    """
    if matched_keywords:
        return "exact"
    return "partial"


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
