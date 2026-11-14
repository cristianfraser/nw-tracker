"""Classify why a Lider BCI login stayed on /login (pure; no browser, no network).

The bank blocks the clave after 3 failed logins, so a REJECTED clave must latch further logins
(`cfraser/.lider-login-rejected.json`). The site also shows a generic error page when it is
having trouble («Ha ocurrido un error Lo sentimos …»); that says nothing about the clave and must
not latch (2026-11-13: a transient error latched a good clave for a day).

WRONG_CLAVE_PATTERNS: UNVERIFIED wording. No real wrong-clave page has been captured yet, so these
are guesses at a narrow set of phrases that name the credential. Anything that does not match is
"transient": no latch, a clear message, diagnostics saved. When a real wrong-clave page is seen,
add its exact wording here (the diagnostics file login-rejected.txt holds the page text).
"""

from __future__ import annotations

import re
import unicodedata


def fold(text: str) -> str:
    """Lowercase, accent-free, whitespace-collapsed."""
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return " ".join(stripped.lower().split())


# Matched against fold(text). UNVERIFIED — see the module docstring.
WRONG_CLAVE_PATTERNS = [
    r"clave\s+(?:es\s+)?incorrecta",
    r"clave\s+invalida",
    r"rut\s+(?:y/o|o|y)\s+clave\s+(?:son\s+)?incorrect",
    r"(?:datos|credenciales)\s+(?:ingresad\w+\s+)?(?:son\s+|estan\s+)?incorrect",
    r"usuario\s+(?:y/o|o|y)\s+(?:clave|contrasena)\s+(?:son\s+)?incorrect",
    r"contrasena\s+incorrecta",
    r"credenciales\s+invalid",
]


def classify_login_failure(text: str) -> str:
    """'wrong_clave' when the page states a wrong credential, else 'transient'."""
    folded = fold(text or "")
    for pattern in WRONG_CLAVE_PATTERNS:
        if re.search(pattern, folded):
            return "wrong_clave"
    return "transient"
