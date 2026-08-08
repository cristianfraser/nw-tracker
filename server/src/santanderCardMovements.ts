import { parseWebPasteAmountToken, type CcWebPasteLine } from "./ccWebPasteParse.js";

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
  return {
    transaction_date,
    merchant,
    amount_clp: isUsd ? 0 : amount.amount,
    amount_usd: isUsd ? amount.amount : null,
    currency,
    raw_line: [row.Fecha, row.Descripcion ?? "", merchant, row.Importe].filter(Boolean).join(" "),
  };
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
  const byAccount = new Map<string, CcWebPasteLine[]>();
  for (const slide of file.slides ?? []) {
    const account = String(slide.account ?? "").trim();
    if (!account) throw new Error("Santander movements slide has no account");
    const raw = String(slide.currency ?? "").trim().toLowerCase();
    if (raw !== "clp" && raw !== "usd") {
      throw new Error(`Unexpected Santander slide currency "${slide.currency}" (want CLP or USD)`);
    }
    const lines = byAccount.get(account) ?? [];
    for (const row of slide.rows ?? []) {
      lines.push(santanderMovementRowToWebPasteLine(row as SantanderMovementRow, raw));
    }
    byAccount.set(account, lines);
  }
  return [...byAccount.entries()].map(([account, lines]) => ({ account, lines }));
}
