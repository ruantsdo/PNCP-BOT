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
    groups: list[list[str]] = field(default_factory=list)

    def __repr__(self) -> str:
        if not self.groups:
            return self.term
        gs = " | ".join(f"[{', '.join(g)}]" for g in self.groups)
        return f"{self.term} {gs}".strip()


# ── Normalisation ────────────────────────────────────────────────────────────
def normalize(text: str) -> str:
    """Lowercase, strip accents, collapse whitespace, normalise unit suffixes."""
    text = text.lower()
    # decompose → remove combining marks → recompose
    nfkd = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    text = re.sub(r"\s+", " ", text).strip()
    # Normalise area units: PNCP writes mm² as 'mm2' (e.g. '2,5mm2' means 2.5 mm²)
    # Strip the trailing '2' so '2,5mm2' → '2,5mm' and matches user filters like '2,5mm'
    text = re.sub(r"(\d)mm2\b", r"\1mm", text)
    return text


# ── Keyword parsing ─────────────────────────────────────────────────────────
def parse_keywords(raw: str) -> list[ParsedKeyword]:
    keywords: list[ParsedKeyword] = []

    # Split on commas that are NOT inside brackets
    parts = re.split(r",\s*(?![^\[]*\])", raw)

    for part in parts:
        part = part.strip()
        if not part:
            continue

        groups: list[list[str]] = []
        # extract all [...] groups
        for m in re.finditer(r"\[([^\]]+)\]", part):
            inner = m.group(1)
            # Find {} blocks or strings without |, {, }
            for g_match in re.finditer(r"\{([^\}]+)\}|([^|{}]+)", inner):
                if g_match.group(1):  # inside {}
                    alts = [normalize(x) for x in g_match.group(1).split('|') if x.strip()]
                    if alts:
                        groups.append(alts)
                elif g_match.group(2):  # outside {}
                    val = normalize(g_match.group(2))
                    if val:
                        groups.append([val])

        # base term = everything outside brackets
        base = re.sub(r"\[[^\]]*\]", "", part).strip()
        if base:
            keywords.append(ParsedKeyword(
                term=normalize(base),
                groups=groups,
            ))
    return keywords


# ── Match result ─────────────────────────────────────────────────────────────
@dataclass
class MatchResult:
    """Result of matching a keyword against an item description."""
    keyword: ParsedKeyword
    groups_met: int = 0

    @property
    def is_exact(self) -> bool:
        """True when the base term and ALL groups are satisfied."""
        return True  # strict mode: only matched items reach this point

    def __repr__(self) -> str:
        return f"✓ {self.keyword}"


# ── Word-boundary helper ─────────────────────────────────────────────────
def _word_boundary_match(term: str, text: str) -> bool:
    """Check if *term* appears in *text* as a standalone token."""
    escaped = re.escape(term)
    pattern = rf"(?<![\w])({escaped})(?![\w])"
    return bool(re.search(pattern, text, re.UNICODE))


# ── Diagnostic helper ────────────────────────────────────────────
def diagnose_match(description: str, parsed_keywords: list[ParsedKeyword], fuzzy_threshold: int = 80) -> str:
    """Return a human-readable string explaining why an item did NOT match."""
    norm_desc = normalize(description)
    lines = [f"Desc normalizada: {norm_desc[:120]}"]

    for kw in parsed_keywords:
        lines.append(f"  Keyword: '{kw.term}'")
        term_words = kw.term.split()
        for w in term_words:
            ok = _word_boundary_match(w, norm_desc)
            lines.append(f"    Base palavra '{w}': {'OK' if ok else 'FALHOU'}")

        base_ok = all(_word_boundary_match(w, norm_desc) for w in term_words)
        if not base_ok:
            lines.append("    => Falhou no termo base. Parando.")
            continue

        for gi, g in enumerate(kw.groups):
            matched_alts = [alt for alt in g if _word_boundary_match(alt, norm_desc)]
            if matched_alts:
                lines.append(f"    Grupo {gi+1} {g}: OK (achou: {matched_alts})")
            else:
                lines.append(f"    Grupo {gi+1} {g}: FALHOU (nenhuma alternativa encontrada na desc)")
    return "\n".join(lines)


# ── Matching ─────────────────────────────────────────────────────────────────
def matches_item(
    description: str,
    parsed_keywords: list[ParsedKeyword],
    fuzzy_threshold: int = 80,
) -> list[MatchResult]:
    norm_desc = normalize(description)
    matched: list[MatchResult] = []

    for kw in parsed_keywords:
        # base term — ALL words must appear as word-boundary tokens (strict)
        norm_term = kw.term
        term_words = norm_term.split()
        
        if all(_word_boundary_match(w, norm_desc) for w in term_words):
            base_ok = True
        # Fuzzy only as last resort: long single-token terms with no groups
        elif len(norm_term) >= 5 and not kw.groups and \
             fuzz.token_set_ratio(norm_term, norm_desc) >= fuzzy_threshold and \
             fuzz.partial_ratio(norm_term, norm_desc) >= fuzzy_threshold:
            base_ok = True
        else:
            base_ok = False

        if not base_ok:
            continue

        # Groups: ALL groups are now MANDATORY.
        # Each group is an OR set — at least one alt per group must match.
        # If ANY group fails → skip this keyword (item doesn't qualify).
        groups_met = 0
        all_groups_ok = True

        for g in kw.groups:
            if any(_word_boundary_match(alt, norm_desc) for alt in g):
                groups_met += 1
            else:
                all_groups_ok = False
                break  # fail fast

        if not all_groups_ok:
            continue  # strict: group unmet → discard this keyword match

        matched.append(MatchResult(
            keyword=kw,
            groups_met=groups_met,
        ))

    return matched
