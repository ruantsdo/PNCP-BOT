"""
PNCP Bot — Extraction Pipeline.

Shared extraction logic used by both the CLI and the web interface.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

import config
from fetcher import PNCPFetcher, CaptchaDetected
from parser import parse_keywords, matches_item
from exporter import build_record, export_json, export_csv

log = logging.getLogger("pncp.pipeline")


# ── Types ────────────────────────────────────────────────────────────────────
LogCallback = Callable[[str], None]
ProgressCallback = Callable[[int, int, str], None]


# ── Parameters ───────────────────────────────────────────────────────────────
class ExtractionParams:
    """Container for extraction parameters."""

    __slots__ = (
        "keywords", "uf", "date_from", "date_to", "contratante",
        "max_processes", "fuzzy_threshold", "rate_limit", "output_dir",
        "screenshots", "status",
    )

    def __init__(
        self,
        keywords: str,
        uf: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        contratante: str | None = None,
        max_processes: int = config.DEFAULT_MAX_PROCESSES,
        fuzzy_threshold: int = config.DEFAULT_FUZZY_THRESHOLD,
        rate_limit: float = config.RATE_LIMIT_DELAY,
        output_dir: str = config.DEFAULT_OUTPUT_DIR,
        screenshots: bool = False,
        status: str | None = None,
    ):
        self.keywords = keywords
        self.uf = uf
        self.date_from = date_from
        self.date_to = date_to
        self.contratante = contratante
        self.max_processes = max_processes
        self.fuzzy_threshold = fuzzy_threshold
        self.rate_limit = rate_limit
        self.output_dir = output_dir
        self.screenshots = screenshots
        self.status = status

    @classmethod
    def from_dict(cls, data: dict) -> ExtractionParams:
        """Build from a dictionary (e.g. JSON payload)."""
        return cls(
            keywords=data.get("keywords", ""),
            uf=data.get("uf") or None,
            date_from=data.get("date_from") or None,
            date_to=data.get("date_to") or None,
            contratante=data.get("contratante") or None,
            max_processes=int(data.get("max_processes", config.DEFAULT_MAX_PROCESSES)),
            fuzzy_threshold=int(data.get("fuzzy_threshold", config.DEFAULT_FUZZY_THRESHOLD)),
            rate_limit=float(data.get("rate_limit", config.RATE_LIMIT_DELAY)),
            output_dir=data.get("output_dir", config.DEFAULT_OUTPUT_DIR),
            screenshots=bool(data.get("screenshots", False)),
            status=data.get("status") or None,
        )


# ── Results ──────────────────────────────────────────────────────────────────
class ExtractionResult:
    """Outcome of a pipeline run."""

    __slots__ = ("records", "status", "message")

    def __init__(
        self,
        records: list[dict[str, Any]],
        status: str = "done",
        message: str = "",
    ):
        self.records = records
        self.status = status
        self.message = message


# ── Core pipeline ────────────────────────────────────────────────────────────
def run_extraction(
    params: ExtractionParams,
    on_log: LogCallback | None = None,
    on_progress: ProgressCallback | None = None,
) -> ExtractionResult:
    """
    Execute the full extraction pipeline.

    Parameters
    ----------
    params : ExtractionParams
        All search/filter/output settings.
    on_log : callable, optional
        ``on_log(message)`` — called for each log line.
    on_progress : callable, optional
        ``on_progress(current, total, label)`` — called for progress updates.

    Returns
    -------
    ExtractionResult
    """

    def emit(msg: str) -> None:
        log.info(msg)
        if on_log:
            on_log(msg)

    # 1. Parse keywords
    parsed = parse_keywords(params.keywords)
    if not parsed:
        emit("Nenhuma palavra-chave válida.")
        return ExtractionResult([], status="error", message="Nenhuma palavra-chave válida.")

    base_terms = list({kw.term for kw in parsed})
    emit(f"Termos de busca: {base_terms}")

    # 2. Discover processes
    fetcher = PNCPFetcher(rate_limit=params.rate_limit)
    emit("Buscando processos…")

    try:
        processes = fetcher.discover_processes(
            keywords=base_terms,
            uf=params.uf,
            date_from=params.date_from,
            date_to=params.date_to,
            contratante=params.contratante,
            status=params.status,
            max_processes=params.max_processes,
        )
    except CaptchaDetected as e:
        emit(f"⚠ CAPTCHA detectado: {e}")
        return ExtractionResult([], status="captcha", message=str(e))

    emit(f"Encontrados {len(processes)} processos.")

    if not processes:
        return ExtractionResult([], message="Nenhum processo encontrado.")

    # 3. Fetch items & match
    records: list[dict[str, Any]] = []

    for i, proc in enumerate(processes, 1):
        pid = proc.get("numero_controle_pncp", "?")
        item_url = proc.get("item_url", "")

        if on_progress:
            on_progress(i, len(processes), f"Processando {pid}…")
        emit(f"[{i}/{len(processes)}] {pid}")

        try:
            cnpj, ano, seq = fetcher.parse_item_url(item_url)
        except ValueError:
            emit(f"  ⚠ URL inválida: {item_url}")
            continue

        try:
            items = fetcher.get_items(cnpj, ano, seq)
        except CaptchaDetected as e:
            emit(f"⚠ CAPTCHA: {e}")
            break
        except Exception as exc:
            emit(f"  ⚠ Erro ao buscar itens: {exc}")
            continue

        for item_index, item in enumerate(items):
            desc = item.get("descricao", "")
            matched = matches_item(desc, parsed, fuzzy_threshold=params.fuzzy_threshold)
            if matched:
                rec = build_record(proc, item, matched, item_index=item_index)
                records.append(rec)
                emit(f"  ✓ Item #{item.get('numeroItem')} → {desc[:60]}")

    # 4. Export
    if records:
        export_json(records, params.output_dir)
        export_csv(records, params.output_dir)
        emit(f"Exportados {len(records)} itens → {params.output_dir}")
    else:
        emit("Nenhum item encontrado com os critérios informados.")

    # 5. Screenshots (optional)
    if params.screenshots and records:
        from exporter import capture_screenshots
        emit("Capturando screenshots…")
        capture_screenshots(records, params.output_dir)
        export_json(records, params.output_dir)
        export_csv(records, params.output_dir)

    emit(f"Concluído! {len(records)} itens encontrados.")
    return ExtractionResult(records)
