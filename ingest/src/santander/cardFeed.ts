import type { BankAccountBalancesPayload } from "nw-tracker-contracts";
import type {
  CardListingLine,
  CardUnbilledMovementsPayload,
} from "nw-tracker-contracts";
import {
  STAMP_TAX_FEED_TYPE,
  cuotaCountFromStampTax,
  cuotaPurchaseTypeFromFeedDescription,
} from "./cuotaPurchases.js";

/**
 * The Santander card feed (what `fetch:santander` stages as `card-movements-*.json`) →
 * a `card.unbilled_movements` payload. All Santander decoding lives here: `dd/mm/yyyy` dates,
 * the two `Importe` conventions, the D/H sign, the SALDO INICIAL close, cuota-purchase types
 * and the stamp-tax count, and the 18-digit cupo amounts. The server gets canonical fields.
 */

/** One `MatrizMovimientos` row, exactly as the API returns it. */
export type SantanderMovementRow = {
  Fecha: string;
  Descripcion: string | null;
  Comercio: string | null;
  Importe: string;
  DescripcionRubro: string | null;
  Ciudad: string | null;
  TipoBen: string | null;
  IndicadorDebeHaber: string;
};

export type SantanderMovementSlide = {
  currency: string | null;
  account: string | null;
  rows: unknown[];
  /**
   * The slide's «SALDO INICIAL» row(s), verbatim — the latest close's billed total, dated at that
   * close. Absent on files fetched before 2026-09-26, when the fetcher still discarded it.
   */
  saldoInicial?: unknown[];
};

export type SantanderMovementsFile = {
  fetchedAt: string;
  slides: SantanderMovementSlide[];
  /**
   * The session's product-summary rows (`cruceProductosOnline`): absent on files fetched before
   * 2026-09-27, null when the fetcher got no usable summary (`cuposError` says why).
   */
  cupos?: { observedAt: string; rows: unknown[] } | null;
  cuposError?: string;
  /**
   * The same summary's deposit-account rows: absent on files fetched before 2026-10-05, null when
   * the summary listed none (`accountsError` says why).
   */
  accounts?: { observedAt: string; rows: unknown[] } | null;
  accountsError?: string;
};

const ISSUER = "santander";

function requireString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`Santander movement row is missing ${field}`);
  return text;
}

/** `dd/mm/yyyy` → `YYYY-MM-DD`. Throws on any other shape and on a day the calendar lacks. */
export function santanderMovementDateToIso(fecha: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha.trim());
  const [d, mo, y] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (!m || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`Unexpected Santander movement date "${fecha}" (want dd/mm/yyyy)`);
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function santanderSlideCurrency(raw: unknown): "clp" | "usd" {
  const c = String(raw ?? "").trim().toLowerCase();
  if (c !== "clp" && c !== "usd") {
    throw new Error(`Unexpected Santander slide currency "${String(raw)}" (want CLP or USD)`);
  }
  return c;
}

/**
 * Magnitude of an `Importe`. The two currencies differ: CLP amounts are dot-grouped integers
 * (`"29.408"` = 29408 pesos) while USD amounts use a decimal comma (`"18,52"` = 18.52). The sign
 * is never in `Importe` — it is `IndicadorDebeHaber`. Null for a zero amount.
 */
export function santanderImporteMagnitude(importe: string, currency: "clp" | "usd"): number | null {
  const m = /([\d.,]+)/.exec(importe.replace(/\s+/g, "").replace(/^[+-]?\$?/, ""));
  if (!m) throw new Error(`Could not parse Santander amount "${importe}"`);
  const digits = m[1]!;
  const n =
    currency === "usd"
      ? Number(digits.replace(/\./g, "").replace(",", "."))
      : Math.round(Number(digits.replace(/[.,]/g, "")));
  if (!Number.isFinite(n)) throw new Error(`Could not parse Santander amount "${importe}"`);
  return n === 0 ? null : n;
}

/** `D` (cargo) is money owed — positive; `H` (abono: a payment, a nota de crédito) negative. */
function debtSign(row: SantanderMovementRow): 1 | -1 {
  const indicator = requireString(row.IndicadorDebeHaber, "IndicadorDebeHaber").toUpperCase();
  if (indicator !== "D" && indicator !== "H") {
    throw new Error(`Unexpected IndicadorDebeHaber "${indicator}" (want D or H)`);
  }
  return indicator === "D" ? 1 : -1;
}

