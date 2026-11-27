"""The one reading of a cartola's printed text, shared by every cartola reader (the cuenta corriente
xlsx in `ingest/src/santander/checkingCartolaXlsx.ts`, the cuenta corriente and cuenta vista PDF
parsers here), so the two renderings of a month read alike.

Rules (`server/contracts/src/formats/cartolaText.ts` is the TypeScript side; both assert
`server/contracts/data/cartolaTextCases.json`):

  1. Accent damage of one shape is repaired, and only that: the bank stores a name's UTF-8 bytes
     and prints each byte as a Latin-1 character. The xlsx prints both bytes — «Ã» followed by a
     character U+0080–U+00BF — which is the letter U+00C0 + (second − U+0080) («JosÃ©» →
     «José»). The PDF's font prints «Ã» as «A», so its form is «A» right after a letter,
     followed by the second byte of a Spanish lowercase letter: «A¡» á, «A©» é, «A­» í,
     «A³» ó, «Aº» ú, «A±» ñ, «A¼» ü. Any other damage (a second byte the PDF dropped, Windows-1252
     punctuation for a capital letter) is left as printed: the two renderings then differ, and
     the import's cross-check names the row.
  2. Runs of whitespace (space, tab, line breaks, no-break space) become one space; the text is
     trimmed.
"""
from __future__ import annotations

import re

# The PDF form: the second UTF-8 byte of each Spanish lowercase letter, after a damaged «Ã» → «A».
PDF_SECOND_BYTES = {"¡": "á", "©": "é", "­": "í", "³": "ó", "º": "ú", "±": "ñ", "¼": "ü"}

RE_XLSX_DAMAGE = re.compile("Ã([\u0080-¿])")
RE_PDF_DAMAGE = re.compile("(?<=[^\\W\\d_])A([" + "".join(PDF_SECOND_BYTES) + "])")
RE_SPACES = re.compile("[\t\n\v\f\r  ]+")


def repair_cartola_accents(text: str) -> str:
    text = RE_XLSX_DAMAGE.sub(lambda m: chr(0xC0 + ord(m.group(1)) - 0x80), text)
    return RE_PDF_DAMAGE.sub(lambda m: PDF_SECOND_BYTES[m.group(1)], text)


def cartola_text(text: str) -> str:
    """A printed cartola cell (description, branch, document number) as every reader stores it."""
    return RE_SPACES.sub(" ", repair_cartola_accents(text)).strip()
