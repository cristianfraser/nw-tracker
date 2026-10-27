import crypto from "node:crypto";
import type { CardPastedListing } from "nw-tracker-contracts";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import {
  statementCloseDdMmYyyyForBillingMonth,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";
import { ccOneShotDedupeKey, normCcMerchant } from "./ccDedupeKey.js";
import { webPasteAmountClpForDb, webPasteAmountUsdForDb } from "./ccPaymentLines.js";
import { activeAdditionalCardLast4ForAccount } from "./ccAdditionalCardExpenseMatch.js";
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
  /**
   * Card feed only: whose plastic made the movement, when the feed says. An `additional` line is
   * stored with the account's additional card as its origin, so it is tagged `additional_card` on
   * import like the statement's line will be. Absent on pasted lines and pending authorizations.
   */
  holder?: "titular" | "additional";
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

/**
 * A paste the ingest service read (`card.pasted_listing`, `POST /parse/card.web_paste`) → the
 * import's line shape: merchants normalized the way every card source's are (`normCcMerchant`),
 * amounts still signed as the issuer's table prints them (`webPasteAmountClpForDb` /
 * `webPasteAmountUsdForDb` apply the issuer's rule when the lines are stored).
 */
export function webPasteLinesFromPastedListing(listing: CardPastedListing): CcWebPasteParseResult {
  return {
    lines: listing.lines.map((l) => ({
      transaction_date: l.date,
      merchant: normCcMerchant(l.merchant),
      amount_clp: l.currency === "clp" ? l.amount : 0,
      amount_usd: l.currency === "usd" ? l.amount : null,
      currency: l.currency,
      raw_line: l.raw_line,
    })),
    errors: listing.errors,
  };
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

/**
 * The one-shot keys of a whole listing, occurrence-indexed: the Nth identical row (same merchant,
 * amount and date) gets `#dupN`, the parser's convention for same-statement twins. A pasted table
 * or the nightly feed is the complete «movimientos no facturados» list, so a row it shows twice is
 * two charges (two Grindr subscriptions billed the same day), never one listed twice — the overlap
 * with what is already on file is the merge's dedupe against the DB, by these same keys.
 */
export function webPasteListingDedupeKeys(cardGroup: string, lines: readonly CcWebPasteLine[]): string[] {
  const occurrence = new Map<string, number>();
  return lines.map((line) => {
    const base = webPasteLineDedupeKey(cardGroup, line);
    const n = occurrence.get(base) ?? 0;
    occurrence.set(base, n + 1);
    return n === 0 ? base : `${base}#dup${n}`;
  });
}

export type CcWebPasteRecordsOpts = {
  /**
   * Put every line in this facturación's bucket instead of the open month. The card feed passes
   * the month after its own SALDO INICIAL close: everything it lists after a close is unbilled by
   * definition, whatever the row's date says (a pending authorization that settled after the
   * close keeps its earlier date).
   */
  targetBillingMonth?: string;
  /**
   * One bucket month per line, aligned with `parsed` (the feed decides each row's facturación:
   * `feedLineBillingMonths` in `cardUnbilledMovementsApply.ts`). An entry wins over
   * `targetBillingMonth`; a length that differs from the lines' throws. Lines of several months
   * share one import: one bucket per month, dedupe keys and the batch log as before.
   */
  lineBillingMonths?: readonly string[];
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

  let additionalLast4: string | null = null;
  const additionalCardLast4 = () => (additionalLast4 ??= activeAdditionalCardLast4ForAccount(accountId));

  const records: CcStatementCsvRecord[] = [];
  const skipped_cuota_billing: CcImportFlowItem[] = [];
  const skipped_saldo_inicial: CcImportFlowItem[] = [];
  // Occurrence-indexed: a row the listing shows twice is two charges (`#dupN`, see
  // webPasteListingDedupeKeys); the merge keys both on it, so re-pasting stays idempotent.
  const dedupeKeys = webPasteListingDedupeKeys(cardGroup, parsed);
  const lineMonths = opts?.lineBillingMonths;
  if (lineMonths && lineMonths.length !== parsed.length) {
    throw new Error(
      `ccWebPasteToCsvRecords: ${lineMonths.length} line billing month(s) for ${parsed.length} line(s)`
    );
  }

  parsed.forEach((line, i) => {
    const billingMonth = lineMonths?.[i] ?? opts?.targetBillingMonth ?? openBillingMonth;
    const { sourcePdf, statementDate } = bucket(billingMonth);
    const isUsd = line.currency === "usd";
    const dedupe_key = dedupeKeys[i]!;

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
      ...(line.holder === "additional" ? { origin_card_last4: additionalCardLast4() } : {}),
    };
    // The previous facturación's total, not a purchase (the feed reads it as the observed close).
    if (isCcSaldoInicialMerchant(line.merchant)) {
      skipped_saldo_inicial.push(
        ccImportFlowItemFromRow(record, ccStatementLabel(statementDate, "clp"))
      );
      return;
    }
    // Cuota-billing reference rows never import — the installment schedule already bills them.
    // Reported, not silent, so the batch summary explains parsed > inserted + skipped.
    if (isCcCuotaBillingReferenceMerchant(line.merchant)) {
      skipped_cuota_billing.push(
        ccImportFlowItemFromRow(record, ccStatementLabel(statementDate, "clp"))
      );
      return;
    }
    records.push(record);
  });

  return { records, skipped_cuota_billing, skipped_saldo_inicial };
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
