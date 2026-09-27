"""Shared Santander cartola layout helpers (column bounds, summary totals, row dates)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Dict, List, Optional, Tuple

from statement_values import parse_clp_amount

RE_AMOUNT = re.compile(r"\d{1,3}(?:\.\d{3})+")
# Legacy cartolas sometimes show sub-10k CLP without thousand separators (e.g. "900", "566", "850").
RE_SMALL_TRAILING = re.compile(r"\s(\d{1,4})\s*$")
RE_SMALL_INLINE = re.compile(r"(?<!de )(\s)(\d{2,4})(?=\s(?!d[ií]as\b))")
RE_BRANCH_COLUMN = re.compile(r"^\s*\d{2}/\d{2}\s+401\s")
RE_NON_MOVEMENT_LINE = re.compile(
    r"dirección ha cambiado|días no hemos recibido|INFORMESE SOBRE|Resumen de Comisiones",
    re.I,
)


def is_dated_branch_column_line(line: str) -> bool:
    return bool(RE_BRANCH_COLUMN.match(line.rstrip()))
RE_CREDIT_HINT = re.compile(
    r"ABONO|Transf\.?\s+de\b|Transf\s+de\b|Traspaso\s+Internet\s+desde|desde\s+Cta|P\.PROVEEDOR|DEPOSITO",
    re.I,
)
RE_DEBIT_HINT = re.compile(
    r"COMPRA|Transf\.?\s+a\b|Transf\s+a\b|Traspaso\s+Internet\s+a|Traspaso\s+a\b|a\s+otro",
    re.I,
)


@dataclass(frozen=True)
class AmountColumnBounds:
    """Character positions from pdftotext -layout lines."""

    cargo_abono_split: int
    saldo_min: int


@dataclass(frozen=True)
class CartolaSummaryTotals:
    saldo_inicial_clp: int
    total_cargos_clp: int
    total_abonos_clp: int
    saldo_final_clp: int


def detect_vista_column_bounds(text: str) -> AmountColumnBounds:
    """Infer cargo / abono / saldo columns from CUENTAMATICA / cuenta vista headers."""
    cargo_abono_split = 150
    saldo_min = 195
    for line in text.splitlines():
        upper = line.upper()
        if "CARGOS" in upper and "ABONOS" in upper and "CHEQUES" not in upper:
            ci = upper.find("CARGOS")
            ai = upper.find("ABONOS")
            if ci >= 0 and ai > ci:
                cargo_abono_split = (ci + len("CARGOS") + ai) // 2
        if "FECHA" in upper and "NUMERO" in upper and "SALDO" in upper:
            pos = upper.rfind("SALDO")
            if pos > 120:
                saldo_min = pos
    return AmountColumnBounds(cargo_abono_split, saldo_min)


def detect_checking_column_bounds(text: str) -> AmountColumnBounds:
    """Infer cargo / abono / saldo columns from cuenta corriente DETALLE headers."""
    cargo_abono_split = 130
    saldo_min = 145
    for line in text.splitlines():
        upper = line.upper()
        if "CARGOS" in upper and "ABONOS" in upper:
            ci = upper.find("CARGOS")
            ai = upper.find("ABONOS")
            if ci >= 0 and ai > ci:
                cargo_abono_split = (ci + len("CARGOS") + ai) // 2
        if "FECHA" in upper and "DESCRIPCION" in upper and "SALDO" in upper:
            pos = upper.rfind("SALDO")
            if pos > 100:
                saldo_min = pos
    return AmountColumnBounds(cargo_abono_split, saldo_min)


def classify_small_amount_side(line: str, pos: int, bounds: AmountColumnBounds) -> str:
    """Return 'cargo' or 'abono' for a sub-10k amount not in dotted CLP format."""
    credit = bool(RE_CREDIT_HINT.search(line))
    debit = bool(RE_DEBIT_HINT.search(line))
    if credit and not debit:
        return "abono"
    if debit and not credit:
        return "cargo"
    if pos < bounds.cargo_abono_split:
        return "cargo"
    return "abono"


def assign_small_amount(
    side: str,
    val: int,
    cargo: Optional[int],
    abono: Optional[int],
) -> Tuple[Optional[int], Optional[int]]:
    if side == "cargo" and cargo is None:
        return val, abono
    if side == "abono" and abono is None:
        return cargo, val
    return cargo, abono


def amounts_by_column(
    line: str,
    bounds: AmountColumnBounds,
) -> Tuple[Optional[int], Optional[int]]:
    cargo: Optional[int] = None
    abono: Optional[int] = None
    for m in RE_AMOUNT.finditer(line):
        pos = m.start()
        val = parse_clp_amount(m.group())
        if val is None:
            continue
        if pos >= bounds.saldo_min:
            continue
        if pos < bounds.cargo_abono_split:
            cargo = val
        else:
            abono = val

    allow_small = not RE_NON_MOVEMENT_LINE.search(line)
    if allow_small:
        for m in RE_SMALL_INLINE.finditer(line):
            pos = m.start(2)
            val = int(m.group(2))
            if pos >= bounds.saldo_min:
                continue
            inline_min = max(80, bounds.cargo_abono_split - 25)
            if pos < inline_min:
                continue
            side = classify_small_amount_side(line, pos, bounds)
            cargo, abono = assign_small_amount(side, val, cargo, abono)

        sm = RE_SMALL_TRAILING.search(line)
        if sm is not None:
            pos = sm.start(1)
            val = int(sm.group(1))
            if pos < bounds.saldo_min:
                if val < 10 and not RE_CREDIT_HINT.search(line) and not RE_DEBIT_HINT.search(line):
                    pass
                else:
                    side = classify_small_amount_side(line, pos, bounds)
                    cargo, abono = assign_small_amount(side, val, cargo, abono)

    return cargo, abono


def saldo_column_amount(line: str, bounds: AmountColumnBounds) -> Optional[int]:
    """Rightmost CLP amount in the SALDO column (Saldo Dia rows)."""
    best: Optional[int] = None
    best_pos = -1
    for m in RE_AMOUNT.finditer(line):
        pos = m.start()
        if pos < bounds.saldo_min:
            continue
        val = parse_clp_amount(m.group())
        if val is None:
            continue
        if pos >= best_pos:
            best_pos = pos
            best = val
    if best is not None:
        return best
    sm = RE_SMALL_TRAILING.search(line)
    if sm is not None and sm.start(1) >= bounds.saldo_min:
        return int(sm.group(1))
    for m in RE_SMALL_INLINE.finditer(line):
        pos = m.start(2)
        if pos >= bounds.saldo_min:
            return int(m.group(2))
    return None


def _month_end_utc_ymd(month_key: str) -> str:
    y, mo = int(month_key[:4]), int(month_key[5:7])
    if mo == 12:
        return date(y, 12, 31).isoformat()
    return date(y, mo + 1, 1).fromordinal(date(y, mo + 1, 1).toordinal() - 1).isoformat()


def is_last_calendar_day_of_month(ymd: str) -> bool:
    t = str(ymd or "").strip()
    if len(t) != 10 or t[4] != "-" or t[7] != "-":
        return False
    mk = t[:7]
    return t == _month_end_utc_ymd(mk)


def _add_calendar_months(ym: str, delta: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    m0 = m - 1 + delta
    y += m0 // 12
    m = m0 % 12 + 1
    return f"{y:04d}-{m:02d}"


def _calendar_months_span_inclusive(from_ym: str, to_ym: str) -> int:
    y, m = int(from_ym[:4]), int(from_ym[5:7])
    ey, em = int(to_ym[:4]), int(to_ym[5:7])
    count = 0
    for _ in range(600):
        count += 1
        if y == ey and m == em:
            break
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return count


def effective_cartola_start_ym(from_iso: str, to_iso: str) -> str:
    """Non-day-1 DESDE marks the prior period boundary (not a movement month).

    Both bounds are required: a cartola without DESDE or HASTA raises (as `effectiveCartolaStartYm`
    in `server/src/calendarMonth.ts` does)."""
    from_ym = str(from_iso or "")[:7]
    to_ym = str(to_iso or "")[:7]
    if len(from_ym) != 7 or len(to_ym) != 7:
        raise ValueError(f"cartola period needs DESDE and HASTA: {from_iso!r}..{to_iso!r}")
    if from_ym == to_ym:
        return from_ym
    if is_last_calendar_day_of_month(from_iso):
        return _add_calendar_months(from_ym, 1)
    from_day = int(str(from_iso)[8:10])
    if from_day == 1:
        return from_ym
    if _calendar_months_span_inclusive(from_ym, to_ym) <= 2:
        return to_ym
    return _add_calendar_months(from_ym, 1)


def expand_calendar_months(from_iso: str, to_iso: str) -> List[str]:
    """Inclusive YYYY-MM list from ISO date endpoints (with DESDE boundary adjustment)."""
    end_ym = str(to_iso or "")[:7]
    start_ym = effective_cartola_start_ym(from_iso, to_iso)
    y, m = int(start_ym[:4]), int(start_ym[5:7])
    ey, em = int(end_ym[:4]), int(end_ym[5:7])
    out: List[str] = []
    for _ in range(600):
        out.append(f"{y:04d}-{m:02d}")
        if y == ey and m == em:
            break
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


class CartolaRowDateError(ValueError):
    """A cartola row whose DD/MM does not name one date of the statement period."""


RE_ROW_DD_MM = re.compile(r"(\d{1,2})/(\d{1,2})", re.ASCII)


def _period_bound(label: str, iso: Optional[str]) -> date:
    if not iso:
        raise CartolaRowDateError(f"cartola period {label} missing")
    try:
        return date.fromisoformat(iso)
    except ValueError:
        raise CartolaRowDateError(f"cartola period {label} is not a date: {iso!r}") from None


def cartola_row_date_candidates(
    day: int, month: int, desde_iso: Optional[str], hasta_iso: Optional[str]
) -> List[str]:
    """Every date DD/MM can be in a statement period: for each year from year(DESDE) to
    year(HASTA), DD/MM of that year when it is a real calendar date inside [DESDE, HASTA]."""
    d0 = _period_bound("start (DESDE)", desde_iso)
    d1 = _period_bound("end (HASTA)", hasta_iso)
    out: List[str] = []
    for year in range(d0.year, d1.year + 1):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if d0 <= d <= d1:
            out.append(d.isoformat())
    return out


def cartola_row_date(
    day: int, month: int, desde_iso: Optional[str], hasta_iso: Optional[str]
) -> str:
    """The cartola year rule: a row printed as DD/MM (no year) is the one date of the statement
    period [DESDE, HASTA] it can be. Both bounds are required; no candidate is an error, and so
    are several (a period longer than a year). The TypeScript XLSX reader applies the same rule;
    `server/src/test/cartolaMovementYearCases.json` is asserted by both."""
    candidates = cartola_row_date_candidates(day, month, desde_iso, hasta_iso)
    if len(candidates) != 1:
        raise CartolaRowDateError(
            f"{day:02d}/{month:02d} is {len(candidates)} dates of the period "
            f"{desde_iso}..{hasta_iso}: {', '.join(candidates) or 'none'}"
        )
    return candidates[0]


class PdfCartolaRowDates:
    """Dates of one PDF cartola's rows, resolved in document order.

    Every row takes `cartola_row_date`, except where it is ambiguous: an annual cartola prints
    DD/MM rows that fit two years of its period (15/03/2021-31/03/2022 has two 20/03s). The PDF
    cartolas list rows oldest first, so such a row takes the earliest candidate on or after the
    previous row's date; the document's first row, or one with no candidate on or after the
    previous row, raises with the file and row. Only the PDF parsers use this: the daily XLSX
    (the TypeScript reader) never spans a year."""

    def __init__(self, source_file: str, desde_iso: Optional[str], hasta_iso: Optional[str]) -> None:
        self.source_file = source_file
        self.desde_iso = desde_iso
        self.hasta_iso = hasta_iso
        self.previous: Optional[str] = None

    def resolve(self, dd_mm: str, row: str) -> str:
        where = f"{self.source_file}: row «{' '.join(str(row).split())}»"
        m = RE_ROW_DD_MM.fullmatch(str(dd_mm or "").strip())
        if not m:
            raise CartolaRowDateError(f"{where}: {dd_mm!r} is not a DD/MM date")
        try:
            candidates = cartola_row_date_candidates(
                int(m.group(1)), int(m.group(2)), self.desde_iso, self.hasta_iso
            )
        except CartolaRowDateError as e:
            raise CartolaRowDateError(f"{where}: {e}") from None
        if len(candidates) == 1:
            iso = candidates[0]
        elif not candidates:
            raise CartolaRowDateError(
                f"{where}: {dd_mm} is not a date of the period {self.desde_iso}..{self.hasta_iso}"
            )
        elif self.previous is None:
            raise CartolaRowDateError(
                f"{where}: {dd_mm} can be {' or '.join(candidates)} and no earlier row decides"
            )
        else:
            later = [c for c in candidates if c >= self.previous]
            if not later:
                raise CartolaRowDateError(
                    f"{where}: {dd_mm} can be {' or '.join(candidates)}, none on or after the "
                    f"previous row's {self.previous}"
                )
            iso = later[0]
        self.previous = iso
        return iso


def movement_amount(mv: object) -> int:
    amount = getattr(mv, "amount_clp", None)
    if amount is None and isinstance(mv, dict):
        amount = mv.get("amount_clp")
    return int(amount) if isinstance(amount, int) else 0


def movement_occurred_on(mv: object) -> str:
    raw = getattr(mv, "occurred_on", None)
    if raw is None and isinstance(mv, dict):
        raw = mv.get("occurred_on")
    return str(raw or "")


def validate_saldo_dia_chain(
    saldo_dia: List[Tuple[str, int]],
    movements: List[object],
    summary: CartolaSummaryTotals,
) -> Optional[str]:
    """Each Saldo Dia must equal prior balance + that day's movements; final must match summary."""
    if not saldo_dia:
        return None
    by_date: Dict[str, int] = {}
    for mv in movements:
        iso = movement_occurred_on(mv)
        if len(iso) < 10:
            continue
        by_date[iso] = by_date.get(iso, 0) + movement_amount(mv)

    running = summary.saldo_inicial_clp
    for iso_date, bal in saldo_dia:
        day_moves = by_date.get(iso_date, 0)
        expected = running + day_moves
        if expected != bal:
            return (
                f"Saldo Dia {iso_date}: {bal} != prior {running} + "
                f"day movements {day_moves} (= {expected})"
            )
        running = bal
    if running != summary.saldo_final_clp:
        return (
            f"Saldo Dia chain ends at {running} != "
            f"summary saldo final {summary.saldo_final_clp}"
        )
    return None


