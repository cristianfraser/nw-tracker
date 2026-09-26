import crypto from "node:crypto";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import {
  statementCloseDdMmYyyyForBillingMonth,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";
import { ccOneShotDedupeKey, normCcMerchant } from "./ccDedupeKey.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { webPasteAmountClpForDb, webPasteAmountUsdForDb } from "./ccPaymentLines.js";
import { db } from "./db.js";
import {
  ccImportFlowItemFromRow,
  ccStatementLabel,
  type CcImportFlowItem,
  type CcStatementCsvRecord,
} from "./ccStatementsImport.js";

export type CcWebPasteLine = {
  transaction_date: string;
  merchant: string;
  /** Raw pasted CLP amount (signed); 0 when the line was pasted in USD. */
  amount_clp: number;
  /** Raw pasted USD amount (signed) when the line carried a USD token; null otherwise. */
  amount_usd: number | null;
  currency: "clp" | "usd";
  raw_line: string;
  /**
   * Santander card feed only: this row is a purchase in cuotas (the feed types it), listed at its
   * full principal. `cuota_count` when known — printed in the type, or read from the same-day
   * stamp-tax row (`ccCuotaPurchaseKinds.ts`). Absent on pasted lines.
   */
  cuota_purchase?: CcFeedCuotaPurchase | null;
};

export type CcFeedCuotaPurchase = {
  kind: CcCuotaPurchaseKind;
  cuota_count: number | null;
  count_source: "stamp_tax" | "feed_type" | null;
  /** The paired stamp tax, when one was found (even if it did not give a count). */
  stamp_tax_clp: number | null;
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

/**
 * The bank's per-cuota billing re-listing, not a purchase. At a facturación close Santander's
 * movement feed (and the web table) lists each cuota billing that cycle as a row whose merchant is
 * the reference `CUOT: <cuota №>OPER: <plan №>` — e.g. `CUOT: 000000009OPER: 000032` — valued at
 * the monthly cuota. The installment schedule already bills those months, so importing the row
 * double-counts the cuota (billing moves debt between facturado/por-facturar; it never changes
 * owed). A manual web paste truncates merchants at 15 chars, which cuts the OPER half — hence the
 * optional group. No real merchant is named like this, so the match is safe to apply unconditionally.
 */
export function isCcCuotaBillingReferenceMerchant(merchant: string | null | undefined): boolean {
  return /^CUOT:\s*\d+\s*(?:OPER:\s*\d+)?$/i.test(String(merchant ?? "").trim());
}

/**
 * The «SALDO INICIAL» row the unbilled-movements table opens with: the last closed facturación's
 * «Monto total facturado», dated at that close. It is the close's evidence, not a purchase —
 * importing it as a line would add the whole previous bill a second time. The feed importer
 * reads it as the observed close (`ccBillingCloses.ts`); a pasted one is reported and skipped.
 */
export function isCcSaldoInicialMerchant(merchant: string | null | undefined): boolean {
  return /^\s*SALDO\s+INICIAL\s*$/i.test(String(merchant ?? ""));
}

/**
 * One-shot dedupe key of a pasted / fed line — the identity every re-listing of the same purchase
 * shares, on the pasted magnitude in its own currency (USD in cents keeps re-imports idempotent).
 */
export function webPasteLineDedupeKey(cardGroup: string, line: CcWebPasteLine): string {
  const dedupeAmount =
    line.currency === "usd"
      ? Math.round(Math.abs(line.amount_usd ?? 0) * 100)
      : Math.abs(line.amount_clp);
  return ccOneShotDedupeKey(cardGroup, line.merchant, dedupeAmount, line.transaction_date);
}

export type CcWebPasteRecordsOpts = {
  /**
   * Put every line in this facturación's bucket instead of the open month. The card feed passes
   * the month after its own SALDO INICIAL close: everything it lists after a close is unbilled by
   * definition, whatever the row's date says (a pending authorization that settled after the
   * close keeps its earlier date).
   */
  targetBillingMonth?: string;
};

export function ccWebPasteToCsvRecords(
  accountId: number,
  cardGroup: string,
  cardLast4: string,
  batchId: string,
  parsed: CcWebPasteLine[],
  opts?: CcWebPasteRecordsOpts
): {
  records: CcStatementCsvRecord[];
  skipped_in_paste: CcImportFlowItem[];
  skipped_cuota_billing: CcImportFlowItem[];
  skipped_saldo_inicial: CcImportFlowItem[];
} {
  const openBillingMonth = targetBillingMonthForManualImports(accountId, cardLast4);
  /** One open-period bucket per billing month (append on re-import via dedupe_key). */
  const bucketFor = new Map<string, { sourcePdf: string; statementDate: string }>();
  const bucket = (billingMonth: string) => {
    let b = bucketFor.get(billingMonth);
    if (!b) {
      b = {
        sourcePdf: `import:web-paste|open|${billingMonth}`,
        statementDate: statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth),
      };
      bucketFor.set(billingMonth, b);
    }
    return b;
  };

  const seen = new Set<string>();
  const records: CcStatementCsvRecord[] = [];
  const skipped_in_paste: CcImportFlowItem[] = [];
  const skipped_cuota_billing: CcImportFlowItem[] = [];
  const skipped_saldo_inicial: CcImportFlowItem[] = [];

  for (const line of parsed) {
    const billingMonth = opts?.targetBillingMonth ?? openBillingMonth;
    const { sourcePdf, statementDate } = bucket(billingMonth);
    const isUsd = line.currency === "usd";
    const dedupe_key = webPasteLineDedupeKey(cardGroup, line);
    const isRepeatInPaste = seen.has(dedupe_key);
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

    const record: CcStatementCsvRecord = {
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
    };
    // The previous facturación's total, not a purchase (the feed reads it as the observed close).
    if (isCcSaldoInicialMerchant(line.merchant)) {
      skipped_saldo_inicial.push(
        ccImportFlowItemFromRow(record, ccStatementLabel(statementDate, "clp"))
      );
      continue;
    }
    // Cuota-billing reference rows never import — the installment schedule already bills them.
    // Reported, not silent, so the batch summary explains parsed > inserted + skipped.
    if (isCcCuotaBillingReferenceMerchant(line.merchant)) {
      skipped_cuota_billing.push(
        ccImportFlowItemFromRow(record, ccStatementLabel(statementDate, "clp"))
      );
      continue;
    }
    // A line repeated within one paste imports once; report the drop instead of hiding it
    // (the terse summary otherwise reads parsed > inserted + skipped with no explanation).
    if (isRepeatInPaste) {
      skipped_in_paste.push(ccImportFlowItemFromRow(record, ccStatementLabel(statementDate, "clp")));
    } else {
      records.push(record);
    }
  }

  return { records, skipped_in_paste, skipped_cuota_billing, skipped_saldo_inicial };
}

export function newWebPasteBatchId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const WEB_PASTE_CARD_GROUP_BY_ISSUER: Readonly<Record<string, string>> = {
  santander: "santander",
  bci: "BCI",
};

/**
 * Web-paste card group + card last4 of a credit-card master, from structured identity only: the
 * issuer from `accounts.import_key` (`credit_card_master|<issuer>|<key>`) and the last4 from
 * `credit_card_account_config.card_last4` — the card identity; the import_key suffix is a stable
 * dedupe key, not the plastic, so it is not read. Throws for an account that is not a master, an
 * issuer with no web-paste card group, or a master without a config last4: all data problems,
 * never "not a card".
 */
export function creditCardMasterMetaForAccount(accountId: number): {
  cardGroup: string;
  cardLast4: string;
} {
  const row = db
    .prepare(
      `SELECT a.import_key, c.card_last4
       FROM accounts a
       LEFT JOIN credit_card_account_config c ON c.account_id = a.id
       WHERE a.id = ?`
    )
    .get(accountId) as { import_key: string | null; card_last4: string | null } | undefined;
  if (!row) throw new Error(`Account ${accountId} does not exist`);
  const issuer = /^credit_card_master\|([^|]+)\|[^|]+$/.exec(String(row.import_key ?? "").trim())?.[1];
  if (!issuer) {
    throw new Error(
      `Account ${accountId} is not a credit card master (import_key ${JSON.stringify(row.import_key)})`
    );
  }
  const cardGroup = WEB_PASTE_CARD_GROUP_BY_ISSUER[issuer];
  if (!cardGroup) {
    throw new Error(`Credit card master ${accountId}: issuer "${issuer}" has no web-paste card group`);
  }
  const cardLast4 = String(row.card_last4 ?? "").trim();
  if (!/^\d{4}$/.test(cardLast4)) {
    throw new Error(
      `Credit card master ${accountId} has no valid credit_card_account_config.card_last4 (${JSON.stringify(row.card_last4)})`
    );
  }
  return { cardGroup, cardLast4 };
}
