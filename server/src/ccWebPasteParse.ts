import crypto from "node:crypto";
import {
  statementCloseDdMmYyyyForBillingMonth,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";
import { ccOneShotDedupeKey, normCcMerchant } from "./ccDedupeKey.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { webPasteAmountClpForDb, webPasteAmountUsdForDb } from "./ccPaymentLines.js";
import { db } from "./db.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

export type CcWebPasteLine = {
  transaction_date: string;
  merchant: string;
  /** Raw pasted CLP amount (signed); 0 when the line was pasted in USD. */
  amount_clp: number;
  /** Raw pasted USD amount (signed) when the line carried a USD token; null otherwise. */
  amount_usd: number | null;
  currency: "clp" | "usd";
  raw_line: string;
};

export type CcWebPasteParseResult = {
  lines: CcWebPasteLine[];
  errors: string[];
};

/** USD indicators the bank web-UI uses in the amount column (`USD`, `US$`, `U$`, `U$S`). */
const USD_TOKEN_RE = /US\$|USD|U\$S?/i;
const AMOUNT_RE = /([+-]?)\$?([\d.,]+)/;

export type WebPasteAmount = { amount: number; currency: "clp" | "usd" };

/**
 * Parse a pasted amount token → signed magnitude + currency.
 * A `USD` / `US$` token marks a dollar charge parsed with Chilean decimals (`99,28` → `99.28`);
 * otherwise the value is CLP with `.` as thousands separator (`1.990` → `1990`).
 */
export function parseWebPasteAmountToken(raw: string): WebPasteAmount | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const isUsd = USD_TOKEN_RE.test(t);
  const cleaned = t.replace(/\s+/g, "").replace(USD_TOKEN_RE, "");
  const m = AMOUNT_RE.exec(cleaned);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  if (isUsd) {
    const num = Number(m[2]!.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(num) || num === 0) return null;
    return { amount: sign * num, currency: "usd" };
  }
  const n = Number(m[2]!.replace(/[.,]/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return { amount: sign * Math.round(n), currency: "clp" };
}

function parseDateToken(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return parseDdMmYyToIso(t);
}

/**
 * Parse Santander “últimos movimientos” paste from the bank website.
 * Date may appear once per day; following lines inherit that date.
 */
export function parseCcWebPasteText(text: string): CcWebPasteParseResult {
  const lines: CcWebPasteLine[] = [];
  const errors: string[] = [];
  let currentDate: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(/\t+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;

    let idx = 0;
    const maybeDate = parseDateToken(parts[0]!);
    if (maybeDate) {
      currentDate = maybeDate;
      idx = 1;
    }

    if (!currentDate) {
      errors.push(`Sin fecha para línea: ${line.slice(0, 80)}`);
      continue;
    }

    let merchant = "";
    let amountRaw = "";
    if (parts.length - idx >= 2) {
      merchant = parts[idx]!;
      amountRaw = parts[idx + 1]!;
    } else if (parts.length - idx === 1) {
      const only = parts[idx]!;
      const amtAtEnd = /\s+([+-]?\s*(?:US\$|USD|U\$S?)?\s*\$?[\d.,]+)\s*$/i.exec(only);
      if (amtAtEnd) {
        merchant = only.slice(0, amtAtEnd.index).trim();
        amountRaw = amtAtEnd[1]!;
      } else {
        merchant = only;
      }
    }

    if (!merchant) {
      errors.push(`Sin comercio: ${line.slice(0, 80)}`);
      continue;
    }

    const parsedAmount = parseWebPasteAmountToken(amountRaw);
    if (parsedAmount == null) {
      errors.push(`Monto inválido (${amountRaw || "vacío"}): ${merchant}`);
      continue;
    }

    lines.push({
      transaction_date: currentDate,
      merchant: normCcMerchant(merchant),
      amount_clp: parsedAmount.currency === "clp" ? parsedAmount.amount : 0,
      amount_usd: parsedAmount.currency === "usd" ? parsedAmount.amount : null,
      currency: parsedAmount.currency,
      raw_line: line,
    });
  }

  return { lines, errors };
}

export function ccWebPasteToCsvRecords(
  accountId: number,
  cardGroup: string,
  cardLast4: string,
  batchId: string,
  parsed: CcWebPasteLine[]
): CcStatementCsvRecord[] {
  const billingMonth = targetBillingMonthForManualImports(accountId, cardLast4);
  const statementDate = statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth);
  /** One open-period bucket per billing month (append on re-import via dedupe_key). */
  const sourcePdf = `import:web-paste|open|${billingMonth}`;

  const seen = new Set<string>();
  const records: CcStatementCsvRecord[] = [];

  for (const line of parsed) {
    const isUsd = line.currency === "usd";
    // Dedupe on the pasted magnitude in its own currency (USD in cents keeps re-imports idempotent).
    const dedupeAmount = isUsd
      ? Math.round(Math.abs(line.amount_usd ?? 0) * 100)
      : Math.abs(line.amount_clp);
    const dedupe_key = ccOneShotDedupeKey(
      cardGroup,
      line.merchant,
      dedupeAmount,
      line.transaction_date
    );
    if (seen.has(dedupe_key)) continue;
    seen.add(dedupe_key);

    const ddMm = (() => {
      const [y, mo, d] = line.transaction_date.split("-");
      return `${Number(d)}/${Number(mo)}/${y}`;
    })();

    // USD charges land on the CLP open bucket as foreign lines: MONTO US$ is authoritative and the
    // CLP value is derived at read time via FX (effectiveCcExpenseLineAmountClp), so amount_clp stays empty.
    const usdSigned = isUsd
      ? webPasteAmountUsdForDb(line.amount_usd ?? 0, line.merchant, cardGroup)
      : 0;

    records.push({
      card_group: cardGroup,
      source_pdf: sourcePdf,
      statement_date: statementDate,
      card_last4: cardLast4,
      transaction_date: ddMm,
      merchant: line.merchant,
      amount_clp: isUsd ? "" : String(webPasteAmountClpForDb(line.amount_clp, line.merchant, cardGroup)),
      amount_usd: isUsd ? String(usdSigned) : "",
      orig_currency: isUsd ? "usd" : "",
      installment_flag: "false",
      dedupe_key,
      raw_line: line.raw_line,
      row_id: `web:${dedupe_key}`,
      currency: "clp",
      parser_layout: "compact",
      statement_saldo_anterior: "",
      statement_abono: "",
      statement_compras_cargos: "",
      statement_deuda_total: "",
      statement_monto_facturado: "",
    });
  }

  return records;
}

export function newWebPasteBatchId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const WEB_PASTE_CARD_GROUP_BY_ISSUER: Record<string, string> = {
  santander: "santander",
  bci: "BCI",
};

function webPasteCardGroupForIssuer(issuer: string): string {
  return WEB_PASTE_CARD_GROUP_BY_ISSUER[issuer] ?? issuer;
}

export function creditCardMasterMetaForAccount(accountId: number): {
  cardGroup: string;
  cardLast4: string;
} | null {
  const row = db
    .prepare(`SELECT notes FROM accounts WHERE id = ?`)
    .get(accountId) as { notes: string | null } | undefined;
  const notes = String(row?.notes ?? "");
  const m = /^credit_card_master\|([^|]+)\|(\d{4})$/.exec(notes);
  if (!m) return null;
  return {
    cardGroup: webPasteCardGroupForIssuer(m[1]!),
    cardLast4: m[2]!,
  };
}