def derive_month_saldo_final_clp(
    saldo_dia: List[Tuple[str, int]],
    movements: List[object],
    summary: CartolaSummaryTotals,
    period_from: Optional[str],
    period_to: Optional[str],
) -> Tuple[Optional[Dict[str, int]], Optional[str]]:
    """
    Build per-calendar-month reference saldo from Saldo Dia markers.
    Returns (month_map, error). When saldo_dia is empty, returns (None, None).
    """
    if not saldo_dia:
        return None, None
    if not period_from or not period_to:
        return None, "Saldo Dia present but cartola period_from/period_to missing"

    chain_err = validate_saldo_dia_chain(saldo_dia, movements, summary)
    if chain_err:
        return None, chain_err

    months = expand_calendar_months(period_from, period_to)
    if not months:
        return None, "Could not expand calendar months for Saldo Dia reconciliation"

    result: Dict[str, int] = {}
    for iso_date, balance in saldo_dia:
        ym = iso_date[:7]
        if len(ym) == 7 and ym in months:
            result[ym] = balance

    filled: Dict[str, int] = {}
    prev_end = summary.saldo_inicial_clp
    for ym in months:
        mov_sum = sum(
            movement_amount(mv)
            for mv in movements
            if movement_occurred_on(mv)[:7] == ym
        )
        if ym in result:
            prev_end = result[ym]
            filled[ym] = prev_end
        elif mov_sum != 0:
            return None, f"{ym}: movements parsed but no Saldo Dia marker"
        else:
            filled[ym] = prev_end

    return filled, None


