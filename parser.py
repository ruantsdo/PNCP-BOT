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
    >>> parse_keywords("cabo [vermelho, grosso]")
    [cabo [vermelho] [grosso]]
    >>> parse_keywords("cabo, tomada")
    [cabo, tomada]
    """
    keywords: list[ParsedKeyword] = []

    # Split on commas that are NOT inside brackets
    parts = re.split(r",\s*(?![^\[]*\])", raw)

    for part in parts:
        part = part.strip()
        if not part:
            continue

        qualifiers: list[str] = []
        # extract all [...] groups, then split their contents on comma
        for m in re.finditer(r"\[([^\]]+)\]", part):
            inner = m.group(1)
            for q in inner.split(","):
                q = q.strip()
                if q:
                    qualifiers.append(normalize(q))
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
        """True when ALL qualifiers are met (or no qualifiers defined)."""
        if not self.keyword.qualifiers:
            return True
        return len(self.qualifiers_unmet) == 0

    @property
    def is_compound(self) -> bool:
        """True when at least one qualifier matched but not all."""
        if not self.keyword.qualifiers:
            return False
        return len(self.qualifiers_met) > 0 and len(self.qualifiers_unmet) > 0

    def __repr__(self) -> str:
        if self.is_exact:
            tag = "✓"
        elif self.is_compound:
            tag = "◐"
        else:
            tag = "~"
        return f"{tag} {self.keyword}"



# ── Word-boundary helper ─────────────────────────────────────────────────
def _word_boundary_match(term: str, text: str) -> bool:
    """Check if *term* appears in *text* as a standalone token."""
    escaped = re.escape(term)
    return bool(re.search(rf"(?<![a-zA-Z0-9]){escaped}(?![a-zA-Z0-9])", text))


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
    2. When a keyword has qualifiers, **at least one** qualifier must be
       present in the description — otherwise the item is skipped
       (prevents false positives like "aparelho com cabo" matching "cabo [vermelho]").
    3. All qualifiers are recorded as met/unmet for exact-vs-partial scoring.
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

        # qualifiers — check which ones matched (word-boundary)
        quals_met = [q for q in kw.qualifiers if _word_boundary_match(q, norm_desc)]
        quals_unmet = [q for q in kw.qualifiers if not _word_boundary_match(q, norm_desc)]

        # If the keyword has qualifiers but NONE matched, skip this item
        # (base term alone in a different context = false positive)
        if kw.qualifiers and not quals_met:
            continue

        matched.append(MatchResult(
            keyword=kw,
            qualifiers_met=quals_met,
            qualifiers_unmet=quals_unmet,
        ))

    return matched
