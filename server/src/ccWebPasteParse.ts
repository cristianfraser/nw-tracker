import crypto from "node:crypto";
import {
  cardLineKind,
  isCcPaymentMerchant,
  EMPTY_CARD_STATEMENT_HEADER,
  type CardCanonicalLine,
  type CardCanonicalStatement,
  type CardPastedListing,
} from "nw-tracker-contracts";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import { statementCloseDdMmYyyyForBillingMonth, targetBillingMonthForManualImports } from "./cards/facturacion.js";
import { ccOneShotDedupeKey, normCcMerchant } from "./ccDedupeKey.js";
import { activeAdditionalCardLast4ForAccount } from "./ccAdditionalCardExpenseMatch.js";
import { db } from "./db.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug, ccIssuerForWebPasteCardGroup } from "./ccIssuers.js";
import { ccImportFlowItemFromLine, ccStatementLabel, type CcImportFlowItem } from "./ccStatementsImport.js";
import { pesosOrDollars } from "./ingestCurrencies.js";

/**
 * One line of a card's listing of movements not billed yet — the nightly feed, a pasted table, a
 * planted payment, a receipt's line — in the canonical card-line terms: debt-positive (a charge
 * positive, a payment or credit negative) in its own currency. Each source converts once into
 * this (the feed: `listingLineFromCardListingLine`; a paste: {@link webPasteLinesFromPastedListing},
 * which applies the issuer's web-UI sign), and {@link listingStatements} files the lines into the
 * card's open buckets as canonical statements.
 */