def strip_amounts_from_line(line: str) -> str:
    stripped = RE_AMOUNT.sub("", line)
    stripped = RE_SMALL_INLINE.sub("", stripped)
    return RE_SMALL_TRAILING.sub("", stripped).strip()


RE_VISTA_SUMMARY = re.compile(
    r"Saldo\s+Inicial.*?Cheques\s+o\s+Cargos.*?Dep[óo]sitos\s+o(?:\s+Abonos)?.*?Saldo\s+Final\s*"
    r"(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*)",
    re.I | re.S,
)

RE_CHECKING_SUMMARY = re.compile(
    r"SALDO\s+INICIAL\s+DEPOSITOS\s+OTROS\s+ABONOS\s+CHEQUES\s+OTROS\s+CARGOS\s+IMPUESTOS\s+SALDO\s+FINAL\s+"
    r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)",
    re.I | re.S,
)


def parse_vista_summary_totals(text: str) -> Optional[CartolaSummaryTotals]:
    flat = text.replace("\n", " ")
    m = RE_VISTA_SUMMARY.search(flat)
    if not m:
        return None
    vals = [parse_clp_amount(g) for g in m.groups()]
    if any(v is None for v in vals):
        return None
    return CartolaSummaryTotals(
        saldo_inicial_clp=vals[0],
        total_cargos_clp=vals[1],
        total_abonos_clp=vals[2],
        saldo_final_clp=vals[3],
    )


