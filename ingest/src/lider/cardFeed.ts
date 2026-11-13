import {
  amountFitsCurrency,
  parseChileanNumber,
  type CardListingLine,
  type CardUnbilledMovementsPayload,
} from "nw-tracker-contracts";

/**
 * The Lider BCI card feed (what `fetch:lider-bci` stages as `lider-card-movements-*.json`) →
 * a `card.unbilled_movements` payload. All Lider BCI decoding lives here: the «Por facturar»
 * rows of `movfacturarpesos` (national) and `movfacturardolar` (international), `dd/mm/yyyy`
 * dates, the bank's spacing in merchant names, and the `consultasaldos` cupo strings (pesos as
 * plain digits, dollars with a Chilean decimal comma). The server gets canonical fields.
 *
 * The site shows no contract number, so the card is named by issuer `bci` and its last four
 * digits. The listing states no close: it is a complete «Por facturar» list, but the close it
 * starts from is not printed. It also re-lists the cuotas of existing plans at their original
 * purchase date; those go as plain lines (the server skips them as installment overlaps).
 */

/** One `movimiento` row, exactly as the bank answers it. */
export type LiderMovementRow = {
  descripcion: string;
  fecha: string;
  monto: number | string;
  tipo: string;
  cuota: string;
};

export type LiderMovementList = { movimiento: unknown[] };

/** `consultasaldos`, verbatim. */
export type LiderBalances = {
  cupoautpesos: string;
  cupoutilpesos: string;
  cupodisppesos: string;
  cupoautdolar: string;
  cupoutildolar: string;
  cupodispdolar: string;
};

export type LiderCardFeedFile = {
  /** ISO with offset: when the session read the lists. */
  observed_at: string;
  card_last4: string;
  national: LiderMovementList;
  /** Null when the international tab was not read (`international_error` says why). */
  international: LiderMovementList | null;
  international_endpoint?: string | null;
  international_error?: string;
  /** Null when the session got no `consultasaldos` answer (`balances_error` says why). */
  balances: LiderBalances | null;
  balances_error?: string;
};

export const LIDER_ISSUER = "bci";

/** `dd/mm/yyyy` → `YYYY-MM-DD`. Throws on any other shape and on a day the calendar lacks. */
export function liderDateToIso(fecha: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(fecha ?? "").trim());
  const [d, mo, y] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (!m || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`Unexpected Lider BCI movement date "${fecha}" (want dd/mm/yyyy)`);
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The row's currency, from its `tipo`. Anything but CLP / USD throws. */
function rowCurrency(tipo: unknown): "clp" | "usd" { // convention-ok: Lider BCI's card lists one peso and one dollar tab
  const t = String(tipo ?? "").trim().toUpperCase();
  if (t === "CLP") return "clp"; // convention-ok: Lider BCI's card lists one peso and one dollar tab
  if (t === "USD") return "usd"; // convention-ok: Lider BCI's card lists one peso and one dollar tab
  throw new Error(`Unknown Lider BCI movement tipo ${JSON.stringify(tipo)}`);
}

/** `monto` is a signed number (pesos) or a Chilean-format string (a dollar row may print «12,34»). */
function rowAmount(monto: unknown): number {
  if (typeof monto === "number" && Number.isFinite(monto)) return monto;
  if (typeof monto === "string" && monto.trim()) return parseChileanNumber(monto);
  throw new Error(`Unexpected Lider BCI movement monto ${JSON.stringify(monto)}`);
}

/**
 * One bank row → a canonical listing line. `monto` is already debt-positive (a charge positive,
 * a PAGO negative). `expected` is the tab's currency: a row in the other one throws.
 */
