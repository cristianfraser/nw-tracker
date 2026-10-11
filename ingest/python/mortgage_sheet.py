"""The mortgage sheet («depto › dividendos» in the personal Numbers file) as payment rows.

The sheet is one row per capital event — the pie, each prepago, each numbered cuota — with the
bank's posted figures typed into a few cells and everything else derived by formulas. Rows for
cuotas not posted yet carry formulas in those same cells (projections), so «posted» is a property
of the cells, not of the date: a numbered row counts when its date, uf día, interés, min UF and
máx UF are typed values (a bare number entered as a formula, «=10.5», is a typed value
too). Projected rows are left out and counted.

Pure: works on a grid of cells `{value, is_formula, formula}`; `read-mortgage-sheet.py` builds
that grid from the file. Column positions are fixed by the header row, which is checked.
"""
from __future__ import annotations

import datetime as _dt
import re
from typing import Any

# Column index → header text the sheet must print there (row 1 of the table). A column that
# moved would silently read another figure, so every used column is pinned.
HEADER_CHECK = {
    0: "cuotas",
    5: "uf día",
    10: "credito restante uf",
    19: "valor uf",
    24: "min UF",
    31: "máx UF",
    46: "incendio",
    48: "desgravamen",
    52: "amortización",
    54: "amortización ext",
    58: "interés",
}

COL = {
    "label": 0,
    "date": 1,
    "pago_clp": 2,
    "pago_uf": 3,
    "uf_day": 5,
    "credito_restante_uf": 10,
    "valor_vivienda_uf": 19,
    "min_uf": 24,
    "max_uf": 31,
    "incendio_clp": 46,
    "incendio_uf": 47,
    "desgravamen_clp": 48,
    "desgravamen_uf": 49,
    "amortizacion_clp": 52,
    "amortizacion_uf": 53,
    "amortizacion_ext_clp": 54,
    "amortizacion_ext_uf": 55,
    "interes_clp": 58,
    "interes_uf": 59,
}

# A numbered row is posted when these cells are typed (not projected by a formula). The pago UF
# cell is not evidence either way: a projected row carries a planned figure, and a paid row may
# hold «=AF37» (the máximo was paid) or «18.3+0.1426».
POSTED_CELLS = ("date", "uf_day", "interes_clp", "min_uf", "max_uf")

UF_DECIMALS = 5
_NUMBER_LITERAL = re.compile(r"^-?\d+(\.\d+)?$")
_PREPAGO = re.compile(r"^prepago\s+\d+$", re.IGNORECASE)


class MortgageSheetError(ValueError):
    pass


def cell(value: Any, is_formula: bool = False, formula: str | None = None) -> dict:
    """A grid cell as the reader builds it (test helper too)."""
    return {"value": value, "is_formula": is_formula, "formula": formula}


def is_typed(c: dict | None) -> bool:
    """A value the user typed: no formula, or a formula that is just a number («=10.5»)."""
    if c is None:
        return False
    if not c.get("is_formula"):
        return c.get("value") not in (None, "")
    f = c.get("formula")
    return isinstance(f, str) and _NUMBER_LITERAL.match(f.strip()) is not None


def check_header(rows: list[list[dict]]) -> None:
    if not rows:
        raise MortgageSheetError("empty table")
    for col, expected in HEADER_CHECK.items():
        got = rows[0][col]["value"] if col < len(rows[0]) else None
        if not isinstance(got, str) or got.strip().lower() != expected.lower():
            raise MortgageSheetError(f"header column {col} is {got!r}, expected {expected!r} — the sheet layout changed")


def _value(row: list[dict], key: str) -> Any:
    i = COL[key]
    return row[i]["value"] if i < len(row) else None


def _number(row: list[dict], key: str, *, label: str) -> float | None:
    v = _value(row, key)
    if v in (None, ""):
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise MortgageSheetError(f"row {label}: {key} is not a number: {v!r}")
    return float(v)


def _clp(row: list[dict], key: str, *, label: str) -> int | None:
    """Pesos, rounded: an old row's formula may carry a fraction (cuota 21's amortización)."""
    v = _number(row, key, label=label)
    return None if v is None else int(round(v))


def _uf(row: list[dict], key: str, *, label: str) -> float | None:
    v = _number(row, key, label=label)
    return None if v is None else round(v, UF_DECIMALS)


def _date(row: list[dict], *, label: str) -> str:
    v = _value(row, "date")
    if isinstance(v, _dt.datetime):
        return v.date().isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    raise MortgageSheetError(f"row {label}: date cell is not a date: {v!r}")


