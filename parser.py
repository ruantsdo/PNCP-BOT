"""
PNCP Bot — Parser & Matcher module.

Text normalisation, keyword parsing (with bracket qualifiers),
and item-description matching (exact + fuzzy).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz


# ── Data structures ──────────────────────────────────────────────────────────
@dataclass
class ParsedKeyword:
    term: str
    qualifiers: list[str] = field(default_factory=list)

    def __repr__(self) -> str:
        q = " ".join(f"[{q}]" for q in self.qualifiers)
        return f"{self.term} {q}".strip()


# ── Normalisation ────────────────────────────────────────────────────────────
def normalize(text: str) -> str:
    """Lowercase, strip accents, collapse whitespace."""
    text = text.lower()
    # decompose → remove combining marks → recompose
    nfkd = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ── Keyword parsing ─────────────────────────────────────────────────────────
def parse_keywords(raw: str) -> list[ParsedKeyword]:
    """
    Parse a comma-separated keyword string.

    Examples
    --------
    >>> parse_keywords("cabo [vermelho], tomada [20a]")
    [cabo [vermelho], tomada [20a]]
    >>> parse_keywords("cabo, tomada")
    [cabo, tomada]
    """
    keywords: list[ParsedKeyword] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue

        qualifiers: list[str] = []
        # extract all [...] groups
        for m in re.finditer(r"\[([^\]]+)\]", part):
            qualifiers.append(normalize(m.group(1)))
        # base term = everything outside brackets
        base = re.sub(r"\[[^\]]*\]", "", part).strip()
        if base:
            keywords.append(ParsedKeyword(
                term=normalize(base),
                qualifiers=qualifiers,
            ))
    return keywords


# ── Match result ─────────────────────────────────────────────────────────────
@dataclass
class MatchResult:
    """Result of matching a keyword against an item description."""
    keyword: ParsedKeyword
    qualifiers_met: list[str] = field(default_factory=list)
    qualifiers_unmet: list[str] = field(default_factory=list)

    @property
    def is_exact(self) -> bool:
        """True when base term AND all qualifiers matched."""
        return len(self.qualifiers_unmet) == 0

    def __repr__(self) -> str:
        tag = "✓" if self.is_exact else "~"
        return f"{tag} {self.keyword}"


# ── Matching ─────────────────────────────────────────────────────────────────
def matches_item(
    description: str,
    parsed_keywords: list[ParsedKeyword],
    fuzzy_threshold: int = 80,
) -> list[MatchResult]:
    """
    Check if *description* matches ANY of the parsed keywords.

    Returns a list of :class:`MatchResult` (empty = no match).

    Matching logic per keyword:
    1. Base term must appear in the normalised description (exact substring).
       If not found, try fuzzy ``partial_ratio ≥ threshold``.
    2. Qualifiers are **soft** — they are checked but do NOT exclude items.
       Each qualifier is recorded as met or unmet for scoring/highlighting.
    """
    norm_desc = normalize(description)
    matched: list[MatchResult] = []

    for kw in parsed_keywords:
        # base term — exact first, then fuzzy
        if kw.term in norm_desc:
            base_ok = True
        elif fuzz.partial_ratio(kw.term, norm_desc) >= fuzzy_threshold:
            base_ok = True
        else:
            base_ok = False

        if not base_ok:
            continue

        # qualifiers — soft: record which ones matched
        quals_met = [q for q in kw.qualifiers if q in norm_desc]
        quals_unmet = [q for q in kw.qualifiers if q not in norm_desc]

        matched.append(MatchResult(
            keyword=kw,
            qualifiers_met=quals_met,
            qualifiers_unmet=quals_unmet,
        ))

    return matched