export function liderMovementRowToLine(raw: unknown, expected: "clp" | "usd"): CardListingLine { // convention-ok: Lider BCI's card lists one peso and one dollar tab
  if (!raw || typeof raw !== "object") throw new Error(`Unexpected Lider BCI movement row ${JSON.stringify(raw)}`);
  const row = raw as Record<string, unknown>;
  const merchant = String(row.descripcion ?? "").trim().replace(/\s+/g, " ");
  if (!merchant) throw new Error(`Lider BCI movement row without descripcion: ${JSON.stringify(raw)}`);
  const cuota = String(row.cuota ?? "").trim();
  if (cuota) {
    // Never seen filled: its meaning (cuota N of M? a count?) is not known, so it is not guessed.
    throw new Error(`Lider BCI movement row with a cuota "${cuota}" the decoder cannot read: ${JSON.stringify(raw)}`);
  }
  const currency = rowCurrency(row.tipo);
  if (currency !== expected) {
    throw new Error(`Lider BCI ${expected} list holds a ${currency} row: ${JSON.stringify(raw)}`);
  }
  const amount = rowAmount(row.monto);
  if (amount === 0 || !amountFitsCurrency(amount, currency)) {
    throw new Error(`Lider BCI movement amount ${amount} is not a non-zero ${currency} amount: ${JSON.stringify(raw)}`);
  }
  return {
    date: liderDateToIso(String(row.fecha ?? "")),
    merchant,
    currency,
    amount,
    raw_text: JSON.stringify(raw),
  };
}

function listRows(list: unknown, which: string): unknown[] {
  const rows = (list as { movimiento?: unknown } | null)?.movimiento;
  if (!Array.isArray(rows)) throw new Error(`Lider BCI ${which} list has no movimiento array`);
  return rows;
}

function requireLast4(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!/^\d{4}$/.test(text)) throw new Error(`Lider BCI feed has no card last4 (got ${JSON.stringify(raw)})`);
  return text;
}

/** `consultasaldos` → the issuer's credit-line rows, pesos and dollars. */
export function liderIssuerBalances(
  file: LiderCardFeedFile
): NonNullable<CardUnbilledMovementsPayload["issuer_balances"]> {
  const b = file.balances;
  if (!b) return { status: "unavailable", reason: file.balances_error ?? "consultasaldos was not captured" };
  const last4 = requireLast4(file.card_last4);
  const account = { issuer: LIDER_ISSUER, number: last4 };
  const field = (key: keyof LiderBalances) => {
    const v = b[key];
    if (typeof v !== "string") throw new Error(`Lider BCI consultasaldos.${key} is not a string: ${JSON.stringify(v)}`);
    return parseChileanNumber(v);
  };
  return {
    status: "observed",
    observed_at: file.observed_at,
    rows: [
      {
        account,
        card_last4: last4,
        currency: "clp", // convention-ok: consultasaldos states a peso and a dollar cupo
        limit: field("cupoautpesos"),
        used: field("cupoutilpesos"),
        available: field("cupodisppesos"),
      },
      {
        account,
        card_last4: last4,
        currency: "usd", // convention-ok: consultasaldos states a peso and a dollar cupo
        limit: field("cupoautdolar"),
        used: field("cupoutildolar"),
        available: field("cupodispdolar"),
      },
    ],
  };
}

/** The whole staged file → one `card.unbilled_movements` payload with one card. */
export function liderCardFeedPayload(file: LiderCardFeedFile): CardUnbilledMovementsPayload {
  if (Number.isNaN(Date.parse(file.observed_at))) {
    throw new Error(`Lider BCI feed observed_at ${JSON.stringify(file.observed_at)} is not a timestamp`);
  }
  const last4 = requireLast4(file.card_last4);
  const lines = listRows(file.national, "national").map((r) => liderMovementRowToLine(r, "clp")); // convention-ok: the national tab is pesos
  if (file.international) {
    lines.push(...listRows(file.international, "international").map((r) => liderMovementRowToLine(r, "usd"))); // convention-ok: the international tab is dollars
  }
  return {
    observed_at: file.observed_at,
    cards: [{ account: { issuer: LIDER_ISSUER, number: last4 }, close: null, lines }],
    issuer_balances: liderIssuerBalances(file),
  };
}
