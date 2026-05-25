#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse Chilean Banco de Chile / Lider credit card statement PDFs into CSV extracts.

Deps (workspace-local, no global pip required):
  mkdir -p server/scripts/.pdf_deps
  pip3 install pypdf typing_extensions -t server/scripts/.pdf_deps

System tools: `poppler` (`pdftotext`), `qpdf` (`brew install poppler qpdf`).
Unreadable PDFs are rewritten/decrypted via qpdf before parse (see `cc_pdf_qpdf.py`).

From repo root:
  npm run parse:cc-pdfs
  npm run import:cc-parsed -w nw-tracker-server
  # add --wipe only to replace all statements/ledger for that account

PDFs are read from `cfraser/credit-card-statements/` (override with CFRASER_PDFS_DIR).

Writes:
  cfraser/cc-statements-parsed-all.csv
  cfraser/cc-statements-parsed-card-a.csv
  cfraser/cc-statements-parsed-card-b.csv
  cfraser/credit-card-installments-backfill-suggested.csv
  cfraser/cc-statements-parse-reconciliation.jsonl

Per-PDF parse cache (skip re-parse when PDF and parser unchanged):
  cfraser/cc-statements-parsing-output/per-pdf/<sha256>.json
  Override dir: CC_PARSE_CACHE_DIR. Flags: --no-cache, --force-reparse.

Reconciliation runs after parse (skip with --no-reconcile). Exit 1 if any statement
fails totals check; all PDFs are still processed and failures are listed.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
CFRASER_DIR = REPO_ROOT / "cfraser"
BASELINE_CSV = CFRASER_DIR / "credit-card-installments.csv"
PARSE_CACHE_DIR = Path(
    os.environ.get("CC_PARSE_CACHE_DIR", str(CFRASER_DIR / "cc-statements-parsing-output"))
)
PARSE_CACHE_PER_PDF_DIR = PARSE_CACHE_DIR / "per-pdf"
PARSE_CACHE_VERSION_FILES = (
    SCRIPT_DIR / "parse-cc-statement-pdfs.py",
    SCRIPT_DIR / "cc_statement_reconcile.py",
    SCRIPT_DIR / "cc_pdf_qpdf.py",
)
PDF_DEPS = SCRIPT_DIR / ".pdf_deps"
if PDF_DEPS.is_dir():
    sys.path.insert(0, str(PDF_DEPS))
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pypdf import PdfReader  # type: ignore  # noqa: E402
from cc_pdf_qpdf import (  # noqa: E402
    load_repo_dotenv,
    qpdf_available,
    repair_unreadable_pdfs_in_dir,
    statement_pdf_password,
)
from cc_statement_reconcile import (  # noqa: E402
    merge_section_totals_into_meta,
    reconcile_statement,
    reconcile_statement_required,
    write_reconciliation_jsonl,
)


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


def parser_cache_version() -> str:
    """Bump invalidates all per-PDF caches when parser or reconcile logic changes."""
    h = hashlib.sha256()
    for path in PARSE_CACHE_VERSION_FILES:
        if not path.is_file():
            continue
        h.update(path.name.encode("utf-8"))
        h.update(path.read_bytes())
    return h.hexdigest()[:16]


def pdf_content_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_cache_file_path(pdf_hash: str) -> Path:
    return PARSE_CACHE_PER_PDF_DIR / f"{pdf_hash}.json"


def load_parse_cache(
    pdf_path: Path, parser_version: str, *, force: bool = False
) -> Optional[Dict[str, Any]]:
    if force:
        return None
    try:
        st = pdf_path.stat()
    except OSError:
        return None
    pdf_hash = pdf_content_sha256(pdf_path)
    cache_path = parse_cache_file_path(pdf_hash)
    if not cache_path.is_file():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if str(payload.get("parser_version") or "") != parser_version:
        return None
    if str(payload.get("pdf_sha256") or "") != pdf_hash:
        return None
    if int(payload.get("pdf_mtime_ns") or 0) != int(st.st_mtime_ns):
        return None
    if int(payload.get("pdf_size") or 0) != int(st.st_size):
        return None
    return payload


def save_parse_cache(pdf_path: Path, parser_version: str, payload: Dict[str, Any]) -> None:
    st = pdf_path.stat()
    pdf_hash = pdf_content_sha256(pdf_path)
    out = {
        "parser_version": parser_version,
        "pdf_sha256": pdf_hash,
        "pdf_mtime_ns": st.st_mtime_ns,
        "pdf_size": st.st_size,
        **payload,
    }
    cache_path = parse_cache_file_path(pdf_hash)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")