def parse_checking_summary_totals(flat: str) -> Optional[CartolaSummaryTotals]:
    m = RE_CHECKING_SUMMARY.search(flat)
    if not m:
        return None
    nums = [parse_clp_amount(g) for g in m.groups()]
    if any(v is None for v in nums):
        return None
    saldo_inicial, depositos, otros_abonos, cheques, otros_cargos, impuestos, saldo_final = nums
    return CartolaSummaryTotals(
        saldo_inicial_clp=saldo_inicial,
        total_cargos_clp=cheques + otros_cargos + impuestos,
        total_abonos_clp=depositos + otros_abonos,
        saldo_final_clp=saldo_final,
    )


def movement_credit_debit_totals(movements: List[object]) -> Tuple[int, int]:
    credits = 0
    debits = 0
    for mv in movements:
        amount = getattr(mv, "amount_clp", None)
        if amount is None and isinstance(mv, dict):
            amount = mv.get("amount_clp")
        if not isinstance(amount, int):
            continue
        if amount > 0:
            credits += amount
        elif amount < 0:
            debits += -amount
    return credits, debits


def movement_description(mv: object) -> str:
    desc = getattr(mv, "description", None)
    if desc is None and isinstance(mv, dict):
        desc = mv.get("description")
    return str(desc or "")


