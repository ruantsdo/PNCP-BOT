#!/usr/bin/env python3
"""
PNCP Bot — CLI entry point.

Usage examples
--------------
# Basic search for "cabo" in Bahia:
py cli.py --keywords "cabo" --uf BA --max-processes 10

# Multiple keywords with qualifiers:
py cli.py --keywords "cabo [vermelho], tomada [20a]" --uf BA

# With date range and screenshots:
py cli.py --keywords "cabo" --uf BA \
    --date-from 2026-01-01 --date-to 2026-02-14 \
    --screenshots --output-dir ./output

# For the full web interface, use:
#   py webapp.py
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import config
from pipeline import ExtractionParams, run_extraction


def setup_logging(output_dir: str, verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    log_dir = Path(output_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(log_dir / "pncp_bot.log", encoding="utf-8"),
    ]
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
        handlers=handlers,
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="pncp-bot",
        description=(
            "PNCP Data Extraction Bot — extract procurement items "
            "from the Portal Nacional de Contratações Públicas.\n\n"
            "For the full web interface, run: py webapp.py"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # ── keyword / filter ─────────────────────────────────────────────
    ap.add_argument(
        "--keywords", "-k", type=str, required=True,
        help='Comma-separated keywords with optional qualifiers, e.g. "cabo [vermelho], tomada [20a]"',
    )
    ap.add_argument("--uf", type=str, default=None, help="State code filter, e.g. BA")
    ap.add_argument("--date-from", type=str, default=None, help="Start date YYYY-MM-DD")
    ap.add_argument("--date-to", type=str, default=None, help="End date YYYY-MM-DD")
    ap.add_argument("--contratante", type=str, default=None, help="Filter by contracting entity name (substring)")

    # ── limits ───────────────────────────────────────────────────────
    ap.add_argument(
        "--max-processes", type=int, default=config.DEFAULT_MAX_PROCESSES,
        help=f"Max processes to inspect (default {config.DEFAULT_MAX_PROCESSES})",
    )
    ap.add_argument(
        "--fuzzy-threshold", type=int, default=config.DEFAULT_FUZZY_THRESHOLD,
        help=f"Fuzzy matching threshold 0-100 (default {config.DEFAULT_FUZZY_THRESHOLD})",
    )
    ap.add_argument(
        "--rate-limit", type=float, default=config.RATE_LIMIT_DELAY,
        help=f"Seconds between API requests (default {config.RATE_LIMIT_DELAY})",
    )

    # ── output ───────────────────────────────────────────────────────
    ap.add_argument(
        "--output-dir", "-o", type=str, default=config.DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default {config.DEFAULT_OUTPUT_DIR})",
    )
    ap.add_argument("--screenshots", action="store_true", help="Capture screenshots per matched item")
    ap.add_argument("--verbose", "-v", action="store_true", help="Debug logging")

    args = ap.parse_args()
    setup_logging(args.output_dir, args.verbose)

    log = logging.getLogger("pncp.cli")
    log.info("═" * 60)
    log.info("PNCP Bot — Starting extraction")
    log.info("═" * 60)

    params = ExtractionParams(
        keywords=args.keywords,
        uf=args.uf,
        date_from=args.date_from,
        date_to=args.date_to,
        contratante=args.contratante,
        max_processes=args.max_processes,
        fuzzy_threshold=args.fuzzy_threshold,
        rate_limit=args.rate_limit,
        output_dir=args.output_dir,
        screenshots=args.screenshots,
    )

    result = run_extraction(params)

    log.info("═" * 60)
    if result.status == "done":
        log.info("Done! %d items found → %s", len(result.records), args.output_dir)
    elif result.status == "captcha":
        log.error("CAPTCHA detected. Solve it in a browser and retry.")
    else:
        log.error("Extraction failed: %s", result.message)
    log.info("═" * 60)


if __name__ == "__main__":
    main()
