"""
PNCP Bot — Fetcher module.

Handles all HTTP communication with the PNCP APIs:
  • Search API   → discover processes by keyword
  • Items API    → get all items for a process
  • Detail API   → get full process metadata
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import config

log = logging.getLogger("pncp.fetcher")


# ── Exceptions ───────────────────────────────────────────────────────────────
class CaptchaDetected(Exception):
    """Raised when the server returns a CAPTCHA challenge."""


class PNCPAPIError(Exception):
    """Generic API error."""


# ── Fetcher ──────────────────────────────────────────────────────────────────
class PNCPFetcher:
    """Stateful HTTP client for the PNCP platform."""

    def __init__(
        self,
        rate_limit: float = config.RATE_LIMIT_DELAY,
        max_retries: int = config.MAX_RETRIES,
        timeout: int = config.REQUEST_TIMEOUT,
    ):
        self.rate_limit = rate_limit
        self.timeout = timeout
        self._last_request_time: float = 0.0

        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": config.USER_AGENT,
            "Accept": "application/json",
        })

        retry = Retry(
            total=max_retries,
            backoff_factor=config.RETRY_BACKOFF_FACTOR,
            status_forcelist=config.RETRY_STATUS_CODES,
            allowed_methods=["GET"],
        )
        adapter = HTTPAdapter(max_retries=retry)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    # ── internal helpers ─────────────────────────────────────────────────
    def _throttle(self) -> None:
        elapsed = time.time() - self._last_request_time
        if elapsed < self.rate_limit:
            time.sleep(self.rate_limit - elapsed)

    def _get(self, url: str, params: dict | None = None) -> Any:
        self._throttle()
        log.debug("GET %s  params=%s", url, params)
        self._last_request_time = time.time()

        resp = self.session.get(url, params=params, timeout=self.timeout)

        # CAPTCHA detection: non-JSON or specific redirect
        content_type = resp.headers.get("Content-Type", "")
        if resp.status_code == 403 or "text/html" in content_type:
            if "captcha" in resp.text.lower() or "challenge" in resp.text.lower():
                raise CaptchaDetected(
                    "CAPTCHA detected. Pausing for manual intervention. "
                    f"URL: {url}"
                )

        resp.raise_for_status()
        return resp.json()

    # ── Search API ───────────────────────────────────────────────────────
    def search_processes(
        self,
        keyword: str,
        page: int = 1,
        page_size: int = config.DEFAULT_SEARCH_PAGE_SIZE,
        status: str | None = None,
        uf: str | None = None,
    ) -> tuple[list[dict], int]:
        """
        Search processes matching *keyword*.
        Returns (items_list, total_count).
        """
        params = {
            "q": keyword,
            "tipos_documento": "edital",
            "ordenacao": "-data",
            "pagina": page,
            "tam_pagina": page_size,
        }
        if status:
            params["status"] = status
        if uf:
            params["ufs"] = uf.upper()

        data = self._get(config.SEARCH_URL, params=params)
        items = data.get("items", [])
        total = data.get("total", 0)
        log.info("Search '%s' page %d → %d items (total %d)", keyword, page, len(items), total)
        return items, total

    # ── Items API ────────────────────────────────────────────────────────
    def get_items_count(self, cnpj: str, ano: int, seq: int) -> int:
        """Return the number of items in a process."""
        count = self._get(
            config.ITEMS_COUNT_URL.format(cnpj=cnpj, ano=ano, seq=seq)
        )
        log.debug("Items count %s/%s/%s → %s", cnpj, ano, seq, count)
        return int(count)

    def get_items(
        self, cnpj: str, ano: int, seq: int, page_size: int = 500,
    ) -> list[dict]:
        """Fetch ALL items for a process, paginating if necessary."""
        total_count = self.get_items_count(cnpj, ano, seq)
        if total_count == 0:
            return []

        all_items: list[dict] = []
        page = 1
        total_pages = -(-total_count // page_size)  # ceil div

        while page <= total_pages:
            items = self._get(
                config.ITEMS_URL.format(cnpj=cnpj, ano=ano, seq=seq),
                params={"pagina": page, "tamanhoPagina": page_size},
            )
            all_items.extend(items)
            log.debug(
                "Items page %d/%d for %s/%s/%s → %d items",
                page, total_pages, cnpj, ano, seq, len(items),
            )
            if len(items) < page_size:
                break
            page += 1

        log.info("Fetched %d items for %s/%s/%s", len(all_items), cnpj, ano, seq)
        return all_items

    # ── Process detail ───────────────────────────────────────────────────
    def get_process_detail(self, cnpj: str, ano: int, seq: int) -> dict:
        """Get full metadata for a single process."""
        return self._get(
            config.PROCESS_DETAIL_URL.format(cnpj=cnpj, ano=ano, seq=seq)
        )

    # ── High-level discovery ─────────────────────────────────────────────
    @staticmethod
    def parse_item_url(item_url: str) -> tuple[str, int, int]:
        """
        Parse a search-result ``item_url`` like ``/compras/12345678000199/2026/18``
        into (cnpj, ano, sequencial).
        """
        m = re.match(r"/compras/(\d+)/(\d+)/(\d+)", item_url)
        if not m:
            raise ValueError(f"Cannot parse item_url: {item_url}")
        return m.group(1), int(m.group(2)), int(m.group(3))

    def discover_processes(
        self,
        keywords: list[str],
        *,
        uf: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        contratante: str | None = None,
        status: str | None = None,
        max_processes: int = config.DEFAULT_MAX_PROCESSES,
    ) -> list[dict]:
        """
        Search for processes matching any of *keywords*, then apply
        client-side filters.  Returns deduplicated process dicts.
        """
        seen: set[str] = set()
        results: list[dict] = []

        for kw in keywords:
            page = 1
            while True:
                items, total = self.search_processes(
                    kw, page=page, status=status, uf=uf,
                )
                if not items:
                    break

                for proc in items:
                    pid = proc.get("numero_controle_pncp", "")
                    if pid in seen:
                        continue

                    # ── client-side filters (date, contratante) ────────

                    if date_from:
                        pub = proc.get("data_publicacao_pncp", "")[:10]
                        if pub < date_from:
                            continue
                    if date_to:
                        pub = proc.get("data_publicacao_pncp", "")[:10]
                        if pub > date_to:
                            continue

                    if contratante:
                        orgao = (proc.get("orgao_nome") or "").lower()
                        if contratante.lower() not in orgao:
                            continue

                    seen.add(pid)
                    results.append(proc)

                    if len(results) >= max_processes:
                        log.info("Reached max_processes=%d, stopping.", max_processes)
                        return results

                # next page?
                total_pages = -(-total // config.DEFAULT_SEARCH_PAGE_SIZE)  # ceil div
                if page >= total_pages:
                    break
                page += 1

        log.info("Discovered %d unique processes.", len(results))
        return results