def row_kind(label_value: Any) -> str | None:
    """`cuota` (a number), `pie`, `prepago`, or None for a row to skip (blank label)."""
    if label_value in (None, ""):
        return None
    if isinstance(label_value, bool):
        raise MortgageSheetError(f"unexpected label {label_value!r}")
    if isinstance(label_value, (int, float)):
        if float(label_value) != int(label_value) or int(label_value) <= 0:
            raise MortgageSheetError(f"unexpected cuota number {label_value!r}")
        return "cuota"
    s = str(label_value).strip()
    if s.lower() == "pie":
        return "pie"
    if _PREPAGO.match(s):
        return "prepago"
    raise MortgageSheetError(f"unexpected row label {s!r}")


def row_label(label_value: Any, kind: str) -> str:
    if kind == "cuota":
        return str(int(label_value))
    return " ".join(str(label_value).strip().lower().split())


def is_posted(row: list[dict]) -> bool:
    return all(is_typed(row[COL[k]] if COL[k] < len(row) else None) for k in POSTED_CELLS)


def _payment_row(row: list[dict], kind: str, label: str) -> dict:
    pago_clp = _clp(row, "pago_clp", label=label)
    pago_uf = _uf(row, "pago_uf", label=label)
    uf_day = _number(row, "uf_day", label=label)
    if uf_day is None or uf_day <= 0:
        raise MortgageSheetError(f"row {label}: uf día missing")
    if pago_clp is None:
        raise MortgageSheetError(f"row {label}: pago (CLP) missing")
    if pago_uf is None:
        raise MortgageSheetError(f"row {label}: pago (UF) missing")
    out = {
        "kind": kind,
        "label": label,
        "paid_on": _date(row, label=label),
        "uf_day": round(uf_day, 2),
        "pago_clp": pago_clp,
        "pago_uf": pago_uf,
        "interes_clp": _clp(row, "interes_clp", label=label),
        "interes_uf": _uf(row, "interes_uf", label=label),
        "min_uf": _uf(row, "min_uf", label=label),
        "max_uf": _uf(row, "max_uf", label=label),
        "incendio_clp": _clp(row, "incendio_clp", label=label),
        "incendio_uf": _uf(row, "incendio_uf", label=label),
        "desgravamen_clp": _clp(row, "desgravamen_clp", label=label),
        "desgravamen_uf": _uf(row, "desgravamen_uf", label=label),
        "amortizacion_clp": _clp(row, "amortizacion_clp", label=label),
        "amortizacion_uf": _uf(row, "amortizacion_uf", label=label),
        "amortizacion_ext_clp": _clp(row, "amortizacion_ext_clp", label=label),
        "amortizacion_ext_uf": _uf(row, "amortizacion_ext_uf", label=label),
        "credito_restante_uf": _uf(row, "credito_restante_uf", label=label),
        "valor_vivienda_uf": _uf(row, "valor_vivienda_uf", label=label),
    }
    if out["credito_restante_uf"] is None:
        raise MortgageSheetError(f"row {label}: crédito restante missing")
    if kind == "cuota":
        for k in ("interes_clp", "min_uf", "max_uf", "incendio_clp", "desgravamen_clp", "amortizacion_clp", "amortizacion_ext_clp"):
            if out[k] is None:
                raise MortgageSheetError(f"row {label}: {k} missing on a posted cuota")
    return out


def payment_rows(rows: list[list[dict]]) -> dict:
    """Every pie / prepago row and every posted cuota, in sheet order; projected cuotas counted."""
    check_header(rows)
    out: list[dict] = []
    projected: list[str] = []
    seen: set[str] = set()
    last_cuota: int | None = None
    for r in rows[1:]:
        label_value = r[COL["label"]]["value"] if r else None
        # The table ends in footer rows whose first cell is a total (no date beside it).
        if isinstance(label_value, (int, float)) and not isinstance(label_value, bool) and _value(r, "date") in (None, ""):
            continue
        kind = row_kind(label_value)
        if kind is None:
            continue
        label = row_label(label_value, kind)
        if kind == "cuota":
            # The sheet starts at the first cuota it records (the earlier ones predate it);
            # from there the numbering must not skip or repeat.
            if last_cuota is not None and int(label) != last_cuota + 1:
                raise MortgageSheetError(f"cuota {label} follows cuota {last_cuota}: the numbering must run without gaps")
            last_cuota = int(label)
        if kind == "cuota" and not is_posted(r):
            projected.append(label)
            continue
        if label in seen:
            raise MortgageSheetError(f"row label {label!r} appears twice")
        seen.add(label)
        out.append(_payment_row(r, kind, label))
    return {"rows": out, "projected": projected}
