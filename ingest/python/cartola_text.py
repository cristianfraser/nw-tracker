"""The one reading of a cartola's printed text, shared by every cartola reader (the cuenta corriente
xlsx in `ingest/src/santander/checkingCartolaXlsx.ts`, the cuenta corriente and cuenta vista PDF
parsers here), so the two renderings of a month read alike.

Rules (`server/contracts/src/formats/cartolaText.ts` is the TypeScript side and states them in
full; both assert `server/contracts/data/cartolaTextCases.json`):

  1. Accent damage of one shape is repaired, and only that: «Ã» followed by U+0080–U+00BF (the
     xlsx) is the letter U+00C0 + (second − U+0080); «A» right after a letter followed by the
     second byte of a Spanish lowercase letter (the PDF, whose font prints «Ã» as «A») is that
     letter: «A¡» á, «A©» é, «A­» í, «A³» ó, «Aº» ú, «A±» ñ, «A¼» ü. A letter is A–Z, a–z
     or a Latin-1 letter (U+00C0–U+00FF but × and ÷), the same explicit class as the TypeScript
     side. The repair runs to a fixed point, so the reading is idempotent.
  2. Runs of whitespace (space, tab, line breaks, no-break space) become one space; the text is
     trimmed.
"""
from __future__ import annotations

import re

# The PDF form: the second UTF-8 byte of each Spanish lowercase letter, after a damaged «Ã» → «A».
PDF_SECOND_BYTES = {"¡": "á", "©": "é", "­": "í", "³": "ó", "º": "ú", "±": "ñ", "¼": "ü"}

# A letter, for the PDF form: A–Z, a–z, a Latin-1 letter (U+00C0–U+00FF but × ÷).
LETTER = "A-Za-zÀ-ÖØ-öø-ÿ"

RE_XLSX_DAMAGE = re.compile("Ã([\u0080-¿])")
RE_PDF_DAMAGE = re.compile("(?<=[" + LETTER + "])A([" + "".join(PDF_SECOND_BYTES) + "])")
RE_SPACES = re.compile("[\t\n\v\f\r  ]+")


def _repair_once(text: str) -> str:
    text = RE_XLSX_DAMAGE.sub(lambda m: chr(0xC0 + ord(m.group(1)) - 0x80), text)
    return RE_PDF_DAMAGE.sub(lambda m: PDF_SECOND_BYTES[m.group(1)], text)


def repair_cartola_accents(text: str) -> str:
    """Both forms repaired until nothing changes (every repair shortens the text, so it ends)."""
    prev = text
    while True:
        nxt = _repair_once(prev)
        if nxt == prev:
            return nxt
        prev = nxt


def cartola_text(text: str) -> str:
    """A printed cartola cell (description, branch, document number) as every reader stores it."""
    return RE_SPACES.sub(" ", repair_cartola_accents(text)).strip()
