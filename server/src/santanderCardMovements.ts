import {
  isCcCuotaBillingReferenceMerchant,
  parseWebPasteAmountToken,
  type CcWebPasteLine,
} from "./ccWebPasteParse.js";
import {
  STAMP_TAX_FEED_TYPE,
  cuotaCountFromStampTax,
  cuotaPurchaseTypeFromFeedDescription,
} from "./ccCuotaPurchaseKinds.js";

/**
 * Adapter from the Santander private-API movement feed to the web-paste line shape.
 *
 * The fetcher (`scraper/`) stores `MatrizMovimientos` rows verbatim; this turns them into the same
 * `CcWebPasteLine` a manual paste produces, so the whole existing import path — dedupe keys,
 * installment overlap handling, first-due nudges, batch logging — is reused rather than duplicated.
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
   * close. Kept apart from `rows` by the fetcher; absent on files fetched before 2026-09-26, when
   * the fetcher still discarded it.
   */
  saldoInicial?: unknown[];
};

export type SantanderMovementsFile = {
  fetchedAt: string;
  slides: SantanderMovementSlide[];
};

function requireString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`Santander movement row is missing ${field}`);
  return text;
}

/** `dd/mm/yyyy` → `YYYY-MM-DD`. Throws rather than guessing at an unexpected shape. */
export function santanderMovementDateToIso(fecha: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha.trim());
  if (!m) throw new Error(`Unexpected Santander movement date "${fecha}" (want dd/mm/yyyy)`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Build the amount token this row would have shown in the web UI, then parse it with the same
 * function the manual paste uses.
 *
 * Two conventions matter and they differ by currency: CLP amounts are dot-grouped integers
 * (`"2x.xxx"` = 2x.xxx pesos) while USD amounts use a decimal comma (`"18,52"` = 18.52). The sign is
 * not in `Importe` at all — it comes from `IndicadorDebeHaber` (`D` = cargo, shown as a negative in
 * the UI; `H` = abono, e.g. a NOTA DE CREDITO). Emitting the UI's convention is required, because
 * `webPasteAmountClpForDb` inverts the sign for Santander when storing it as debt.
 */
export function santanderMovementAmountToken(row: SantanderMovementRow, isUsd: boolean): string {
  const importe = requireString(row.Importe, "Importe");
  const indicator = requireString(row.IndicadorDebeHaber, "IndicadorDebeHaber").toUpperCase();
  if (indicator !== "D" && indicator !== "H") {
    throw new Error(`Unexpected IndicadorDebeHaber "${indicator}" (want D or H)`);
  }
  const sign = indicator === "D" ? "-" : "";
  return `${sign}${isUsd ? "US$" : ""}${importe}`;
}

/** Convert one API row into the web-paste line shape. */
export function santanderMovementRowToWebPasteLine(
  row: SantanderMovementRow,
  currency: "clp" | "usd"
): CcWebPasteLine {
  const isUsd = currency === "usd";
  const transaction_date = santanderMovementDateToIso(requireString(row.Fecha, "Fecha"));
  // `Comercio` is the merchant (it is what the site prints under "Detalle"); `Descripcion` is the
  // transaction type ("COMPRA NORMAL", "NOTA DE CREDITO"), kept only as human context.
  const merchant = requireString(row.Comercio ?? row.Descripcion, "Comercio");
  const token = santanderMovementAmountToken(row, isUsd);
  const amount = parseWebPasteAmountToken(token);
  if (!amount) throw new Error(`Could not parse Santander amount "${token}" for "${merchant}"`);
  if (amount.currency !== currency) {
    throw new Error(`Amount "${token}" parsed as ${amount.currency}, expected ${currency}`);
  }
  // The «CUOT: … OPER: …» billing references share cuota descriptions but are not purchases.
  const cuotaType = isCcCuotaBillingReferenceMerchant(merchant)
    ? null
    : cuotaPurchaseTypeFromFeedDescription(row.Descripcion);
  return {
    transaction_date,
    merchant,
    amount_clp: isUsd ? 0 : amount.amount,
    amount_usd: isUsd ? amount.amount : null,
    currency,
    raw_line: [row.Fecha, row.Descripcion ?? "", merchant, row.Importe].filter(Boolean).join(" "),
    ...(cuotaType
      ? {
          cuota_purchase: {
            kind: cuotaType.kind,
            cuota_count: cuotaType.cuota_count,
            count_source: cuotaType.cuota_count != null ? ("feed_type" as const) : null,
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
function pairStampTaxes(rows: { row: SantanderMovementRow; line: CcWebPasteLine }[]): void {
  const key = (line: CcWebPasteLine) => `${line.transaction_date}|${line.merchant.trim().toUpperCase()}`;
  const taxes = new Map<string, number[]>();
  const purchases = new Map<string, CcWebPasteLine[]>();
  for (const { row, line } of rows) {
    if (String(row.Descripcion ?? "").trim().toUpperCase() === STAMP_TAX_FEED_TYPE) {
      taxes.set(key(line), [...(taxes.get(key(line)) ?? []), Math.abs(line.amount_clp)]);
    } else if (line.cuota_purchase?.kind === "cuota_comercio") {
      purchases.set(key(line), [...(purchases.get(key(line)) ?? []), line]);
    }
  }
  for (const [k, lines] of purchases) {
    const tax = taxes.get(k);
    if (lines.length !== 1 || tax?.length !== 1) continue;
    const line = lines[0]!;
    const cp = line.cuota_purchase!;
    cp.stamp_tax_clp = tax[0]!;
    const count = cuotaCountFromStampTax(Math.abs(line.amount_clp), tax[0]!);
    if (count.status === "exact" && cp.cuota_count == null) {
      cp.cuota_count = count.cuota_count;
      cp.count_source = "stamp_tax";
    }
  }
}

export type SantanderAccountMovements = {
  /** Santander's own account number, e.g. "800000000901". */
  account: string;
  lines: CcWebPasteLine[];
};

/**
 * Group a fetched movements file into one batch of lines per card account.
 *
 * A card's CLP and USD slides are merged: `ccWebPasteToCsvRecords` already handles mixed-currency
 * batches, and importing them together keeps one import batch per card per run.
 */
export function santanderMovementsByAccount(file: SantanderMovementsFile): SantanderAccountMovements[] {
  const byAccount = new Map<string, { row: SantanderMovementRow; line: CcWebPasteLine }[]>();
  for (const slide of file.slides ?? []) {
    const account = String(slide.account ?? "").trim();
    if (!account) throw new Error("Santander movements slide has no account");
    const raw = String(slide.currency ?? "").trim().toLowerCase();
    if (raw !== "clp" && raw !== "usd") {
      throw new Error(`Unexpected Santander slide currency "${slide.currency}" (want CLP or USD)`);
    }
    const rows = byAccount.get(account) ?? [];
    for (const row of slide.rows ?? []) {
      const r = row as SantanderMovementRow;
      rows.push({ row: r, line: santanderMovementRowToWebPasteLine(r, raw) });
    }
    byAccount.set(account, rows);
  }
  return [...byAccount.entries()].map(([account, rows]) => {
    pairStampTaxes(rows);
    return { account, lines: rows.map((r) => r.line) };
  });
}

/** One card's latest close as its feed states it: date + billed total per currency. */
export type SantanderFeedClose = {
  account: string;
  close_iso: string;
  /** Debt-positive; null when that currency's slide carried no SALDO INICIAL. */
  saldo_inicial_clp: number | null;
  saldo_inicial_usd: number | null;
};

/**
 * Read each card's SALDO INICIAL rows — the feed's statement of its latest close. One row per
 * currency slide at most, and a card's CLP and USD rows must name the same close: anything else is
 * a shape this reader does not understand, and it throws rather than pick one.
 *
 * The amount keeps the feed's own sign rule: `D` (cargo) is money owed — positive here, the
 * debt-positive convention the statements use for «Monto total facturado» — and `H` a credit
 * balance, negative.
 */
export function santanderFeedClosesByAccount(file: SantanderMovementsFile): SantanderFeedClose[] {
  const byAccount = new Map<string, SantanderFeedClose>();
  for (const slide of file.slides ?? []) {
    const rows = slide.saldoInicial ?? [];
    if (rows.length === 0) continue;
    const account = String(slide.account ?? "").trim();
    if (!account) throw new Error("Santander movements slide has no account");
    const currency = String(slide.currency ?? "").trim().toLowerCase();
    if (currency !== "clp" && currency !== "usd") {
      throw new Error(`Unexpected Santander slide currency "${slide.currency}" (want CLP or USD)`);
    }
    if (rows.length > 1) {
      throw new Error(
        `Santander ${account} ${currency} slide carries ${rows.length} SALDO INICIAL rows — expected one`
      );
    }
    const row = rows[0] as SantanderMovementRow;
    const closeIso = santanderMovementDateToIso(requireString(row.Fecha, "Fecha"));
    const token = santanderMovementAmountToken(row, currency === "usd");
    // A zero balance is a real close (nothing billed in that currency); the shared amount parser
    // treats 0 as "no amount", so it is recognised here first.
    const isZero = /^[0.,\s]+$/.test(requireString(row.Importe, "Importe"));
    const parsed = isZero ? null : parseWebPasteAmountToken(token.replace(/^-/, ""));
    if (!isZero && (!parsed || parsed.currency !== currency)) {
      throw new Error(`Could not parse Santander SALDO INICIAL "${row.Importe}" (${currency})`);
    }
    const magnitude = isZero ? 0 : Math.abs(parsed!.amount);
    const indicator = String(row.IndicadorDebeHaber ?? "").trim().toUpperCase();
    const amount = indicator === "H" ? -magnitude : magnitude;
    const prev = byAccount.get(account) ?? {
      account,
      close_iso: closeIso,
      saldo_inicial_clp: null,
      saldo_inicial_usd: null,
    };
    if (prev.close_iso !== closeIso) {
      throw new Error(
        `Santander ${account}: SALDO INICIAL rows name two closes (${prev.close_iso} and ${closeIso})`
      );
    }
    if (currency === "clp") prev.saldo_inicial_clp = amount;
    else prev.saldo_inicial_usd = amount;
    byAccount.set(account, prev);
  }
  return [...byAccount.values()];
}
