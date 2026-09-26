/**
 * Santander statement JSON → the parser's CSV record shape.
 *
 * Field mapping was established by diffing this feed against the same statement already imported
 * from its PDF (2026-07-23, card ·0901), not by reading field names — several of them mislead.
 * Keep that diff (`npm run import:santander-statements`) as the regression check when changing this.
 *
 * The PDF remains the archive of record: this only changes which source writes the ledger.
 */

/** `AS_TIB_WM02_…` national (CLP) statement row. */
export type SantanderNationalRow = {
  Pan: string;
  NombreComercio: string;
  FechaTxs: string;
  MontoTxs: string;
  NumeroCuotas: string;
  TotalCuotas: string;
  MontoCuota: string;
  TipoCuota: string;
  TasaCompraCuotas: string;
  CodTxs: string;
  Ciudad: string | null;
  Microfilm: string | null;
  GlosaRubroCom: string | null;
};

/** `AS_TIB_WM03_…` international (USD) statement row. */
export type SantanderInternationalRow = {
  Pan: string;
  NombreComercio: string;
  FechaTxs: string;
  FechaProceso: string | null;
  MontoOrigen: string;
  MontoTransaccion: string;
  CodPais: string | null;
  CiudadComercio: string | null;
  NumeroReferencia: string | null;
  CodTxs: string;
};

/**
 * Transaction codes seen on the national statement.
 *
 * `PAYMENT` is the one row the PDF parser drops by design (its amount lives in the statement
 * header), which is exactly why the JSON carries one more line than the imported PDF.
 */
export const NATIONAL_COD_TXS = {
  PURCHASE: "000",
  PURCHASE_INTERNET: "005",
  INSTALLMENT_CUOTA: "205",
  PAYMENT: "067",
  INSURANCE: "002",
  STAMP_TAX: "203",
  /** NOTA DE CREDITO — a refund/reversal the bank nets NEGATIVE into DeudaTotalFact (its amount
   * rides in TotalCargos with a trailing '-'; verified on the 25/08/2026 close: 3.xxx.xxx compras
   * + 2x.xxx cargos aut − 2.140 nota = 3.xxx.xxx facturado exact). */
  CREDIT_NOTE: "510",
} as const;

/**
 * Read a zero-padded fixed-point amount.
 *
 * Two conventions coexist and confusing them is a silent factor-of-100 error: national amounts are
 * integer pesos (`"0000023270"` = 2x.xxx) while international amounts carry two implied decimals and
 * an optional TRAILING sign (`"00000001414+"` = 14.14, `"00000025813-"` = −258.13).
 */
export function parseSantanderFixed(raw: string, decimals: 0 | 2): number {
  const text = String(raw ?? "").trim();
  const m = /^(\d+)([+-]?)$/.exec(text);
  if (!m) throw new Error(`Unexpected Santander fixed-point amount "${raw}"`);
  const magnitude = Number(m[1]) / 10 ** decimals;
  if (!Number.isFinite(magnitude)) throw new Error(`Unparseable Santander amount "${raw}"`);
  return m[2] === "-" ? -magnitude : magnitude;
}

/** ISO `YYYY-MM-DD` → the `d/m/yyyy` the CSV records use. Null sentinel `0001-01-01` → null. */
export function santanderIsoToCsvDate(iso: string | null): string | null {
  const text = String(iso ?? "").trim();
  if (!text || text.startsWith("0001-01-01")) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error(`Unexpected Santander date "${iso}" (want YYYY-MM-DD)`);
  return `${Number(m[3])}/${Number(m[2])}/${m[1]}`;
}