def rows_from_parse_payload(
    *,
    effective_group: str,
    source_pdf: str,
    meta: Dict[str, Any],
    parsed: List[Dict[str, Any]],
    baseline: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for i, pr in enumerate(parsed):
        raw_line = str(pr.get("description_raw", ""))
        rid = _sha1(f"{effective_group}|{source_pdf}|{i}|{raw_line}")
        row = emit_row(
            card_group=effective_group,
            source_pdf=source_pdf,
            meta=meta,
            pr=pr,
            raw_line=raw_line,
            row_id=rid,
        )
        mk, conf, note = match_baseline(pr, baseline)
        row["matched_excel_row"] = mk
        row["match_confidence"] = conf
        row["mismatch_notes"] = note
        rows.append(row)
    return rows


def parse_one_pdf(
    card_group: str,
    pdf_path: Path,
    baseline: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Extract text, parse lines, return CSV rows and pdf_context entry."""
    parser = choose_parser(pdf_path)
    _pages, full = extract_pdf_text(pdf_path, parser)
    effective_group = "INTL" if parser == "international_usd" else card_group
    full_layout = ""
    if parser == "international_usd":
        try:
            layout_run = subprocess.run(
                ["pdftotext", "-layout", str(pdf_path), "-"],
                capture_output=True,
                text=True,
            )
            full_layout = layout_run.stdout if layout_run.returncode == 0 else ""
        except (FileNotFoundError, OSError):
            full_layout = ""
        parsed = parse_international_usd_document(full, full_layout)
        meta = extract_meta_international(full, pdf_path.name)
    else:
        parsed = parse_clp_document(full, parser)
        meta = extract_meta(full, pdf_path.name)
    rows = rows_from_parse_payload(
        effective_group=effective_group,
        source_pdf=pdf_path.name,
        meta=meta,
        parsed=parsed,
        baseline=baseline,
    )
    ctx = {
        "meta": meta,
        "full": full,
        "layout": full_layout,
        "parser": parser,
        "parsed": parsed,
    }
    return rows, ctx


def parse_clp_amount(raw: str) -> Optional[int]:
    t = str(raw or "").strip().replace("$", "").strip()
    if not t:
        return None
    neg = t.startswith("-")
    if neg:
        t = t[1:].strip()
    # Chilean thousands: dots separate thousands; no decimals in these statements for CLP totals
    t = t.replace(".", "").replace(",", ".")
    try:
        v = float(t)
    except ValueError:
        return None
    n = int(round(v))
    return -n if neg else n


def norm_merchant(s: str) -> str:
    x = str(s or "").lower()
    x = re.sub(r"[^a-z0-9áéíóúñü\s]+", " ", x, flags=re.I)
    x = re.sub(r"\s+", " ", x).strip()
    return x


def fmt_clp(n: Optional[int]) -> str:
    if n is None:
        return ""
    return str(int(n))


def parse_usd_amount(raw: str) -> Optional[float]:
    t = str(raw or "").strip().replace("US$", "").replace("$", "").strip()
    if not t:
        return None
    neg = t.startswith("-")
    if neg:
        t = t[1:].strip()
    # Chilean-style USD on statements: 3.290,00 (dot thousands, comma decimals)
    if re.search(r",\d{1,2}$", t):
        t = t.replace(".", "").replace(",", ".")
    else:
        t = t.replace(",", "")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def fmt_usd(n: Optional[float]) -> str:
    if n is None:
        return ""
    return f"{n:.2f}".replace(".", ",")


RE_INTL_COUNTRY = re.compile(r"^[A-Z]{2}$")
RE_AMOUNT_TOKEN = re.compile(r"^-?[\d.,]+$")
# US$ column on international statements: comma decimals, no Chilean thousands dots (e.g. 20,81).
RE_STATEMENT_USD_TOKEN = re.compile(r"^-?\d+,\d{1,2}$")
# Foreign origin column often uses Chilean grouping (e.g. GBP 20.604,00 = 20,604.00).
RE_CHILEAN_GROUPED_AMOUNT = re.compile(r"^-?\d{1,3}(\.\d{3})+,\d{2}$")
# Lone vertical cell above this is MONTO MONEDA ORIGEN (pdftotext dropped MONTO US$).
_MAX_PLAUSIBLE_INTL_LINE_USD = 150.0


def looks_like_statement_usd_token(raw: str) -> bool:
    t = str(raw or "").strip().replace(" ", "")
    if not t:
        return False
    # MONTO MONEDA ORIGEN (CLP/GBP reference), not the US$ column.
    if RE_CHILEAN_GROUPED_AMOUNT.match(t):
        return False
    if RE_STATEMENT_USD_TOKEN.match(t):
        return True
    if "," not in t and "." not in t:
        v = parse_usd_amount(t)
        return v is not None and abs(v) < 10_000
    return False


def parse_foreign_origin_amount(
    raw: str, usd_hint: Optional[float] = None
) -> Optional[float]:
    """
    Parse MONTO MONEDA ORIGEN for GBP/EUR/etc.
    pdftotext uses Chilean separators; when that yields a value far above the US$ column,
    treat a single middle dot as decimal (20.604,00 → 20.604).
    """
    t = str(raw or "").strip().replace(" ", "")
    if not t:
        return None
    chilean = parse_usd_amount(t)
    if chilean is None:
        return None
    hint = usd_hint if usd_hint is not None and usd_hint > 0 else None
    if hint is not None and chilean > max(500, hint * 8):
        m = re.match(r"^(-?)(\d+)\.(\d{3}),(\d{2})$", t)
        if m:
            sign = -1 if m.group(1) else 1
            try:
                eu = float(f"{m.group(2)}.{m.group(3)}")
            except ValueError:
                eu = None
            if eu is not None and eu < 100_000:
                return sign * eu
    return chilean


def _assign_intl_orig_and_usd_amounts(amounts: List[str]) -> Tuple[str, str]:
    """
    Return (orig_raw, usd_raw).

    Santander international table order is fixed: … | MONTO MONEDA ORIGEN | MONTO US$ (last column).
    When pdftotext emits both amounts for a row, the last token is always US$.
    """
    if not amounts:
        return "", ""
    if len(amounts) == 1:
        sole = amounts[0]
        v = parse_usd_amount(sole)
        if v is not None and v > _MAX_PLAUSIBLE_INTL_LINE_USD:
            return sole, ""
        if looks_like_statement_usd_token(sole):
            return "", sole
        return sole, ""
    trimmed = [a for a in amounts]
    while len(trimmed) > 2 and RE_CHILEAN_GROUPED_AMOUNT.match(
        trimmed[-1].replace(" ", "")
    ):
        trimmed.pop()
    return trimmed[-2], trimmed[-1]


def _strip_glued_statement_footer_cells(
    texts: List[str], amounts: List[str]
) -> None:
    """
    pdftotext often appends statement footer (CH + saldo en pesos 3.000,00) to the last row.
  """
    while texts and amounts:
        if not RE_INTL_COUNTRY.match(texts[-1]):
            break
        tail_raw = amounts[-1].replace(" ", "")
        if RE_CHILEAN_GROUPED_AMOUNT.match(tail_raw):
            texts.pop()
            amounts.pop()
            continue
        tail_usd = parse_usd_amount(amounts[-1])
        if tail_usd is None or tail_usd != 0:
            break
        texts.pop()
        amounts.pop()


_MERCHANT_CORE_TAIL_WORDS = frozenset(
    {"cost", "internet", "com", "bill", "hotel", "ride", "beds", "sao"}
)


def _intl_merchant_core(merchant: str, place: str = "") -> str:
    """Dedupe key base: align layout (merchant + place) with vertical (merchant glues city)."""
    m = norm_merchant(merchant)
    p = norm_merchant(place)
    if p:
        if m.endswith(p):
            m = m[: -len(p)].strip()
        elif p in m:
            m = m[: m.index(p)].strip()
        m = m.rstrip(",").strip()
    if not p:
        parts = m.split()
        if len(parts) >= 2:
            first = parts[0]
            # Vertical pdftotext glues "EASYJET000K2K1TJ4 LUTON BEDS" (commas already stripped).
            if re.search(r"\d", first):
                return first
        if "," in str(merchant or ""):
            head = m.split(",", 1)[0].strip()
            tokens = head.split()
            if tokens and re.match(r"^[\w.*]+$", tokens[0], re.I) and len(tokens[0]) >= 4:
                return tokens[0]
        parts = m.split()
        if len(parts) >= 2:
            tail = parts[-1]
            if (
                tail.isalpha()
                and len(tail) >= 4
                and tail not in _MERCHANT_CORE_TAIL_WORDS
            ):
                m = " ".join(parts[:-1]).strip()
    return m or norm_merchant(merchant).split()[0]

# País en columna → moneda del monto origen (columna antes del US$).
COUNTRY_ORIGIN_CURRENCY: Dict[str, str] = {
    "CL": "CLP",
    "CH": "CLP",
    "US": "CLP",
    "GB": "GBP",
    "UK": "GBP",
    "DE": "EUR",
    "FR": "EUR",
    "ES": "EUR",
    "IT": "EUR",
    "NL": "EUR",
    "BE": "EUR",
    "PT": "EUR",
    "IE": "EUR",
    "AT": "EUR",
    "CA": "CAD",
    "AU": "AUD",
    "NZ": "NZD",
    "BR": "BRL",
    "MX": "MXN",
    "JP": "JPY",
    "CN": "CNY",
    "AR": "ARS",
    "PE": "PEN",
    "CO": "COP",
}


def _origin_currency_for_country(country: str) -> str:
    c = country.upper().strip()
    return COUNTRY_ORIGIN_CURRENCY.get(c, c)


def _resolve_intl_orig_amounts(
    orig_raw: str,
    country: str,
    usd_val: float,
) -> Tuple[Optional[float], str, Optional[int]]:
    """
    Returns (amount_orig, orig_currency, amount_clp).
    International USD statements: billable amount is only MONTO US$ (row amount_usd).
    MONTO MONEDA ORIGEN is stored as amount_orig for reference — never amount_clp.
    """
    orig_ccy = _origin_currency_for_country(country)
    if not orig_raw:
        return None, orig_ccy, None

    if orig_ccy == "CLP":
        orig_clp = parse_clp_amount(orig_raw)
        orig_usd = parse_usd_amount(orig_raw)
        if orig_clp is not None:
            return float(orig_clp), "CLP", None
        if orig_usd is not None:
            return orig_usd, "USD", None
        return None, "CLP", None

    if orig_ccy == "USD":
        orig_usd = parse_usd_amount(orig_raw)
        orig_clp = parse_clp_amount(orig_raw)
        if orig_usd is not None:
            return orig_usd, "USD", None
        if orig_clp is not None:
            return float(orig_clp), "CLP", None
        return None, "USD", None

    # GBP, EUR, … — Chilean-grouped origin amounts; do not feed into amount_clp.
    orig_fx = parse_foreign_origin_amount(orig_raw, usd_hint=usd_val)
    if orig_fx is None:
        return None, orig_ccy, None
    return orig_fx, orig_ccy, None
RE_ORIGEN_COLUMN = re.compile(
    r"^(WWW\.?|[A-Za-z0-9*.-]+\.(COM|NET|IO|ORG|CO|AI)\b)$",
    re.I,
)


def _is_amount_token(s: str) -> bool:
    return bool(RE_AMOUNT_TOKEN.match(str(s).replace(" ", "").strip()))


def _split_trailing_country_code(text: str) -> Tuple[str, Optional[str]]:
    """e.g. 'RENDER.COM US' → ('RENDER.COM', 'US')."""
    t = text.strip()
    if RE_INTL_COUNTRY.match(t):
        return "", t
    m = re.match(r"^(.+?)\s+([A-Z]{2})$", t)
    if m and RE_INTL_COUNTRY.match(m.group(2)):
        return m.group(1).strip(), m.group(2)
    return t, None


def _is_origen_column_line(line: str, merchant: str) -> bool:
    """Middle PDF column (often empty): RENDER.COM, CURSOR.COM, WWW."""
    o = line.strip()
    m = merchant.strip()
    if not o or _is_amount_token(o) or RE_INTL_COUNTRY.match(o):
        return False
    if o.upper() in ("WWW.", "WWW"):
        return True
    if m and o.upper() == m.upper():
        return False
    if RE_ORIGEN_COLUMN.match(o):
        return True
    if m and len(o) <= len(m) + 8 and re.search(r"\.(COM|NET|IO)\b", o, re.I):
        return True
    return False


def _parse_international_vertical_chunk(
    chunk: List[str], fecha: str
) -> Optional[Dict[str, Any]]:
    """
    Map pdftotext vertical cells to statement columns:
    left (fecha, descripción, [origen vacío]) + right (país, monto origen, US$).
    """
    amounts: List[str] = []
    texts: List[str] = []
    for part in chunk:
        p = part.strip()
        if not p:
            continue
        if _is_amount_token(p):
            amounts.append(p)
        else:
            texts.append(p)

    if not amounts:
        return None

    _strip_glued_statement_footer_cells(texts, amounts)

    if not amounts:
        return None

    orig_raw, usd_raw = _assign_intl_orig_and_usd_amounts(amounts)
    if not usd_raw:
        return None
    usd_val = parse_usd_amount(usd_raw)
    if usd_val is None:
        return None

    country = ""
    origen = ""
    merchant = ""

    for t in texts:
        if RE_INTL_COUNTRY.match(t):
            country = t
            continue
        left, cc = _split_trailing_country_code(t)
        if cc:
            country = cc
            if not merchant:
                merchant = left
            elif not origen and left and left.upper() != merchant.upper():
                origen = left
            continue
        if not merchant:
            merchant = t
            continue
        if not origen and _is_origen_column_line(t, merchant):
            origen = t
            continue
        merchant = f"{merchant} {t}".strip()

    if not country:
        if re.search(r"TRASPASO|INTERNACIO", merchant, re.I):
            country = "CH"
        else:
            return None

    row_countries = [t for t in texts if RE_INTL_COUNTRY.match(t)]
    if row_countries and country == "CH" and any(
        c != "CH" for c in row_countries
    ):
        for c in reversed(row_countries):
            if c != "CH":
                country = c
                break

    orig_val, orig_ccy, amount_clp = _resolve_intl_orig_amounts(orig_raw, country, usd_val)

    merchant = _normalize_intl_payment_merchant(merchant)
    if _intl_merchant_is_noise(merchant):
        return None

    desc_bits = [fecha, merchant]
    if origen:
        desc_bits.append(origen)
    desc_bits.extend([country, usd_raw])

    return {
        "layout": "international_usd",
        "transaction_date": fecha,
        "posting_date": fecha,
        "place": origen,
        "description_raw": " | ".join(desc_bits),
        "merchant": merchant[:120],
        "amount_clp": amount_clp,
        "amount_usd": usd_val,
        "amount_orig": orig_val,
        "orig_currency": orig_ccy,
        "country": country,
        "monto_total_a_pagar_clp": None,
        "valor_cuota_mensual_clp": "",
        "nro_cuota_current": "",
        "nro_cuota_total": "",
        "installment_flag": False,
        "interest_rate_text": "",
        "tipo_cuota": "",
        "foreign_currency": "USD",
        "authorization_code": "",
    }


def extract_meta_international(full: str, source_pdf: str) -> Dict[str, Any]:
    meta = extract_meta(full, source_pdf)
    meta["currency"] = "usd"
    if not meta.get("statement_date") or "XXXX" in str(meta.get("statement_date", "")).upper():
        meta["statement_date"] = statement_date_from_source_pdf(source_pdf)
    if not meta.get("statement_date"):
        meta["statement_date"] = _date_after_header(full, "FECHA ESTADO DE CUENTA")
    lines = [ln.strip() for ln in full.splitlines() if ln.strip()]

    def grab_usd(label: str) -> Optional[float]:
        m = re.search(
            rf"{label}[^\dUS$]*US\$\s*([\d.,\-]+)",
            full,
            re.I | re.S,
        )
        if m:
            return parse_usd_amount(m.group(1))
        m2 = re.search(rf"{label}[^\d]*\n\s*US\$\s*([\d.,\-]+)", full, re.I)
        if m2:
            return parse_usd_amount(m2.group(1))
        for i, ln in enumerate(lines):
            if label.upper() in ln.upper():
                for j in range(i - 1, max(i - 6, -1), -1):
                    m3 = re.match(r"^US\$\s*([\d.,\-]+)$", lines[j], re.I)
                    if m3:
                        return parse_usd_amount(m3.group(1))
        return None

    meta["statement_saldo_anterior"] = grab_usd("SALDO ANTERIOR FACTURADO")
    meta["statement_abono"] = grab_usd("ABONO REALIZADO")
    meta["statement_compras_cargos"] = grab_usd("TOTAL DE COMPRAS Y CARGOS")
    meta["statement_deuda_total"] = grab_usd("DEUDA TOTAL")
    m_fac = re.search(
        r"MONTO TOTAL FACTURADO A PAGAR\s+US\$\s*([\d.,\-]+)",
        full,
        re.I,
    )
    if m_fac:
        meta["statement_monto_facturado"] = parse_usd_amount(m_fac.group(1))
    elif meta.get("statement_deuda_total") is not None:
        meta["statement_monto_facturado"] = meta["statement_deuda_total"]
    merge_section_totals_into_meta(meta, full, parse_clp_amount, parse_usd_amount)
    return meta


def _iter_vertical_subchunks(
    chunk: List[str], default_fecha: str
) -> List[Tuple[str, List[str]]]:
    """Split pdftotext vertical cells when a new operation date appears mid-chunk."""
    segments: List[Tuple[str, List[str]]] = []
    sub: List[str] = []
    sub_fecha = default_fecha
    for part in chunk:
        p = part.strip()
        if re.match(r"^\d{2}/\d{2}/\d{2,4}$", p):
            if sub:
                segments.append((sub_fecha, sub))
                sub = []
            sub_fecha = p
            continue
        sub.append(part)
    if sub:
        segments.append((sub_fecha, sub))
    return segments


RE_INTL_FOOTER_MERCHANT = re.compile(
    r"EMISOR\s+CLIENTE|^(?:EMISOR|CLIENTE|COMPROBANTE)\s*$|DESCRIPCI[ÓO]N\s+OPERACI|MONTO\s+MONEDA\s+ORIGEN|MOVIMIENTOS\s+TARJETA",
    re.I,
)


def _normalize_intl_payment_merchant(merchant: str) -> str:
    m = re.sub(r"\s+EMISOR\s+CLIENTE\s*$", "", str(merchant or "").strip(), flags=re.I).strip()
    if re.search(r"ABONO\s+DE\s+DIVISAS", m, re.I):
        return "ABONO DE DIVISAS"
    if re.search(r"NOTA\s+DE\s+CREDITO", m, re.I):
        return "NOTA DE CREDITO"
    return m


def _intl_merchant_is_noise(merchant: str) -> bool:
    m = str(merchant or "").strip()
    if not m:
        return True
    if RE_INTL_FOOTER_MERCHANT.search(m):
        return True
    if "INFORMACION DE TRANSACCIONES" in m.upper():
        return True
    if "DESCRIPCI" in m.upper() and "OPERACI" in m.upper() and "CIUDAD" in m.upper():
        return True
    return False


def _build_intl_row(
    fecha: str,
    merchant: str,
    country: str,
    orig_raw: str,
    usd_raw: str,
    origen: str = "",
) -> Optional[Dict[str, Any]]:
    merchant = _normalize_intl_payment_merchant(merchant)
    if _intl_merchant_is_noise(merchant):
        return None
    usd_val = parse_usd_amount(usd_raw)
    if usd_val is None:
        return None
    orig_val, orig_ccy, amount_clp = _resolve_intl_orig_amounts(
        orig_raw, country, usd_val
    )
    desc_bits = [fecha, merchant]
    if origen:
        desc_bits.append(origen)
    desc_bits.extend([country, usd_raw])
    return {
        "layout": "international_usd",
        "transaction_date": fecha,
        "posting_date": fecha,
        "place": origen,
        "description_raw": " | ".join(desc_bits),
        "merchant": merchant[:120],
        "amount_clp": amount_clp,
        "amount_usd": usd_val,
        "amount_orig": orig_val,
        "orig_currency": orig_ccy,
        "country": country,
        "monto_total_a_pagar_clp": None,
        "valor_cuota_mensual_clp": "",
        "nro_cuota_current": "",
        "nro_cuota_total": "",
        "installment_flag": False,
        "interest_rate_text": "",
        "tipo_cuota": "",
        "foreign_currency": "USD",
        "authorization_code": "",
    }


RE_INTL_LAYOUT_ROW = re.compile(
    r"^(\d{2}/\d{2}/\d{2})\s+(.+?)\s+([A-Z]{2})\s+([\d.,\-]+)\s+([\d.,\-]+)\s*$"
)
RE_INTL_LAYOUT_DATE = re.compile(r"^(\d{2}/\d{2}/\d{2,4})\s+(.+)$")


def _parse_intl_layout_table_line(line: str) -> Optional[Dict[str, Any]]:
    """
    pdftotext -layout table: FECHA | DESCRIPCIÓN | [CIUDAD] | PAÍS | MONTO ORIGEN | MONTO US$.
    2024 statements use dd/mm/yyyy and an optional city column between merchant and país.
    """
    m = RE_INTL_LAYOUT_DATE.match(line.strip())
    if not m:
        return None
    fecha = m.group(1)
    parts = [p.strip() for p in re.split(r"\s{2,}", m.group(2).strip()) if p.strip()]
    if len(parts) < 4:
        return None
    country_idx = next((i for i, p in enumerate(parts) if RE_INTL_COUNTRY.match(p)), None)
    if country_idx is None or country_idx < 1:
        return None
    if country_idx + 2 >= len(parts):
        return None
    merchant = parts[0]
    country = parts[country_idx]
    orig_raw = parts[country_idx + 1]
    usd_raw = parts[country_idx + 2]
    place = " ".join(parts[1:country_idx]).strip() if country_idx > 1 else ""
    row = _build_intl_row(fecha, merchant, country, orig_raw, usd_raw, origen=place)
    return row


def _parse_international_layout_document(full_layout: str) -> List[Dict[str, Any]]:
    """
    Wide table rows: FECHA | DESCRIPCIÓN | PAÍS | MONTO MONEDA ORIGEN | MONTO US$.
    Column order is always origen then US$ (source of truth).
    """
    out: List[Dict[str, Any]] = []
    for raw in full_layout.splitlines():
        line = raw.strip()
        if not line:
            continue
        up = line.upper()
        if (
            "TOTAL OPERACIONES" in up
            or "MOVIMIENTOS TARJETA" in up
            or "CARGOS, COMISIONES" in up
            or line.startswith("EMISOR")
        ):
            continue
        row = _parse_intl_layout_table_line(line)
        if row:
            out.append(row)
            continue
        m = RE_INTL_LAYOUT_ROW.match(line)
        if not m:
            continue
        fecha, merchant, country, orig_raw, usd_raw = (
            m.group(1),
            m.group(2).strip(),
            m.group(3),
            m.group(4).strip(),
            m.group(5).strip(),
        )
        if not merchant or not RE_INTL_COUNTRY.match(country):
            continue
        row = _build_intl_row(fecha, merchant, country, orig_raw, usd_raw)
        if row:
            out.append(row)
    return out


def _intl_row_loose_key(r: Dict[str, Any]) -> str:
    """Same calendar line (date + merchant + country), ignoring amounts."""
    return _sha1(
        "|".join(
            [
                str(r.get("transaction_date", "")),
                _intl_merchant_core(
                    str(r.get("merchant", "")),
                    str(r.get("place", "")),
                ),
                str(r.get("country", "")).upper().strip(),
            ]
        )
    )


def _vertical_intl_row_superseded_by_layout(
    vertical_row: Dict[str, Any], layout_rows: List[Dict[str, Any]]
) -> bool:
    """Drop vertical row when layout already has the same purchase (MONTO US$ is authoritative)."""
    usd = float(vertical_row.get("amount_usd") or 0)
    orig = vertical_row.get("amount_orig")
    has_orig = orig is not None and float(orig or 0) > 0
    if usd > _MAX_PLAUSIBLE_INTL_LINE_USD:
        loose = _intl_row_loose_key(vertical_row)
        for layout_row in layout_rows:
            if _intl_row_loose_key(layout_row) != loose:
                continue
            layout_usd = float(layout_row.get("amount_usd") or 0)
            if layout_usd > 0 and layout_usd <= _MAX_PLAUSIBLE_INTL_LINE_USD:
                return True
        return False
    if usd <= 0:
        return False
    v_loose = _intl_row_loose_key(vertical_row)
    for layout_row in layout_rows:
        if _intl_row_loose_key(layout_row) == v_loose:
            return True
        layout_usd = float(layout_row.get("amount_usd") or 0)
        if layout_usd > 0 and abs(layout_usd - usd) < 0.02:
            if (
                str(vertical_row.get("transaction_date", ""))
                == str(layout_row.get("transaction_date", ""))
                and str(vertical_row.get("country", "")).upper()
                == str(layout_row.get("country", "")).upper()
                and _intl_merchant_core(
                    str(vertical_row.get("merchant", "")),
                    str(vertical_row.get("place", "")),
                )
                == _intl_merchant_core(
                    str(layout_row.get("merchant", "")),
                    str(layout_row.get("place", "")),
                )
            ):
                return True
    return False


def _intl_row_merge_key(r: Dict[str, Any]) -> str:
    usd = float(r.get("amount_usd") or 0)
    orig = float(r.get("amount_orig") or 0)
    # Same merchant/day can appear twice (e.g. two Dublin rides); US$ column disambiguates.
    if usd > 0 and usd <= _MAX_PLAUSIBLE_INTL_LINE_USD:
        amt_tag = f"{usd:.4f}"
    elif orig > 0:
        amt_tag = f"orig:{orig:.4f}"
    else:
        amt_tag = f"{usd:.4f}"
    return _sha1(
        "|".join(
            [
                str(r.get("transaction_date", "")),
                _intl_merchant_core(
                    str(r.get("merchant", "")),
                    str(r.get("place", "")),
                ),
                str(r.get("country", "")).upper().strip(),
                amt_tag,
            ]
        )
    )


def _intl_row_parse_quality(r: Dict[str, Any]) -> Tuple[int, float]:
    """Prefer rows with both amount columns and a plausible MONTO US$."""
    usd = float(r.get("amount_usd") or 0)
    orig = r.get("amount_orig")
    has_orig = bool(orig is not None and float(orig) > 0)
    has_usd = usd > 0
    plausible_usd = has_usd and usd <= _MAX_PLAUSIBLE_INTL_LINE_USD
    score = int(has_orig) + int(has_usd) + int(plausible_usd)
    return (score, -usd if has_orig else usd)


def _merge_intl_parsed_rows(
    vertical_rows: List[Dict[str, Any]],
    layout_rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Layout table wins on ties (correct orig/US$ columns); vertical fills rows layout missed."""
    merged: Dict[str, Dict[str, Any]] = {}
    for r in vertical_rows:
        if _vertical_intl_row_superseded_by_layout(r, layout_rows):
            continue
        k = _intl_row_merge_key(r)
        prev = merged.get(k)
        if prev is None or _intl_row_parse_quality(r) > _intl_row_parse_quality(prev):
            merged[k] = r
    for r in layout_rows:
        k = _intl_row_merge_key(r)
        prev = merged.get(k)
        if prev is None or _intl_row_parse_quality(r) >= _intl_row_parse_quality(prev):
            merged[k] = r
    by_loose_usd: Dict[str, Dict[str, Any]] = {}
    for r in merged.values():
        usd = float(r.get("amount_usd") or 0)
        if usd > 0:
            bucket = "|".join(
                [
                    str(r.get("transaction_date", "")),
                    str(r.get("country", "")).upper().strip(),
                    f"{usd:.4f}",
                ]
            )
        else:
            m = str(r.get("merchant") or "").upper()
            if "ABONO DE DIVISAS" in m:
                pay = "ABONO DE DIVISAS"
            elif "NOTA DE CREDITO" in m:
                pay = "NOTA DE CREDITO"
            elif "TRASPASO" in m and "DEUDA" in m:
                pay = "TRASPASO DEUDA"
            else:
                pay = m[:40]
            bucket = f"{r.get('transaction_date')}|{usd:.4f}|{pay}"
        prev = by_loose_usd.get(bucket)
        if prev is None or _intl_row_parse_quality(r) >= _intl_row_parse_quality(prev):
            by_loose_usd[bucket] = r
    return list(by_loose_usd.values())


def parse_international_usd_document(
    full_vertical: str, full_layout: str = ""
) -> List[Dict[str, Any]]:
    lines = [ln.strip() for ln in full_vertical.splitlines() if ln.strip()]
    vertical_out: List[Dict[str, Any]] = []
    i = 0
    while i < len(lines):
        m = re.match(r"^(\d{2}/\d{2}/\d{2,4})$", lines[i])
        if not m:
            i += 1
            continue
        fecha = m.group(1)
        j = i + 1
        chunk: List[str] = []
        while j < len(lines) and not re.match(r"^\d{2}/\d{2}/\d{2,4}$", lines[j]):
            if (
                re.match(r"^\d+\.\s", lines[j])
                or re.match(r"^\d+\.[A-Za-zÁÉÍÓÚ]", lines[j])
                or "COMPROBANTE" in lines[j].upper()
            ):
                break
            chunk.append(lines[j])
            j += 1
        if len(chunk) < 1:
            i += 1
            continue
        for sub_fecha, sub_chunk in _iter_vertical_subchunks(chunk, fecha):
            row = _parse_international_vertical_chunk(sub_chunk, sub_fecha)
            if row:
                vertical_out.append(row)
        i = j
    if full_layout.strip():
        layout_out = _parse_international_layout_document(full_layout)
        return _merge_intl_parsed_rows(vertical_out, layout_out)
    return vertical_out


def _norm_header_cell(s: str) -> str:
    return (
        str(s or "")
        .strip()
        .replace("\ufeff", "")
        .lower()
        .replace(" ", "_")
    )


def load_baseline_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        return []
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        r = csv.reader(f, delimiter=";")
        header = next(r, None)
        if not header:
            return []
        idx = {_norm_header_cell(h): i for i, h in enumerate(header)}

        def col(name: str) -> int:
            return idx.get(name, -1)

        i_id = col("purchase_id")
        i_label = col("label")
        i_principal = col("principal_clp")
        i_n = col("installment_count")
        i_paid = col("installments_paid")
        i_cuota = col("cuota_clp")
        for row in r:
            if not row or not any(str(c).strip() for c in row):
                continue
            if str(row[0]).strip().startswith("#"):
                continue
            try:
                rows.append(
                    {
                        "purchase_id": str(row[i_id]).strip() if i_id >= 0 else "",
                        "label": str(row[i_label]).strip() if i_label >= 0 else "",
                        "principal_clp": int(str(row[i_principal]).replace(".", "").replace(",", ".")) if i_principal >= 0 and row[i_principal] else 0,
                        "installment_count": int(row[i_n]) if i_n >= 0 and row[i_n] else 0,
                        "installments_paid": int(row[i_paid]) if i_paid >= 0 and row[i_paid] else 0,
                        "cuota_clp": int(str(row[i_cuota]).replace(".", "").replace(",", ".")) if i_cuota >= 0 and row[i_cuota] else 0,
                    }
                )
            except Exception:
                continue
    return [x for x in rows if x.get("purchase_id") and x.get("label")]


def peek_pdf_text(path: Path) -> str:
    """Lightweight text peek so `80_*.pdf` international statements are not forced to CLP wide layout."""
    try:
        return subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        reader = PdfReader(str(path))
        return "\n".join((page.extract_text() or "") for page in reader.pages)


def _ascii_upper(text: str) -> str:
    folded = unicodedata.normalize("NFD", str(text or ""))
    stripped = "".join(c for c in folded if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", stripped).upper()


def is_bci_lider_statement_text(full: str) -> bool:
    upper = _ascii_upper(full)
    if "WORLDMEMBER" in upper or "MONTO ORIGEN OPERAC" in upper or "W. LIMITED" in upper:
        return False
    if "BANCO DE CREDITO" in upper:
        return True
    compact = upper.replace(" ", "")
    if re.search(r"NUMEROTARJETA[X]{8,}\d{4}", compact):
        return "MONTO TOTAL FACTURADO" in upper and "PERIODO FACTURADO" in upper
    return False


def choose_parser(path: Path, full: str = "") -> str:
    if not full.strip():
        full = peek_pdf_text(path)
    upper = full.upper()
    if is_bci_lider_statement_text(full):
        return "compact"
    if "ESTADO DE CUENTA INTERNACIONAL" in upper or (
        "INTERNACIONAL" in upper and "MONTO US$" in upper
    ):
        return "international_usd"
    name = path.name.lower()
    if name == "estado-de-cuenta-usd.pdf":
        return "international_usd"
    if name.startswith("80_"):
        return "wide"
    if _clp_statement_looks_wide_layout(upper):
        return "wide"
    return "compact"


def _clp_statement_looks_wide_layout(upper: str) -> bool:
    """Santander multi-column CLP tables (LUGAR / MONTO ORIGEN / VALOR CUOTA)."""
    return (
        "MONTO ORIGEN OPERAC" in upper
        and ("VALOR CUOTA" in upper or "N° CUOTA" in upper or "Nº CUOTA" in upper)
    )


def parse_clp_document(full: str, parser: str) -> List[Dict[str, Any]]:
    """Parse CLP statement; fall back to wide when compact misses rows."""
    if parser == "wide":
        return parse_wide_document(full)
    compact_rows = parse_compact_document(full)
    wide_rows = parse_wide_document(full)
    if not compact_rows:
        return wide_rows
    if len(wide_rows) > len(compact_rows):
        return wide_rows
    return compact_rows


def extract_pdf_text(path: Path, parser: str) -> Tuple[List[str], str]:
    """International USD: `pdftotext` (one field per line). CLP compact/wide: pypdf (merged rows)."""
    if parser == "international_usd":
        try:
            full = subprocess.check_output(
                ["pdftotext", str(path), "-"],
                text=True,
                stderr=subprocess.DEVNULL,
            )
            return [], full
        except (FileNotFoundError, subprocess.CalledProcessError, OSError):
            pass
    reader = PdfReader(str(path))
    pages: List[str] = []
    for p in reader.pages:
        pages.append(p.extract_text() or "")
    return pages, "\n".join(pages)


RE_STMT_DATE_CELL = re.compile(r"^(\d{1,2})\s*/\s*(\d{1,2})\s*/\s*(\d{4})$")


def normalize_statement_date(raw: str) -> str:
    s = str(raw or "").strip()
    if not s or "XXXX" in s.upper():
        return ""
    m = RE_STMT_DATE_CELL.match(s)
    if m:
        return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    m2 = re.match(r"^(\d{2}/\d{2}/\d{4})$", s)
    return m2.group(1) if m2 else ""


def statement_date_from_source_pdf(source_pdf: str) -> str:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})\s", str(source_pdf or "").strip())
    if not m:
        return ""
    return f"{int(m.group(3)):02d}/{int(m.group(2)):02d}/{m.group(1)}"


def _date_after_header(full: str, header: str, within: int = 14) -> str:
    lines = [ln.strip() for ln in full.splitlines()]
    for i, ln in enumerate(lines):
        if header.upper() in ln.upper():
            for j in range(i + 1, min(i + 1 + within, len(lines))):
                cand = normalize_statement_date(lines[j])
                if cand:
                    return cand
    return ""


def _fill_period_and_pay_by(meta: Dict[str, Any], full: str) -> None:
    if meta.get("period_from") and meta.get("pay_by"):
        return
    lines = [ln.strip() for ln in full.splitlines() if ln.strip()]
    period_dates: List[str] = []
    for i, ln in enumerate(lines):
        if re.search(r"PER[IÍ]ODO\s+FACTURADO\s+DESDE", ln, re.I):
            inline = re.findall(r"(\d{2}/\d{2}/\d{4})", ln)
            period_dates.extend(inline)
            for j in range(i + 1, min(i + 8, len(lines))):
                if re.search(r"PER[IÍ]ODO\s+FACTURADO\s+HASTA|PAGAR\s+HASTA", lines[j], re.I):
                    break
                m = re.match(r"^(\d{2}/\d{2}/\d{4})$", lines[j])
                if m:
                    period_dates.append(m.group(1))
            break
    if len(period_dates) >= 2:
        meta.setdefault("period_from", period_dates[0])
        meta.setdefault("period_to", period_dates[1])
    if len(period_dates) >= 3:
        meta.setdefault("pay_by", period_dates[2])
    if not meta.get("pay_by"):
        m = re.search(r"PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})", full, re.I)
        if m:
            meta["pay_by"] = m.group(1)


def extract_meta(full: str, source_pdf: str) -> Dict[str, Any]:
    meta: Dict[str, Any] = {
        "source_pdf": source_pdf,
        "statement_date": "",
        "period_from": "",
        "period_to": "",
        "pay_by": "",
        "card_last4": "",
        "card_product": "",
        "raw_header_snippet": "",
    }
    m = re.search(
        r"FECHA\s+ESTADO\s+DE\s+CUENTA\s+(\d{2}/\d{2}/\d{4})",
        full,
        re.I,
    ) or re.search(r"FECHA\s+ESTADO\s+DE\s+CUENTA\s*(\d{2}/\d{2}/\d{4})", full, re.I)
    if m:
        meta["statement_date"] = normalize_statement_date(m.group(1))
    if not meta["statement_date"]:
        m = re.search(
            r"(\d{1,2}\s*/\s*\d{1,2}\s*/\s*\d{4})\s*FECHA\s+ESTADO\s+DE\s+CUENTA",
            full,
            re.I,
        )
        if m:
            meta["statement_date"] = normalize_statement_date(m.group(1))
    if not meta["statement_date"]:
        m = re.search(
            r"FECHA\s+ESTADO\s+DE\s+CUENTA[\s\n]+(\d{1,2}\s*/\s*\d{1,2}\s*/\s*\d{4})",
            full,
            re.I,
        )
        if m:
            meta["statement_date"] = normalize_statement_date(m.group(1))
    m = re.search(
        r"PER[IÍ]ODO\s+FACTURADO[^\d]*(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
        full,
        re.I,
    )
    if m:
        meta["period_from"], meta["period_to"] = m.group(1), m.group(2)
    m = re.search(r"PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})", full, re.I)
    if m:
        meta["pay_by"] = m.group(1)
    m = re.search(r"X{4}\s*X{4}\s*X{4}\s*(\d{4})", full)
    if m:
        meta["card_last4"] = m.group(1)
    if re.search(r"WORLDMEMBER\s+MASTER", full, re.I):
        meta["card_product"] = "WORLDMEMBER_MASTER"
    elif re.search(r"W\.\s*LIMITED\s+VISA", full, re.I):
        meta["card_product"] = "W_LIMITED_VISA"
    elif re.search(r"VISA", full, re.I):
        meta["card_product"] = "VISA"
    elif re.search(r"MASTER", full, re.I):
        meta["card_product"] = "MASTER"
    if is_bci_lider_statement_text(full):
        meta["card_product"] = "LIDER_BCI"
        meta["card_issuer"] = "bci"
    if not meta["statement_date"]:
        meta["statement_date"] = _date_after_header(full, "FECHA ESTADO DE CUENTA")
    if not meta["statement_date"]:
        meta["statement_date"] = statement_date_from_source_pdf(source_pdf)
    if "XXXX" in str(meta.get("statement_date", "")).upper():
        meta["statement_date"] = statement_date_from_source_pdf(source_pdf) or _date_after_header(
            full, "FECHA ESTADO DE CUENTA"
        )
    _fill_period_and_pay_by(meta, full)
    monto_candidates: List[int] = []
    for m_total in re.finditer(
        r"MONTO\s+TOTAL\s+FACTURADO(?:\s+A\s+PAGAR)?[^\$]*\$\s*([\d.\-]+)",
        full,
        re.I,
    ):
        v = parse_clp_amount(m_total.group(1))
        if v is not None and v > 0:
            monto_candidates.append(v)
    if monto_candidates:
        meta["statement_monto_facturado"] = max(monto_candidates)
    m_deuda = re.search(r"DEUDA\s+TOTAL[^\$]*\$\s*([\d.\-]+)", full, re.I)
    if m_deuda:
        meta["statement_deuda_total"] = parse_clp_amount(m_deuda.group(1))
    m_prev = re.search(
        r"MONTO\s+FACTURADO\s+A\s+PAGAR\s*\(PER[IÍ]ODO\s+ANTERIOR\)[^\$]*\$\s*([\d.\-]+)",
        full,
        re.I,
    )
    if m_prev:
        meta["statement_saldo_anterior"] = parse_clp_amount(m_prev.group(1))
    m_pagado = re.search(
        r"MONTO\s+PAGADO\s+PER[IÍ]ODO\s+ANTERIOR[^\$]*\$\s*([\d.\-]+)",
        full,
        re.I,
    )
    if m_pagado:
        meta["pdf_monto_pagado_anterior"] = parse_clp_amount(m_pagado.group(1))
        if meta.get("statement_abono") is None:
            meta["statement_abono"] = parse_clp_amount(m_pagado.group(1))
    merge_section_totals_into_meta(meta, full, parse_clp_amount, parse_usd_amount)
    meta["raw_header_snippet"] = full[:400].replace("\n", " ")
    return meta


def statement_sort_key(meta: Dict[str, Any]) -> Tuple[int, int, int]:
    s = meta.get("statement_date") or "01/01/2000"
    try:
        d, m, y = s.split("/")
        return int(y), int(m), int(d)
    except Exception:
        return (2000, 1, 1)


RE_RATE_SPLIT = re.compile(r"(\d,\d{2}\s*%)")
RE_COMPACT_SIMPLE = re.compile(
    r"^(\d{2}/\d{2}/\d{2})\s*(.*?)\s*\$\s*([-]?[\d.]+)\s*(.*)$"
)
RE_WIDE_PLACE_DATE = re.compile(
    r"^([A-Za-zÁ-ÿ][A-Za-zÁ-ÿ0-9\s\.\-]*?)\s+(\d{2}/\d{2}/\d{4})\s+(.+?)\s+\$\s*([-]?[\d.]+)\s*$"
)
RE_WIDE_DATE_FIRST = re.compile(
    r"^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+\$\s*([-]?[\d.]+)\s*$"
)
RE_WIDE_INST = re.compile(
    r"^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+CUOTA\s+COMERCIO\s+(\d,\d{2})\s*%\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s+(\d{1,2})/(\d{1,2})\s+\$\s*([\d.]+)\s*$",
    re.I,
)
RE_WIDE_PERIODIC = re.compile(
    r"^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(\d{2})\s+CUOTAS\s+COMERC\s+(\d,\d{2})\s*%\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s*$",
    re.I,
)
RE_WIDE_PRECIO_SUMMARY = re.compile(
    r"^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(\d,\d{2}\s*%)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s+(\d{1,2})/(\d{1,2})\s+\$\s*([\d.]+)\s*$",
    re.I,
)
# Older Master layout: «TCOM 2 03 CUOTAS, TASA 3,01 % $ orig $ final $ cuota» (no NN/MM index).
RE_WIDE_TCOM_CUOTAS_TASA = re.compile(
    r"^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+TCOM\s+(\d+)\s+(\d{2})\s+CUOTAS,\s+TASA\s+(\d,\d{2}\s*%)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s*$",
    re.I,
)


def _wide_installment_merchant_from_desc(desc: str) -> str:
    """Strip trailing cuota plan labels; keep merchant (e.g. FLOW *COMUNIDAD VICT)."""
    s = desc.strip()
    stripped = re.sub(
        r"\s+(?:N/CUOTAS\s+PRECIO|TRES\s+CUOTAS\s+PREC|\d{2}\s+CUOTAS\s+COMERC|CUOTA\s+(?:FIJA|VARIABLE|COMERCIO))\s*$",
        "",
        s,
        flags=re.I,
    ).strip()
    return stripped or s


def _tipo_cuota_from_precio_description(desc: str) -> str:
    u = desc.upper()
    if "CUOTA FIJA" in u:
        return "CUOTA FIJA"
    if "CUOTA VARIABLE" in u:
        return "CUOTA VARIABLE"
    if "N/CUOTAS PRECIO" in u:
        return "N/CUOTAS PRECIO"
    if "TRES CUOTAS PREC" in u:
        return "TRES CUOTAS PREC"
    m = re.search(r"(\d{2})\s+CUOTAS\s+COMERC", u)
    if m:
        return f"{m.group(1)} CUOTAS COMERC"
    return "INSTALLMENT PRECIO SUMMARY"


def _is_installment_precio_summary_description(desc: str) -> bool:
    u = desc.upper()
    return (
        "N/CUOTAS PRECIO" in u
        or "TRES CUOTAS PREC" in u
        or bool(re.search(r"\d{2}\s+CUOTAS\s+COMERC", u))
        or "CUOTA FIJA" in u
        or "CUOTA VARIABLE" in u
    )


def _is_tcom_cuotas_tasa_description(desc: str) -> bool:
    return bool(re.search(r"\d{2}\s+CUOTAS,\s+TASA", desc, re.I))


def _append_wide_tcom_cuotas_tasa_row(
    out: List[Dict[str, Any]], line: str, m: re.Match[str]
) -> None:
    fecha = m.group(1)
    merchant_base = m.group(2).strip()
    tcom_plan = m.group(3)
    nplan = int(m.group(4))
    rate = m.group(5)
    tot1 = parse_clp_amount(m.group(6))
    tot2 = parse_clp_amount(m.group(7))
    cuota = parse_clp_amount(m.group(8))
    merchant = f"{merchant_base} TCOM {tcom_plan}".strip()
    out.append(
        {
            "layout": "wide_master_tcom_cuotas_tasa",
            "transaction_date": fecha,
            "posting_date": fecha,
            "place": "",
            "description_raw": line,
            "merchant": merchant,
            "amount_clp": tot1 or 0,
            "monto_total_a_pagar_clp": tot2 or tot1 or 0,
            "monto_origen_operacion_clp": tot1 or 0,
            "valor_cuota_mensual_clp": cuota or "",
            "nro_cuota_current": "",
            "nro_cuota_total": nplan,
            "installment_flag": True,
            "interest_rate_text": rate,
            "tipo_cuota": f"{nplan:02d} CUOTAS TCOM",
            "foreign_currency": _extract_fx(merchant_base),
            "authorization_code": _extract_auth(merchant_base),
        }
    )


def _append_wide_precio_installment_row(
    out: List[Dict[str, Any]], line: str, m: re.Match[str]
) -> None:
    fecha = m.group(1)
    desc = m.group(2).strip()
    rate = m.group(3)
    tot1 = parse_clp_amount(m.group(4))
    tot2 = parse_clp_amount(m.group(5))
    nc, nt = int(m.group(6)), int(m.group(7))
    cuota = parse_clp_amount(m.group(8))
    merchant = _wide_installment_merchant_from_desc(desc)
    out.append(
        {
            "layout": "wide_master_precio_summary",
            "transaction_date": fecha,
            "posting_date": fecha,
            "place": "",
            "description_raw": line,
            "merchant": merchant,
            "amount_clp": tot1 or 0,
            "monto_total_a_pagar_clp": tot2 or tot1 or 0,
            "monto_origen_operacion_clp": tot1 or 0,
            "valor_cuota_mensual_clp": cuota or "",
            "nro_cuota_current": nc,
            "nro_cuota_total": nt,
            "installment_flag": True,
            "interest_rate_text": rate,
            "tipo_cuota": _tipo_cuota_from_precio_description(desc),
            "foreign_currency": _extract_fx(desc),
            "authorization_code": _extract_auth(desc),
        }
    )


def parse_tail_installment_suffix(suffix: str) -> Optional[Dict[str, Any]]:
    """
    After the interest rate, e.g. 'N/CUOTAS PRECIO $7.41602/12APPLE.COM CL APPLE'.
    """
    suf = suffix.strip()
    m = re.search(r"(\d{1,2})/(\d{1,2})([A-Za-z0-9*].*)$", suf)
    if not m:
        return None
    cur, tot = int(m.group(1)), int(m.group(2))
    merchant = m.group(3).strip()
    dol = suf.rfind("$", 0, m.start())
    if dol < 0:
        return None
    # Include all digits of current-cuota index (group 1) — m.start() is its first char.
    jammed = suf[dol + 1 : m.end(1)].strip()
    tipo = suf[:dol].strip()
    for w in (2, 1):
        if len(jammed) <= w:
            continue
        head_amt, tail_digits = jammed[:-w], jammed[-w:]
        if not tail_digits.isdigit():
            continue
        if int(tail_digits) != cur:
            continue
        amt = parse_clp_amount(head_amt)
        if amt is not None and amt > 0:
            return {
                "valor_cuota_mensual_clp": amt,
                "nro_cuota_current": cur,
                "nro_cuota_total": tot,
                "merchant": merchant,
                "installment_descriptor": tipo,
            }
    return None


def try_parse_compact_installment(line: str) -> Optional[Dict[str, Any]]:
    parts = RE_RATE_SPLIT.split(line, maxsplit=1)
    if len(parts) < 3:
        return None
    prefix, rate_marker, suffix = parts[0], parts[1], parts[2]
    m = re.match(r"^(\d{2}/\d{2}/\d{2})\s+(.+)$", prefix.strip())
    if not m:
        return None
    fecha_op = m.group(1)
    amounts_chunk = m.group(2)
    ams = [parse_clp_amount(x) for x in re.findall(r"\$\s*([-]?[\d.]+)", amounts_chunk)]
    ams = [a for a in ams if a is not None]
    if len(ams) < 1:
        return None
    tail = parse_tail_installment_suffix(suffix)
    if not tail:
        return None
    monto_total = ams[0]
    monto_origen = ams[1] if len(ams) > 1 else ams[0]
    return {
        "layout": "compact_de_installment",
        "transaction_date": fecha_op,
        "posting_date": fecha_op,
        "place": "",
        "description_raw": line.strip(),
        "merchant": tail["merchant"],
        "amount_clp": monto_origen,
        "monto_total_a_pagar_clp": monto_total,
        "monto_origen_operacion_clp": monto_origen,
        "valor_cuota_mensual_clp": tail["valor_cuota_mensual_clp"],
        "nro_cuota_current": tail["nro_cuota_current"],
        "nro_cuota_total": tail["nro_cuota_total"],
        "installment_flag": True,
        "interest_rate_text": rate_marker.strip(),
        "tipo_cuota": tail["installment_descriptor"],
        "foreign_currency": "",
        "authorization_code": "",
    }


def try_parse_compact_simple(line: str) -> Optional[Dict[str, Any]]:
    m = RE_COMPACT_SIMPLE.match(line.strip())
    if not m:
        return None
    fecha, place_chunk, amt_raw, tail = (
        m.group(1),
        m.group(2).strip(),
        m.group(3),
        m.group(4).strip(),
    )
    amt = parse_clp_amount(amt_raw)
    if amt is None:
        return None
    place = place_chunk
    merchant = (tail or "").strip()
    country = ""
    merchant, cc = _split_trailing_country_code(merchant)
    if cc:
        country = cc
    place, cc2 = _split_trailing_country_code(place)
    if cc2 and not country:
        country = cc2
    return {
        "layout": "compact_de_simple",
        "transaction_date": fecha,
        "posting_date": fecha,
        "place": place,
        "description_raw": line.strip(),
        "merchant": merchant,
        "amount_clp": amt,
        "monto_total_a_pagar_clp": amt,
        "monto_origen_operacion_clp": amt,
        "valor_cuota_mensual_clp": "",
        "nro_cuota_current": "",
        "nro_cuota_total": "",
        "installment_flag": False,
        "interest_rate_text": "",
        "tipo_cuota": "",
        "foreign_currency": _extract_fx(merchant),
        "authorization_code": _extract_auth(merchant),
        "country": country,
    }


def _extract_fx(s: str) -> str:
    if re.search(r"\bUSD\b|US\$|U\.S\.\s*\$", s, re.I):
        m = re.search(r"(US\$|USD)\s*([\d.,]+)?", s, re.I)
        return m.group(0) if m else "USD"
    return ""


def _extract_auth(s: str) -> str:
    m = re.search(r"\b(\d{6,12})\b", s)
    return m.group(1) if m else ""


def parse_compact_document(full: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for raw in full.splitlines():
        line = raw.strip()
        if not line:
            continue
        if len(line) < 10:
            continue
        inst = try_parse_compact_installment(line)
        if inst:
            out.append(inst)
            continue
        # Avoid classifying installment rows as "simple" — compact simple regex matches the first $…
        # before the rate marker (e.g. "…$ 163.980$ 163.9800,00 %N/CUOTAS…").
        if re.search(r"\d,\d{2}\s*%", line):
            continue
        if RE_COMPACT_SIMPLE.match(line):
            row = try_parse_compact_simple(line)
            if row:
                out.append(row)
    return out


def parse_wide_document(full: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for raw in full.splitlines():
        line = raw.strip()
        if not line:
            continue
        if len(line) < 12:
            continue
        m = RE_WIDE_INST.match(line)
        if m:
            fecha = m.group(1)
            desc = m.group(2).strip()
            rate = m.group(3)
            tot1 = parse_clp_amount(m.group(4))
            tot2 = parse_clp_amount(m.group(5))
            nc, nt = int(m.group(6)), int(m.group(7))
            cuota = parse_clp_amount(m.group(8))
            out.append(
                {
                    "layout": "wide_master_installment",
                    "transaction_date": fecha,
                    "posting_date": fecha,
                    "place": "",
                    "description_raw": line,
                    "merchant": desc,
                    "amount_clp": tot1 or 0,
                    "monto_total_a_pagar_clp": tot2 or tot1 or 0,
                    "monto_origen_operacion_clp": tot1 or 0,
                    "valor_cuota_mensual_clp": cuota or "",
                    "nro_cuota_current": nc,
                    "nro_cuota_total": nt,
                    "installment_flag": True,
                    "interest_rate_text": rate,
                    "tipo_cuota": "CUOTA COMERCIO",
                    "foreign_currency": _extract_fx(desc),
                    "authorization_code": _extract_auth(desc),
                }
            )
            continue
        m = RE_WIDE_PERIODIC.match(line)
        if m:
            fecha = m.group(1)
            desc = m.group(2).strip()
            nplan = int(m.group(3))
            rate = m.group(4)
            a = parse_clp_amount(m.group(5))
            b = parse_clp_amount(m.group(6))
            cuota = parse_clp_amount(m.group(7))
            out.append(
                {
                    "layout": "wide_master_periodic_summary",
                    "transaction_date": fecha,
                    "posting_date": fecha,
                    "place": "",
                    "description_raw": line,
                    "merchant": desc,
                    "amount_clp": cuota or 0,
                    "monto_total_a_pagar_clp": b or a or 0,
                    "monto_origen_operacion_clp": a or 0,
                    "valor_cuota_mensual_clp": cuota or "",
                    "nro_cuota_current": "",
                    "nro_cuota_total": nplan,
                    "installment_flag": True,
                    "interest_rate_text": rate,
                    "tipo_cuota": f"{nplan:02d} CUOTAS COMERC",
                    "foreign_currency": _extract_fx(desc),
                    "authorization_code": _extract_auth(desc),
                }
            )
            continue
        m = RE_WIDE_TCOM_CUOTAS_TASA.match(line)
        if m:
            _append_wide_tcom_cuotas_tasa_row(out, line, m)
            continue
        m = RE_WIDE_PRECIO_SUMMARY.match(line)
        if m and _is_installment_precio_summary_description(m.group(2)):
            _append_wide_precio_installment_row(out, line, m)
            continue
        m = RE_WIDE_PLACE_DATE.match(line)
        if m:
            place, fecha, desc, amt_raw = m.group(1), m.group(2), m.group(3), m.group(4)
            amt = parse_clp_amount(amt_raw)
            if amt is None:
                continue
            out.append(
                {
                    "layout": "wide_master_simple",
                    "transaction_date": fecha,
                    "posting_date": fecha,
                    "place": place.strip(),
                    "description_raw": line,
                    "merchant": desc.strip(),
                    "amount_clp": amt,
                    "monto_total_a_pagar_clp": amt,
                    "monto_origen_operacion_clp": amt,
                    "valor_cuota_mensual_clp": "",
                    "nro_cuota_current": "",
                    "nro_cuota_total": "",
                    "installment_flag": False,
                    "interest_rate_text": "",
                    "tipo_cuota": "",
                    "foreign_currency": _extract_fx(desc),
                    "authorization_code": _extract_auth(desc),
                }
            )
            continue
        m = RE_WIDE_DATE_FIRST.match(line)
        if m:
            fecha, desc, amt_raw = m.group(1), m.group(2), m.group(3)
            m_tcom = RE_WIDE_TCOM_CUOTAS_TASA.match(line)
            if m_tcom:
                _append_wide_tcom_cuotas_tasa_row(out, line, m_tcom)
                continue
            m_precio = RE_WIDE_PRECIO_SUMMARY.match(line)
            if m_precio and _is_installment_precio_summary_description(m_precio.group(2)):
                _append_wide_precio_installment_row(out, line, m_precio)
                continue
            amt = parse_clp_amount(amt_raw)
            if amt is None:
                continue
            out.append(
                {
                    "layout": "wide_master_date_first",
                    "transaction_date": fecha,
                    "posting_date": fecha,
                    "place": "",
                    "description_raw": line,
                    "merchant": desc.strip(),
                    "amount_clp": amt,
                    "monto_total_a_pagar_clp": amt,
                    "monto_origen_operacion_clp": amt,
                    "valor_cuota_mensual_clp": "",
                    "nro_cuota_current": "",
                    "nro_cuota_total": "",
                    "installment_flag": False,
                    "interest_rate_text": "",
                    "tipo_cuota": "",
                    "foreign_currency": _extract_fx(desc),
                    "authorization_code": _extract_auth(desc),
                }
            )
    return out


def _date_iso_for_dedupe(d: str) -> str:
    t = (d or "").strip()
    if not t:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
        return t
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$", t)
    if not m:
        return t
    day, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 1900 if y >= 70 else 2000
    return f"{y:04d}-{mo:02d}-{day:02d}"


def row_dedupe_key(card_group: str, r: Dict[str, Any]) -> str:
    if str(r.get("layout", "")) == "international_usd" or r.get("amount_usd") not in (
        None,
        "",
        0,
    ):
        m = _intl_merchant_core(
            str(r.get("merchant", "")),
            str(r.get("place", "")),
        )
        raw_d = r.get("transaction_date") or r.get("posting_date") or ""
        d = _date_iso_for_dedupe(str(raw_d))
        usd = r.get("amount_usd")
        try:
            usd_f = float(usd) if usd not in (None, "") else 0.0
        except (TypeError, ValueError):
            usd_f = 0.0
        cc = str(r.get("country", "")).upper().strip()
        if usd_f <= 0:
            stmt = _date_iso_for_dedupe(str(r.get("statement_date") or ""))
            return _sha1(f"{card_group}|intl|pay|{m}|{cc}|{usd_f:.4f}|{d}|{stmt}")
        return _sha1(f"{card_group}|intl|{m}|{cc}|{usd_f:.4f}|{d}")
    m = norm_merchant(str(r.get("merchant", "")))
    if r.get("installment_flag"):
        tot = r.get("monto_total_a_pagar_clp") or r.get("amount_clp") or ""
        nt = r.get("nro_cuota_total") or ""
        cur = r.get("nro_cuota_current") or ""
        raw_d = r.get("transaction_date") or r.get("posting_date") or ""
        d = _date_iso_for_dedupe(str(raw_d))
        cuota = r.get("valor_cuota_mensual_clp") or ""
        return _sha1(f"{card_group}|inst|{m}|{tot}|{nt}|{d}|{cur}|{cuota}")
    amt = r.get("amount_clp") or ""
    raw_d = r.get("transaction_date") or r.get("posting_date") or ""
    d = _date_iso_for_dedupe(str(raw_d))
    return _sha1(f"{card_group}|one|{m}|{amt}|{d}")


def fuzzy_ratio(a: str, b: str) -> float:
    a, b = norm_merchant(a), norm_merchant(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def match_baseline(
    r: Dict[str, Any], baseline: List[Dict[str, Any]]
) -> Tuple[str, str, str]:
    if not r.get("installment_flag"):
        return "", "n/a", ""
    mer = str(r.get("merchant", ""))
    try:
        vcuota = int(r.get("valor_cuota_mensual_clp") or 0)
    except Exception:
        vcuota = 0
    try:
        ncur = int(r.get("nro_cuota_current") or 0)
    except Exception:
        ncur = 0
    try:
        ntot_pdf = int(r.get("nro_cuota_total") or 0)
    except Exception:
        ntot_pdf = 0

    candidates = baseline
    if ntot_pdf > 0:
        filtered = [b for b in baseline if int(b.get("installment_count") or 0) == ntot_pdf]
        if filtered:
            candidates = filtered

    best_id = ""
    best_score = 0.0
    best_ratio = 0.0
    best_cuota_ok = False
    best_idx_ok = False
    best_paid = 0
    notes: List[str] = []

    for b in candidates:
        label = str(b.get("label", ""))
        ratio = fuzzy_ratio(mer, label)
        cuota_b = int(b.get("cuota_clp") or 0)
        paid = int(b.get("installments_paid") or 0)
        ntot = int(b.get("installment_count") or 0)
        cuota_ok = cuota_b > 0 and vcuota > 0 and abs(cuota_b - vcuota) <= max(500, int(0.02 * cuota_b))
        idx_ok = ncur > 0 and ncur == paid + 1
        ntot_ok = True
        if ntot_pdf and ntot and ntot_pdf != ntot:
            ntot_ok = False
            notes.append(f"total_mismatch baseline_ntot={ntot} pdf={ntot_pdf}")
        score = ratio
        if cuota_ok:
            score += 0.25
        if idx_ok:
            score += 0.2
        if ntot_ok:
            score += 0.05
        if score > best_score:
            best_score = score
            best_id = str(b.get("purchase_id", ""))
            best_ratio = ratio
            best_cuota_ok = cuota_ok
            best_idx_ok = idx_ok
            best_paid = paid

    if best_id and best_score >= 0.45 and not (best_cuota_ok or best_ratio >= 0.35):
        best_id = ""

    extra_notes = list(dict.fromkeys(notes))
    if best_id and not best_idx_ok and ncur > 0:
        extra_notes.append(f"pdf_cuota_index={ncur} baseline_installments_paid={best_paid}")

    if best_score >= 0.85 and best_id:
        return best_id, "high", ";".join(extra_notes)
    if best_score >= 0.65 and best_id:
        return best_id, "medium", ";".join(extra_notes)
    if best_id and best_score >= 0.45:
        return best_id, "low", ";".join(extra_notes)
    return "", "none", ";".join(extra_notes) if extra_notes else "no_baseline_candidate"


CSV_COLUMNS: List[str] = [
    "card_group",
    "source_pdf",
    "statement_date",
    "period_from",
    "period_to",
    "pay_by",
    "card_last4",
    "card_product",
    "parser_layout",
    "raw_line",
    "transaction_date",
    "posting_date",
    "place",
    "merchant",
    "description_merged",
    "amount_clp",
    "monto_total_a_pagar_clp",
    "monto_origen_operacion_clp",
    "installment_flag",
    "nro_cuota_current",
    "nro_cuota_total",
    "valor_cuota_mensual_clp",
    "interest_rate_text",
    "tipo_cuota",
    "foreign_currency",
    "authorization_code",
    "dedupe_key",
    "is_duplicate_across_statements",
    "canonical_row_id",
    "row_id",
    "matched_excel_row",
    "match_confidence",
    "mismatch_notes",
    "currency",
    "amount_usd",
    "amount_orig",
    "orig_currency",
    "country",
    "statement_saldo_anterior",
    "statement_abono",
    "statement_compras_cargos",
    "statement_deuda_total",
    "statement_monto_facturado",
]


def _cell_int(v: Any) -> Optional[int]:
    if isinstance(v, int):
        return v
    if v is None or v == "":
        return None
    return parse_clp_amount(str(v))


def emit_row(
    *,
    card_group: str,
    source_pdf: str,
    meta: Dict[str, Any],
    pr: Dict[str, Any],
    raw_line: str,
    row_id: str,
) -> Dict[str, Any]:
    return {
        "card_group": card_group,
        "source_pdf": source_pdf,
        "statement_date": meta.get("statement_date", ""),
        "period_from": meta.get("period_from", ""),
        "period_to": meta.get("period_to", ""),
        "pay_by": meta.get("pay_by", ""),
        "card_last4": meta.get("card_last4", ""),
        "card_product": meta.get("card_product", ""),
        "parser_layout": pr.get("layout", ""),
        "raw_line": raw_line,
        "transaction_date": pr.get("transaction_date", ""),
        "posting_date": pr.get("posting_date", ""),
        "place": pr.get("place", ""),
        "merchant": pr.get("merchant", ""),
        "description_merged": " | ".join(
            x
            for x in [str(pr.get("place") or "").strip(), str(pr.get("merchant") or "").strip()]
            if x
        ),
        "amount_clp": fmt_clp(_cell_int(pr.get("amount_clp"))),
        "monto_total_a_pagar_clp": fmt_clp(_cell_int(pr.get("monto_total_a_pagar_clp"))),
        "monto_origen_operacion_clp": fmt_clp(_cell_int(pr.get("monto_origen_operacion_clp"))),
        "installment_flag": "true" if pr.get("installment_flag") else "false",
        "nro_cuota_current": str(pr.get("nro_cuota_current") or ""),
        "nro_cuota_total": str(pr.get("nro_cuota_total") or ""),
        "valor_cuota_mensual_clp": fmt_clp(_cell_int(pr.get("valor_cuota_mensual_clp"))),
        "interest_rate_text": pr.get("interest_rate_text", ""),
        "tipo_cuota": pr.get("tipo_cuota", ""),
        "foreign_currency": pr.get("foreign_currency", ""),
        "authorization_code": pr.get("authorization_code", ""),
        "dedupe_key": "",
        "is_duplicate_across_statements": "",
        "canonical_row_id": "",
        "row_id": row_id,
        "matched_excel_row": "",
        "match_confidence": "",
        "mismatch_notes": "",
        "currency": meta.get("currency", "clp"),
        "amount_usd": fmt_usd(pr.get("amount_usd")),
        "amount_orig": fmt_usd(pr.get("amount_orig")) if pr.get("amount_orig") is not None else "",
        "orig_currency": pr.get("orig_currency", ""),
        "country": pr.get("country", ""),
        "statement_saldo_anterior": fmt_usd(meta.get("statement_saldo_anterior"))
        if meta.get("currency") == "usd"
        else fmt_clp(_cell_int(meta.get("statement_saldo_anterior"))),
        "statement_abono": fmt_usd(meta.get("statement_abono"))
        if meta.get("currency") == "usd"
        else fmt_clp(_cell_int(meta.get("statement_abono"))),
        "statement_compras_cargos": fmt_usd(meta.get("statement_compras_cargos"))
        if meta.get("currency") == "usd"
        else fmt_clp(_cell_int(meta.get("statement_compras_cargos"))),
        "statement_deuda_total": fmt_usd(meta.get("statement_deuda_total"))
        if meta.get("currency") == "usd"
        else fmt_clp(_cell_int(meta.get("statement_deuda_total"))),
        "statement_monto_facturado": fmt_usd(meta.get("statement_monto_facturado"))
        if meta.get("currency") == "usd"
        else fmt_clp(_cell_int(meta.get("statement_monto_facturado"))),
    }


def write_csv(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=CSV_COLUMNS,
            quoting=csv.QUOTE_MINIMAL,
            lineterminator="\n",
        )
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in CSV_COLUMNS})


RE_ESTADO_NUM = re.compile(r"^estado-de-cuenta-(\d+)\.pdf$", re.I)
RE_ORGANIZED_CC = re.compile(r"^\d{4}-\d{2}-\d{2} ", re.I)


def card_group_for_pdf_name(name: str) -> str:
    """Heuristic card group for legacy parsers (A/B/INTL/BCI)."""
    lower = name.lower()
    if "usd" in lower or "internacional" in lower:
        return "INTL"
    if "eecc" in lower or re.search(r"\b4343\b", lower):
        return "BCI"
    for token in ("4901", "4902", "4141"):
        if token in lower:
            return "B"
    return "A"


def mark_pdf_corrupt(p: Path) -> Path:
    """Rename an unreadable PDF so it is skipped on the next parse run."""
    if p.stem.endswith("-CORRUPT"):
        return p
    dest = p.with_name(f"{p.stem}-CORRUPT{p.suffix}")
    if dest.exists():
        return dest
    p.rename(dest)
    return dest


def discover_pdf_jobs(pdfs_dir: Path) -> List[Tuple[str, Path]]:
    """Scan credit-card statement PDF dir. Returns (card_group, path) jobs."""
    jobs: List[Tuple[str, Path]] = []
    if not pdfs_dir.is_dir():
        return jobs
    clp_numeric: List[Tuple[int, Path]] = []
    for entry in sorted(pdfs_dir.iterdir()):
        if not entry.is_file() or entry.suffix.lower() != ".pdf":
            continue
        name = entry.name
        if re.search(r"\(\d+\)\.pdf$", name, re.I):
            continue
        lower = name.lower()
        if RE_ORGANIZED_CC.match(name):
            jobs.append((card_group_for_pdf_name(name), entry))
            continue
        if lower == "estado-de-cuenta-usd.pdf":
            jobs.append(("INTL", entry))
            continue
        m = RE_ESTADO_NUM.match(name)
        if m:
            clp_numeric.append((int(m.group(1)), entry))
            continue
        if name.startswith("80_"):
            jobs.append(("B", entry))
            continue
        jobs.append((card_group_for_pdf_name(name), entry))
    for _n, p in sorted(clp_numeric, key=lambda t: t[0]):
        jobs.append(("A", p))
    return jobs


def fallback_downloads_jobs() -> List[Tuple[str, Path]]:
    """Legacy paths when `credit-card-statements` is empty (developer machine)."""
    jobs: List[Tuple[str, Path]] = []
    downloads = Path.home() / "Downloads"
    for n in range(18, 5, -1):
        jobs.append(("A", downloads / f"estado-de-cuenta-{n}.pdf"))
    for name in [
        "80_9576_REDACTED_20240322.pdf",
        "80_9827_REDACTED_20240424.pdf",
        "80_10073_REDACTED_20240524.pdf",
        "80_10312_REDACTED_20240624.pdf",
        "80_10567_REDACTED_20240724.pdf",
    ]:
        jobs.append(("B", downloads / name))
    for n in range(33, 18, -1):
        jobs.append(("B", downloads / f"estado-de-cuenta-{n}.pdf"))
    usd_pdf = downloads / "estado-de-cuenta-usd.pdf"
    if usd_pdf.is_file():
        jobs.append(("INTL", usd_pdf))
    return jobs


def main() -> int:
    load_repo_dotenv()
    no_reconcile = "--no-reconcile" in sys.argv
    no_cache = "--no-cache" in sys.argv
    force_reparse = "--force-reparse" in sys.argv
    pdfs_dir = Path(os.environ.get("CFRASER_PDFS_DIR", str(CFRASER_DIR / "credit-card-statements")))
    out_all = os.environ.get("CC_PARSE_OUTPUT_CSV")
    parser_version = parser_cache_version()
    jobs = discover_pdf_jobs(pdfs_dir)
    if not jobs:
        jobs = fallback_downloads_jobs()
        print(f"# pdf source: fallback ~/Downloads ({len(jobs)} candidates)")
    else:
        print(f"# pdf source: {pdfs_dir} ({len(jobs)} files)")
    if no_cache:
        print("# parse cache: disabled (--no-cache)")
    else:
        print(f"# parse cache: {PARSE_CACHE_PER_PDF_DIR} (version {parser_version})")
        if force_reparse:
            print("# parse cache: --force-reparse (ignore hits)")

    if qpdf_available():
        for name, note in repair_unreadable_pdfs_in_dir(
            pdfs_dir, password=statement_pdf_password()
        ):
            print(f"# qpdf\t{name}\t{note}")
    else:
        print("# WARN qpdf not installed — skip PDF repair (brew install qpdf)")

    baseline = load_baseline_rows(BASELINE_CSV)

    per_pdf_counts: Dict[str, int] = {}
    failures: List[str] = []
    all_rows: List[Dict[str, Any]] = []
    pdf_context: Dict[str, Dict[str, Any]] = {}
    cache_hits = 0
    cache_misses = 0

    for card_group, p in jobs:
        if p.stem.endswith("-CORRUPT"):
            continue
        if not p.is_file():
            failures.append(f"missing:{p}")
            continue
        cached: Optional[Dict[str, Any]] = None
        if not no_cache:
            cached = load_parse_cache(
                p, parser_version, force=force_reparse
            )
        try:
            if cached is not None:
                cache_hits += 1
                meta = dict(cached.get("meta") or {})
                parsed = list(cached.get("parsed") or [])
                effective_group = str(cached.get("effective_group") or card_group)
                rows = rows_from_parse_payload(
                    effective_group=effective_group,
                    source_pdf=p.name,
                    meta=meta,
                    parsed=parsed,
                    baseline=baseline,
                )
                pdf_context[p.name] = {
                    "meta": meta,
                    "full": str(cached.get("full") or ""),
                    "layout": str(cached.get("layout") or ""),
                    "parser": str(cached.get("parser") or ""),
                }
            else:
                cache_misses += 1
                rows, ctx = parse_one_pdf(card_group, p, baseline)
                effective_group = "INTL" if ctx["parser"] == "international_usd" else card_group
                pdf_context[p.name] = ctx
                if not no_cache:
                    save_parse_cache(
                        p,
                        parser_version,
                        {
                            "source_pdf": p.name,
                            "card_group": card_group,
                            "effective_group": effective_group,
                            "parser": ctx["parser"],
                            "meta": ctx["meta"],
                            "parsed": ctx["parsed"],
                            "full": ctx["full"],
                            "layout": ctx["layout"],
                        },
                    )
            all_rows.extend(rows)
            per_pdf_counts[p.name] = len(rows)
        except Exception as e:
            renamed = mark_pdf_corrupt(p)
            failures.append(f"read_error:{renamed}:{e}")
            print(f"# CORRUPT renamed {renamed.name} ({e})")
            continue

    if not no_cache:
        print(f"# parse cache hits={cache_hits} misses={cache_misses}")

    # Dedupe across statements (oldest statement wins canonical)
    by_key_first: Dict[str, str] = {}
    sorted_meta_indices = sorted(
        range(len(all_rows)),
        key=lambda i: statement_sort_key(
            {
                "statement_date": all_rows[i].get("statement_date") or "01/01/2000",
            }
        ),
    )
    ordered_rows = [all_rows[i] for i in sorted_meta_indices]
    # Build map statement_date per row from row itself
    def sort_key_row(r: Dict[str, Any]) -> Tuple[int, int, int]:
        return statement_sort_key({"statement_date": r.get("statement_date") or "01/01/2000"})

    ordered_rows.sort(key=sort_key_row)

    for r in ordered_rows:
        dk = row_dedupe_key(str(r.get("card_group")), _row_to_pr(r))
        r["dedupe_key"] = dk
        if dk in by_key_first:
            r["is_duplicate_across_statements"] = "true"
            r["canonical_row_id"] = by_key_first[dk]
        else:
            r["is_duplicate_across_statements"] = "false"
            r["canonical_row_id"] = str(r.get("row_id"))
            by_key_first[dk] = str(r.get("row_id"))

    # Restore original order: by card A/B lists then file order as discovered
    def orig_order_key(r: Dict[str, Any]) -> Tuple[str, str, str]:
        return (str(r.get("card_group")), str(r.get("source_pdf")), str(r.get("row_id")))

    all_rows_sorted = sorted(all_rows, key=orig_order_key)

    reconcile_results: List[Any] = []
    reconcile_fail_count = 0
    if not no_reconcile:
        rows_by_pdf: Dict[str, List[Dict[str, Any]]] = {}
        for r in all_rows_sorted:
            pdf = str(r.get("source_pdf") or "")
            rows_by_pdf.setdefault(pdf, []).append(r)
        for pdf_name, ctx in sorted(pdf_context.items()):
            meta = ctx.get("meta") or {}
            full_text = str(ctx.get("full") or "")
            layout_text = str(ctx.get("layout") or "")
            stmt_rows = rows_by_pdf.get(pdf_name, [])
            result = reconcile_statement(
                pdf_name,
                meta,
                stmt_rows,
                full_text,
                parse_clp_amount,
                parse_usd_amount,
                layout_text=layout_text,
            )
            reconcile_results.append(result)
            if (
                reconcile_statement_required(pdf_name, full_text)
                and result.skip_reason
                not in ("zero_rows", "incomplete_parse")
                and not result.ok
            ):
                reconcile_fail_count += 1
            summary = result.mismatch_summary()
            if summary:
                for r in stmt_rows:
                    if str(r.get("is_duplicate_across_statements") or "").lower() != "true":
                        prev = str(r.get("mismatch_notes") or "").strip()
                        r["mismatch_notes"] = f"{prev};{summary}" if prev else summary
                        break
        write_reconciliation_jsonl(
            CFRASER_DIR / "cc-statements-parse-reconciliation.jsonl",
            reconcile_results,
        )

    write_csv(Path(out_all) if out_all else CFRASER_DIR / "cc-statements-parsed-all.csv", all_rows_sorted)
    if out_all:
        print(f"# wrote {out_all} rows={len(all_rows_sorted)}")
        return 0
    write_csv(
        CFRASER_DIR / "cc-statements-parsed-card-a.csv",
        [r for r in all_rows_sorted if r.get("card_group") == "A"],
    )
    write_csv(
        CFRASER_DIR / "cc-statements-parsed-card-b.csv",
        [r for r in all_rows_sorted if r.get("card_group") == "B"],
    )

    backfill: List[Dict[str, Any]] = []
    for r in all_rows_sorted:
        if r.get("installment_flag") != "true":
            continue
        if r.get("match_confidence") in ("high", "medium"):
            continue
        backfill.append(r)
    write_csv(CFRASER_DIR / "credit-card-installments-backfill-suggested.csv", backfill)

    print("# parse-cc-statement-pdfs summary")
    print(f"# baseline_rows={len(baseline)} from {BASELINE_CSV.name}")
    total = sum(per_pdf_counts.values())
    print(f"# total_parsed_rows={total} pdfs_ok={len(per_pdf_counts)} failures={len(failures)}")
    zero_row_pdfs = [name for name, c in sorted(per_pdf_counts.items()) if c == 0]
    for name, c in sorted(per_pdf_counts.items()):
        mark = " ZERO_ROWS" if c == 0 else ""
        print(f"# rows={c}\t{name}{mark}")
    if zero_row_pdfs:
        print(f"# WARN unparsed_pdfs={len(zero_row_pdfs)} (0 transaction rows)")
        for name in zero_row_pdfs:
            print(f"# WARN zero_rows\t{name}")
    if failures:
        for x in failures:
            print(f"# FAIL {x}")
    if not no_reconcile and reconcile_results:
        ok_n = sum(1 for r in reconcile_results if r.ok or r.skip_reason == "zero_rows")
        fail_n = reconcile_fail_count
        print(f"# RECONCILE ok={ok_n} fail={fail_n} total={len(reconcile_results)}")
        for r in reconcile_results:
            if r.skip_reason == "zero_rows":
                continue
            if not r.ok:
                issues = ",".join(r.issue_codes) or "unknown"
                print(f"# RECONCILE_FAIL\t{r.source_pdf}\t{issues}")
                for ch in r.checks:
                    if not ch.ok:
                        print(
                            f"#   {ch.code}: expected={ch.expected} actual={ch.actual} delta={ch.delta}"
                        )
    reconcile_exit = reconcile_fail_count > 0 if not no_reconcile else False
    return 1 if failures or zero_row_pdfs or reconcile_exit else 0


def _row_to_pr(r: Dict[str, Any]) -> Dict[str, Any]:
    def num(x: Any) -> Any:
        if x is None or str(x).strip() == "":
            return ""
        try:
            return int(str(x).strip())
        except Exception:
            return ""

    return {
        "merchant": r.get("merchant", ""),
        "installment_flag": r.get("installment_flag") == "true",
        "monto_total_a_pagar_clp": num(r.get("monto_total_a_pagar_clp", "")),
        "amount_clp": num(r.get("amount_clp", "")),
        "nro_cuota_total": num(r.get("nro_cuota_total", "")),
        "nro_cuota_current": num(r.get("nro_cuota_current", "")),
        "transaction_date": r.get("transaction_date", ""),
        "posting_date": r.get("posting_date", ""),
        "valor_cuota_mensual_clp": num(r.get("valor_cuota_mensual_clp", "")),
    }


if __name__ == "__main__":
    raise SystemExit(main())