/** `TipoBen`: whose plastic made the movement. Null on a pending authorization; anything else throws. */
function santanderHolder(tipoBen: string | null): CardListingLine["holder"] {
  if (tipoBen == null) return undefined;
  const t = tipoBen.trim().toLowerCase();
  if (t === "titular") return "titular";
  if (t === "adicional") return "additional";
  throw new Error(`Unexpected Santander TipoBen "${tipoBen}" (want Titular or Adicional)`);
}

/** The «CUOT: <cuota №> OPER: <plan №>» rows the feed lists at a close: cuota billings, not purchases. */
function isCuotaBillingReference(merchant: string): boolean {
  return /^CUOT:\s*\d+\s*(?:OPER:\s*\d+)?$/i.test(merchant.trim());
}

/** One API row as a canonical listing line. */
export function santanderMovementRowToLine(
  row: SantanderMovementRow,
  currency: "clp" | "usd"
): CardListingLine {
  const date = santanderMovementDateToIso(requireString(row.Fecha, "Fecha"));
  // `Comercio` is the merchant (what the site prints under "Detalle"); `Descripcion` is the
  // transaction type ("COMPRA NORMAL", "NOTA DE CREDITO"), kept only in the raw text.
  const merchant = requireString(row.Comercio ?? row.Descripcion, "Comercio");
  const importe = requireString(row.Importe, "Importe");
  const sign = debtSign(row);
  const magnitude = santanderImporteMagnitude(importe, currency);
  if (magnitude == null) throw new Error(`Santander movement "${merchant}" has a zero amount`);
  const holder = santanderHolder(row.TipoBen);
  const cuotaType = isCuotaBillingReference(merchant)
    ? null
    : cuotaPurchaseTypeFromFeedDescription(row.Descripcion);
  return {
    date,
    merchant,
    currency,
    amount: sign * magnitude,
    raw_text: [row.Fecha, row.Descripcion ?? "", merchant, row.Importe].filter(Boolean).join(" "),
    ...(holder ? { holder } : {}),
    ...(cuotaType
      ? {
          cuota_purchase: {
            first_cuota_bills: cuotaType.first_cuota_bills,
            cuota_count: cuotaType.cuota_count,
            count_source: cuotaType.cuota_count != null ? ("printed" as const) : null,
            stamp_tax_clp: null,
          },
        }
      : {}),
  };
}

/**
 * Give each «cuota comercio» purchase its count from the stamp-tax row the feed lists the same
 * day under the same merchant. Only an unambiguous pair counts: one purchase and one tax row for
 * that (date, merchant). A tax that gives no clean count (capped, or a tiny principal whose peso
 * rounding hides the term) leaves the count unknown — never a guess.
 */
function pairStampTaxes(rows: { row: SantanderMovementRow; line: CardListingLine }[]): void {
  const key = (line: CardListingLine) => `${line.date}|${line.merchant.trim().toUpperCase()}`;
  const taxes = new Map<string, number[]>();
  const purchases = new Map<string, CardListingLine[]>();
  for (const { row, line } of rows) {
    if (String(row.Descripcion ?? "").trim().toUpperCase() === STAMP_TAX_FEED_TYPE) {
      taxes.set(key(line), [...(taxes.get(key(line)) ?? []), Math.abs(line.amount)]);
    } else if (line.cuota_purchase?.first_cuota_bills === "next_cycle") {
      purchases.set(key(line), [...(purchases.get(key(line)) ?? []), line]);
    }
  }
  for (const [k, lines] of purchases) {
    const tax = taxes.get(k);
    if (lines.length !== 1 || tax?.length !== 1) continue;
    const cp = lines[0]!.cuota_purchase!;
    cp.stamp_tax_clp = tax[0]!;
    const count = cuotaCountFromStampTax(Math.abs(lines[0]!.amount), tax[0]!);
    if (count.status === "exact" && cp.cuota_count == null) {
      cp.cuota_count = count.cuota_count;
      cp.count_source = "stamp_tax";
    }
  }
}