export type CcListingLine = {
  transaction_date: string;
  merchant: string;
  currency: "clp" | "usd"; // convention-ok: the bank's web table is in pesos or dollars only (plan C3 leftover)
  /** Debt-positive, in `currency`. */
  amount: number;
  raw_line: string;
  /**
   * Card feed only: this row is a purchase in cuotas (the feed types it), listed at its full
   * principal. `cuota_count` when known — printed in the type, or read from the same-day
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

export type CcListingParseResult = {
  lines: CcListingLine[];
  errors: string[];
};

/**
 * A paste the ingest service read (`card.pasted_listing`, `POST /parse/card.web_paste`) → listing
 * lines: merchants normalized the way every card source's are (`normCcMerchant`), amounts turned
 * debt-positive by the issuer's web-UI sign (`CC_ISSUERS[…].web_paste.sign`, found by the card
 * group the paste goes under: Santander shows charges negative, so its signs flip).
 */
export function webPasteLinesFromPastedListing(listing: CardPastedListing, cardGroup: string): CcListingParseResult {
  const flip = ccIssuerForWebPasteCardGroup(cardGroup).web_paste.sign === "charges_negative";
  return {
    lines: listing.lines.map((l) => ({
      transaction_date: l.date,
      merchant: normCcMerchant(l.merchant),
      currency: pesosOrDollars(l.currency, "card.pasted_listing"),
      amount: flip ? -l.amount : l.amount,
      raw_line: l.raw_line,
    })),
    errors: listing.errors,
  };
}

/**
 * A listing line's amount as stored: a payment (PAGO, ABONO, …) is always a credit, whatever sign
 * the listing showed; pesos are whole.
 */
export function listingLineStoredAmount(line: Pick<CcListingLine, "merchant" | "currency" | "amount">): number {
  const amount = line.currency === "clp" ? Math.trunc(line.amount) : line.amount; // convention-ok: the bank's web table is in pesos or dollars only (plan C3 leftover)
  if (amount === 0) return 0;
  return isCcPaymentMerchant(line.merchant) ? -Math.abs(amount) : amount;
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
export function webPasteLineDedupeKey(cardGroup: string, line: CcListingLine): string {
  const dedupeAmount = line.currency === "usd" ? Math.round(Math.abs(line.amount) * 100) : Math.abs(line.amount); // convention-ok: the bank's web table is in pesos or dollars only (plan C3 leftover)
  return ccOneShotDedupeKey(cardGroup, line.merchant, dedupeAmount, line.transaction_date);
}

/**
 * The one-shot keys of a whole listing, occurrence-indexed: the Nth identical row (same merchant,
 * amount and date) gets `#dupN`, the parser's convention for same-statement twins. A pasted table
 * or the nightly feed is the complete «movimientos no facturados» list, so a row it shows twice is
 * two charges (two Grindr subscriptions billed the same day), never one listed twice — the overlap
 * with what is already on file is the merge's dedupe against the DB, by these same keys.
 */
export function webPasteListingDedupeKeys(cardGroup: string, lines: readonly CcListingLine[]): string[] {
  const occurrence = new Map<string, number>();
  return lines.map((line) => {
    const base = webPasteLineDedupeKey(cardGroup, line);
    const n = occurrence.get(base) ?? 0;
    occurrence.set(base, n + 1);
    return n === 0 ? base : `${base}#dup${n}`;
  });
}

export type CcListingStatementsOpts = {
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

/**
 * Listing lines → the canonical statements of the card's open buckets (one per facturación month:
 * `import:web-paste|open|<month>`, closing on the month's config close), each line with its
 * occurrence-indexed one-shot key and its kind. The previous facturación's «SALDO INICIAL» row and
 * the bank's cuota-billing re-listings are reported, never filed.
 */
export function listingStatements(
  accountId: number,
  cardGroup: string,
  cardLast4: string,
  parsed: readonly CcListingLine[],
  opts?: CcListingStatementsOpts
): {
  statements: CardCanonicalStatement[];
  skipped_cuota_billing: CcImportFlowItem[];
  skipped_saldo_inicial: CcImportFlowItem[];
} {
  const openBillingMonth = targetBillingMonthForManualImports(accountId, cardLast4);
  /** One open-period bucket per billing month (append on re-import via dedupe_key). */
  const bucketFor = new Map<string, CardCanonicalStatement>();
  const bucket = (billingMonth: string): CardCanonicalStatement => {
    let b = bucketFor.get(billingMonth);
    if (!b) {
      b = {
        document: `import:web-paste|open|${billingMonth}`,
        card_group: cardGroup,
        close: statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth),
        period_from: null,
        period_to: null,
        pay_by: null,
        card_last4: cardLast4,
        card_product: null,
        // USD charges land on the CLP open bucket as foreign lines: MONTO US$ is authoritative and
        // the CLP value is derived at read time via FX (effectiveCcExpenseLineAmountClp).
        currency: "clp",
        layout: "compact",
        header: EMPTY_CARD_STATEMENT_HEADER,
        lines: [],
      };
      bucketFor.set(billingMonth, b);
    }
    return b;
  };

  let additionalLast4: string | null = null;
  const additionalCardLast4 = () => (additionalLast4 ??= activeAdditionalCardLast4ForAccount(accountId));

  const skipped_cuota_billing: CcImportFlowItem[] = [];
  const skipped_saldo_inicial: CcImportFlowItem[] = [];
  // Occurrence-indexed: a row the listing shows twice is two charges (`#dupN`, see
  // webPasteListingDedupeKeys); the merge keys both on it, so re-pasting stays idempotent.
  const dedupeKeys = webPasteListingDedupeKeys(cardGroup, parsed);
  const lineMonths = opts?.lineBillingMonths;
  if (lineMonths && lineMonths.length !== parsed.length) {
    throw new Error(`listingStatements: ${lineMonths.length} line billing month(s) for ${parsed.length} line(s)`);
  }

  parsed.forEach((line, i) => {
    const billingMonth = lineMonths?.[i] ?? opts?.targetBillingMonth ?? openBillingMonth;
    const statement = bucket(billingMonth);
    const dedupe_key = dedupeKeys[i]!;
    const amount = listingLineStoredAmount(line);
    const merchant = line.merchant.trim();
    const canonical: CardCanonicalLine = {
      kind: cardLineKind({
        installment_flag: false,
        merchant: merchant || null,
        amount_clp: line.currency === "clp" ? amount : 0, // convention-ok: the bank's web table is in pesos or dollars only (plan C3 leftover)
        amount_usd: line.currency === "usd" ? amount : null, // convention-ok: the bank's web table is in pesos or dollars only (plan C3 leftover)
        statement_currency: "clp",
      }),
      transaction_date: line.transaction_date,
      posting_date: null,
      printed_transaction_date: null,
      printed_posting_date: null,
      merchant,
      description: null,
      place: null,
      country: null,
      currency: line.currency,
      amount,
      origin_amount: null,
      installment: null,
      origin_card_last4: line.holder === "additional" ? additionalCardLast4() : null,
      cuota_purchase: line.cuota_purchase ?? null,
      document: {
        line_id: `web:${dedupe_key}`,
        dedupe_key,
        section: "compact",
        raw_text: line.raw_line.trim() || null,
        duplicate_across_statements: false,
        baseline_match: null,
      },
    };
    const label = ccStatementLabel(statement.close, "clp");
    // The previous facturación's total, not a purchase (the feed reads it as the observed close).
    if (isCcSaldoInicialMerchant(line.merchant)) {
      skipped_saldo_inicial.push(ccImportFlowItemFromLine(canonical, label));
      return;
    }
    // Cuota-billing reference rows never import — the installment schedule already bills them.
    // Reported, not silent, so the batch summary explains parsed > inserted + skipped.
    if (isCcCuotaBillingReferenceMerchant(line.merchant)) {
      skipped_cuota_billing.push(ccImportFlowItemFromLine(canonical, label));
      return;
    }
    statement.lines.push(canonical);
  });

  return { statements: [...bucketFor.values()].filter((b) => b.lines.length > 0), skipped_cuota_billing, skipped_saldo_inicial };
}

export function newWebPasteBatchId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Web-paste card group + card last4 of a credit-card master, from its config only: the issuer
 * (`credit_card_account_config.issuer`, whose `web_paste.card_group` names the bucket group) and
 * the card identity (`card_last4`); the import_key suffix is a stable dedupe key, not the plastic,
 * so it is not read. Throws for an account that is not a master or a master without a config
 * last4: data problems, never "not a card".
 */
export function creditCardMasterMetaForAccount(accountId: number): {
  cardGroup: string;
  cardLast4: string;
} {
  const issuer = ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!;
  const row = db
    .prepare(`SELECT card_last4 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { card_last4: string | null };
  const cardLast4 = String(row.card_last4 ?? "").trim();
  if (!/^\d{4}$/.test(cardLast4)) {
    throw new Error(
      `Credit card master ${accountId} has no valid credit_card_account_config.card_last4 (${JSON.stringify(row.card_last4)})`
    );
  }
  return { cardGroup: issuer.web_paste.card_group, cardLast4 };
}