/** Masked PAN (`"250905#420050781"`) → the origin card's last 4 digits. */
export function originCardLast4FromPan(pan: string | null): string | null {
  const digits = String(pan ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export type SantanderStatementLine = {
  transaction_date: string;
  posting_date: string | null;
  merchant: string;
  /** CLP for national rows; null on international rows, where USD is authoritative. */
  amount_clp: number | null;
  amount_usd: number | null;
  /** Original-currency amount on international rows. */
  amount_orig: number | null;
  orig_currency: "clp" | "usd" | null;
  country: string | null;
  place: string | null;
  origin_card_last4: string | null;
  authorization_code: string | null;
  installment_flag: boolean;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  valor_cuota_mensual_clp: number | null;
  cod_txs: string;
  raw_line: string;
};

/**
 * Convert one national (CLP) row.
 *
 * The installment trap: `MontoCuota` is the **total purchase** and `MontoTxs` is the **monthly
 * cuota** — the reverse of what the names suggest. Verified against the imported PDF, where
 * CK ECOMMERCE has `amount_clp` 1xx.xxx and `valor_cuota_mensual_clp` 3x.xxx for cuota 1 of 3,
 * matching JSON `MontoCuota` 0000100474 / `MontoTxs` 0000033491.
 */
export function nationalRowToLine(row: SantanderNationalRow): SantanderStatementLine {
  const cuotasTotal = Number(row.TotalCuotas ?? "00");
  const isInstallment = Number.isFinite(cuotasTotal) && cuotasTotal > 0;
  const cuotaAmount = parseSantanderFixed(row.MontoTxs, 0);
  const totalAmount = isInstallment ? parseSantanderFixed(row.MontoCuota, 0) : null;
  const transaction_date = santanderIsoToCsvDate(row.FechaTxs);
  if (!transaction_date) throw new Error(`National statement row has no FechaTxs (${row.NombreComercio})`);

  return {
    transaction_date,
    posting_date: null, // the national feed carries only one date
    merchant: String(row.NombreComercio ?? "").trim(),
    amount_clp: isInstallment ? totalAmount : cuotaAmount,
    amount_usd: null,
    amount_orig: null,
    orig_currency: null,
    country: null,
    place: String(row.Ciudad ?? "").trim() || null,
    origin_card_last4: originCardLast4FromPan(row.Pan),
    authorization_code: String(row.Microfilm ?? "").trim() || null,
    installment_flag: isInstallment,
    nro_cuota_current: isInstallment ? Number(row.NumeroCuotas) : null,
    nro_cuota_total: isInstallment ? cuotasTotal : null,
    valor_cuota_mensual_clp: isInstallment ? cuotaAmount : null,
    cod_txs: String(row.CodTxs ?? "").trim(),
    raw_line: [row.FechaTxs, row.NombreComercio, row.MontoTxs].filter(Boolean).join(" "),
  };
}

/**
 * Convert one international (USD) row.
 *
 * `MontoTransaccion` is the billed USD and carries the direction in its trailing sign (an
 * ABONO DE DIVISAS is negative). `MontoOrigen` is the amount actually charged by the merchant: when
 * the two are equal the charge was natively USD, and when they differ the origin is the foreign
 * currency — Apple Chile billing 1x.xxx CLP settled at 14.14 USD. The PDF parser labels every
 * origin as CLP and truncates the decimals, so this is the more accurate of the two sources.
 */
export function internationalRowToLine(row: SantanderInternationalRow): SantanderStatementLine {
  const usd = parseSantanderFixed(row.MontoTransaccion, 2);
  const origin = parseSantanderFixed(row.MontoOrigen, 2);
  const transaction_date = santanderIsoToCsvDate(row.FechaTxs);
  if (!transaction_date) throw new Error(`International row has no FechaTxs (${row.NombreComercio})`);
  const nativelyUsd = Math.abs(Math.abs(origin) - Math.abs(usd)) < 0.005;

  return {
    transaction_date,
    posting_date: santanderIsoToCsvDate(row.FechaProceso),
    merchant: String(row.NombreComercio ?? "").trim(),
    amount_clp: null,
    amount_usd: usd,
    amount_orig: origin,
    orig_currency: nativelyUsd ? "usd" : "clp",
    country: String(row.CodPais ?? "").trim() || null,
    place: String(row.CiudadComercio ?? "").trim() || null,
    origin_card_last4: originCardLast4FromPan(row.Pan),
    authorization_code: String(row.NumeroReferencia ?? "").trim() || null,
    installment_flag: false,
    nro_cuota_current: null,
    nro_cuota_total: null,
    valor_cuota_mensual_clp: null,
    cod_txs: String(row.CodTxs ?? "").trim(),
    raw_line: [row.FechaTxs, row.NombreComercio, row.MontoTransaccion].filter(Boolean).join(" "),
  };
}

export type SantanderStatementHeader = {
  account: string;
  /** Titular plastic per the header PAN (the statement-level `card_last4`). */
  card_last4: string | null;
  statement_date: string | null;
  period_from: string | null;
  pay_by: string | null;
  /** Next close (FechaProxFact) — the statement PDF's printed next-period end. */
  next_close: string | null;
  saldo_anterior: number | null;
  total_pagos: number | null;
  deuda_total: number | null;
  pago_minimo: number | null;
  cupo_total: number | null;
  cupo_disponible: number | null;
};

/** Header figures from the national `RESPUESTA` block (all integer pesos). */
export function nationalHeader(respuesta: Record<string, unknown>): SantanderStatementHeader {
  const num = (key: string): number | null => {
    const raw = respuesta[key];
    if (raw == null || String(raw).trim() === "") return null;
    return parseSantanderFixed(String(raw), 0);
  };
  return {
    account: String(respuesta.Cuenta ?? "").trim(),
    card_last4: originCardLast4FromPan(String(respuesta.Pan ?? "")),
    statement_date: santanderIsoToCsvDate(String(respuesta.FechaFactActual ?? "")),
    period_from: santanderIsoToCsvDate(String(respuesta.FechaFactAnt ?? "")),
    pay_by: santanderIsoToCsvDate(String(respuesta.FechaVenc ?? "")),
    next_close: santanderIsoToCsvDate(String(respuesta.FechaProxFact ?? "")),
    saldo_anterior: num("SaldoAnterior"),
    total_pagos: num("TotalPagos"),
    deuda_total: num("DeudaTotalFact"),
    pago_minimo: num("PagoMinimo"),
    cupo_total: num("CupoPesos"),
    cupo_disponible: num("CupoDisponible"),
  };
}