type CardClose = NonNullable<CardUnbilledMovementsPayload["cards"][number]["close"]>;

/**
 * A slide's SALDO INICIAL row → the close it states. One row per currency slide at most, and a
 * card's CLP and USD rows must name the same close: anything else is a shape this reader does
 * not understand, and it throws rather than pick one.
 */
function applySaldoInicial(
  prev: CardClose | null,
  account: string,
  currency: "clp" | "usd",
  rows: readonly unknown[]
): CardClose | null {
  if (rows.length === 0) return prev;
  if (rows.length > 1) {
    throw new Error(`Santander ${account} ${currency} slide carries ${rows.length} SALDO INICIAL rows — expected one`);
  }
  const row = rows[0] as SantanderMovementRow;
  const date = santanderMovementDateToIso(requireString(row.Fecha, "Fecha"));
  // A zero balance is a real close: nothing billed in that currency.
  const magnitude = santanderImporteMagnitude(requireString(row.Importe, "Importe"), currency) ?? 0;
  const indicator = String(row.IndicadorDebeHaber ?? "").trim().toUpperCase();
  const amount = indicator === "H" ? -magnitude : magnitude;
  const close: CardClose = prev ?? { date, billed: { clp: null, usd: null } };
  if (close.date !== date) {
    throw new Error(`Santander ${account}: SALDO INICIAL rows name two closes (${close.date} and ${date})`);
  }
  close.billed[currency] = amount;
  return close;
}

function bankCupoCents(raw: unknown, field: string, where: string): number {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{18}$/.test(text)) {
    throw new Error(`Santander cupo ${where}: ${field} "${String(raw)}" is not an 18-digit amount`);
  }
  const cents = Number(text);
  if (!Number.isSafeInteger(cents)) throw new Error(`Santander cupo ${where}: ${field} "${text}" is out of range`);
  return cents;
}

/**
 * The session's product summary (`cruceProductosOnline` `TCR` rows): `NUMEROCONTRATO` (the bank
 * account the feed slides name), `NUMEROPAN`, `CODIGOMONEDA`, and `CUPO` / `MONTOUTILIZADO` /
 * `MONTODISPONIBLE` as 18-digit strings with two implied decimals in BOTH currencies. Throws on
 * any shape it does not understand and on a row that breaks cupo = utilizado + disponible.
 */
export function santanderIssuerBalances(
  file: SantanderMovementsFile
): CardUnbilledMovementsPayload["issuer_balances"] {
  if (!("cupos" in file) || file.cupos === undefined) return undefined;
  if (file.cupos === null) {
    const reason = String(file.cuposError ?? "").trim();
    if (!reason) throw new Error("Santander movements file has cupos: null and no cuposError");
    return { status: "unavailable", reason };
  }
  const observedAt = String(file.cupos.observedAt ?? "").trim();
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error(`Santander cupo capture has an unparseable observedAt "${observedAt}"`);
  }
  const rows = (file.cupos.rows ?? []).map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const number = String(r.NUMEROCONTRATO ?? "").trim();
    const pan = String(r.NUMEROPAN ?? "").trim();
    const currency = String(r.CODIGOMONEDA ?? "").trim().toLowerCase();
    if (!/^\d+$/.test(number)) throw new Error(`Santander cupo row has no bank account ("${number}")`);
    if (!/^\d{4,}$/.test(pan)) throw new Error(`Santander cupo ${number}: NUMEROPAN "${pan}" is not a card number`);
    if (currency !== "clp" && currency !== "usd") {
      throw new Error(`Santander cupo ${number}: unexpected currency "${String(r.CODIGOMONEDA)}"`);
    }
    const where = `${number} ${currency}`;
    const total = bankCupoCents(r.CUPO, "CUPO", where);
    const used = bankCupoCents(r.MONTOUTILIZADO, "MONTOUTILIZADO", where);
    const available = bankCupoCents(r.MONTODISPONIBLE, "MONTODISPONIBLE", where);
    if (total !== used + available) {
      throw new Error(
        `Santander cupo ${where}: CUPO ${total / 100} is not utilizado ${used / 100} + disponible ${available / 100}`
      );
    }
    return {
      account: { issuer: ISSUER, number },
      card_last4: pan.slice(-4),
      currency: currency as "clp" | "usd",
      limit: total / 100,
      used: used / 100,
      available: available / 100,
    };
  });
  // Verbatim: the server keeps it as the capture's identity and compares it on a re-import.
  return { status: "observed", observed_at: observedAt, rows };
}