def trim_spurious_flavia_credit(summary: CartolaSummaryTotals, movements: List[object]) -> List[object]:
    """Drop a lone FLAVIA credit when it is the sole cause of an abonos over-count."""
    credits, _ = movement_credit_debit_totals(movements)
    if credits <= summary.total_abonos_clp:
        return movements
    diff = credits - summary.total_abonos_clp
    if diff <= 0 or diff >= 5_000:
        return movements
    trimmed = [
        mv
        for mv in movements
        if not (
            (
                getattr(mv, "amount_clp", None) == diff
                or (isinstance(mv, dict) and mv.get("amount_clp") == diff)
            )
            and "FLAVIA" in movement_description(mv).upper()
        )
    ]
    if len(trimmed) == len(movements):
        return movements
    if reconcile_cartola_movements(summary, trimmed) is None:
        return trimmed
    return movements


def reconcile_cartola_movements(
    summary: CartolaSummaryTotals,
    movements: List[object],
) -> Optional[str]:
    """Return error message when parsed movements disagree with document totals."""
    credits, debits = movement_credit_debit_totals(movements)
    if credits != summary.total_abonos_clp:
        return (
            f"abonos mismatch: parsed credits {credits} != "
            f"cartola abonos {summary.total_abonos_clp}"
        )
    if debits != summary.total_cargos_clp:
        return (
            f"cargos mismatch: parsed debits {debits} != "
            f"cartola cargos {summary.total_cargos_clp}"
        )
    expected_final = (
        summary.saldo_inicial_clp + summary.total_abonos_clp - summary.total_cargos_clp
    )
    if expected_final != summary.saldo_final_clp:
        return (
            f"saldo identity mismatch: {summary.saldo_inicial_clp} + "
            f"{summary.total_abonos_clp} - {summary.total_cargos_clp} = "
            f"{expected_final} != saldo final {summary.saldo_final_clp}"
        )
    return None