/**
 * The whole file as one payload: one card per bank account, in the order the slides first name
 * it, its CLP and USD rows together in slide order.
 */
export function santanderCardFeedPayload(file: SantanderMovementsFile): CardUnbilledMovementsPayload {
  const cards = new Map<
    string,
    { rows: { row: SantanderMovementRow; line: CardListingLine }[]; close: CardClose | null }
  >();
  for (const slide of file.slides ?? []) {
    const account = String(slide.account ?? "").trim();
    if (!account) throw new Error("Santander movements slide has no account");
    const currency = santanderSlideCurrency(slide.currency);
    const card = cards.get(account) ?? { rows: [], close: null };
    for (const raw of slide.rows ?? []) {
      const row = raw as SantanderMovementRow;
      card.rows.push({ row, line: santanderMovementRowToLine(row, currency) });
    }
    card.close = applySaldoInicial(card.close, account, currency, slide.saldoInicial ?? []);
    cards.set(account, card);
  }
  const fetchedAt = String(file.fetchedAt ?? "").trim();
  if (Number.isNaN(Date.parse(fetchedAt))) throw new Error(`Santander movements file has no valid fetchedAt`);
  const issuerBalances = santanderIssuerBalances(file);
  return {
    observed_at: fetchedAt,
    cards: [...cards.entries()].map(([number, card]) => {
      pairStampTaxes(card.rows);
      return {
        account: { issuer: ISSUER, number },
        close: card.close,
        lines: card.rows.map((r) => r.line),
      };
    }),
    ...(issuerBalances ? { issuer_balances: issuerBalances } : {}),
  };
}

const DEPOSIT_PRODUCTS: Readonly<Record<string, "checking" | "demand_deposit">> = {
  CCC: "checking",
  CCM: "demand_deposit",
};

/**
 * The deposit accounts of the session's product summary as a `bank_account.balances` payload:
 * `MONTODISPONIBLE` is the balance (18 digits, two implied decimals — the peso cuenta corriente's
 * matched its ledger to the peso on 2026-08-05). Null when the file predates the field or the
 * summary had none (`reason` says which); throws on any row it does not understand.
 */
export function santanderAccountBalances(
  file: SantanderMovementsFile
): { payload: BankAccountBalancesPayload | null; reason: string | null } {
  if (!("accounts" in file) || file.accounts === undefined) {
    return { payload: null, reason: "file predates deposit-account balances" };
  }
  if (file.accounts === null) {
    const reason = String(file.accountsError ?? "").trim();
    if (!reason) throw new Error("Santander movements file has accounts: null and no accountsError");
    return { payload: null, reason };
  }
  const observedAt = String(file.accounts.observedAt ?? "").trim();
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error(`Santander balances capture has an unparseable observedAt "${observedAt}"`);
  }
  const accounts = (file.accounts.rows ?? []).map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const number = String(r.NUMEROCONTRATO ?? "").trim();
    const group = String(r.AGRUPACIONCOMERCIAL ?? "").trim();
    const currency = String(r.CODIGOMONEDA ?? "").trim().toLowerCase();
    if (!/^\d+$/.test(number)) throw new Error(`Santander balance row has no account number ("${number}")`);
    const product = DEPOSIT_PRODUCTS[group];
    if (!product) throw new Error(`Santander balance ${number}: unexpected product group "${group}"`);
    if (currency !== "clp" && currency !== "usd") {
      throw new Error(`Santander balance ${number}: unexpected currency "${String(r.CODIGOMONEDA)}"`);
    }
    const cents = bankCupoCents(r.MONTODISPONIBLE, "MONTODISPONIBLE", `${number} ${currency}`);
    return {
      number,
      product,
      currency: currency as "clp" | "usd",
      balance: cents / 100,
      label: String(r.GLOSACORTA ?? "").trim() || group,
      status: String(r.GLOSAESTADO ?? "").trim() || "?",
    };
  });
  return { payload: { issuer: ISSUER, observed_at: observedAt, accounts }, reason: null };
}
