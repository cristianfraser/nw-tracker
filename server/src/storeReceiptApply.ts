/**
 * `store.receipt` → grocery tables + the purchase's card line. The feeder (ingest: the photo
 * inbox, OCR, the receipt parsers, the staged corpus and its import stamps) sends one receipt per
 * request; this module owns everything the database decides.
 *
 *  1. IDENTITY. A receipt's natural identity is `receipt_key` = chain|receipt_number|date
 *     (migration 178); `source` / `source_key` are the kind and identity of the document that owns
 *     the row. The same receipt can arrive as an e-mail AND as a photo of the paper copy, so the
 *     two must collapse onto one row: a higher-ranked document (e-mail / PDF > photo) REPLACES the
 *     owner, a lower- or equal-ranked one arriving second is SKIPPED (reported, never written —
 *     equal rank is "first writer wins", which keeps two photos of one receipt from ping-ponging
 *     the row between their keys). A document whose own identity now resolves to a receipt another
 *     document owns throws: a parser change moved an identity, which must surface rather than be
 *     reconciled by guess.
 *
 *  2. ALWAYS for the owner (idempotent, full history): the receipt + items land in
 *     `grocery_receipts` / `grocery_receipt_items` with provenance frozen (chain, branch, city,
 *     printed local datetime, payment legs). Items resolve to canonical products through
 *     `grocery_product_aliases` (barcode first, printed description second — chain-scoped) and
 *     STAMP the resolution; re-imports upsert by (receipt, position) and preserve stamps unless
 *     the printed description itself changed (a parser fix that renames a line sends it back to
 *     unclassified — re-matching an old rule against new text would be silent misclassification).
 *
 *  3. Card line, per chain. A chain with a card rule (`CHAIN_CARD_RULES`: Lider, whose co-branded
 *     BCI card has no other feed — the CSV scrape retired 2026-08-07) gets its card line WRITTEN,
 *     only when BOTH hold: the receipt was paid with that card's payment leg (cash/TBK/other-card
 *     receipts store items only), AND the purchase date is inside the account's open facturación
 *     (closed months are statement-covered). The line goes through the web-paste path on the
 *     registry-resolved master with the bank's exact merchant string for the branch
 *     (`boleta_sucursal_merchants` — the paper and e-mail renderings of one branch print different
 *     strings, so each rendering is its own registry key — plus the LEARNED map in
 *     `grocery_branch_merchants`), so dedupe collides head-on with the feed/statement rendering; the
 *     same-day+amount guard covers a differently-named twin. A branch neither map names is never
 *     guessed: the receipt is FLAGGED (`card_line_status = 'pending_branch'`, no line written) and
 *     the bank's own line for the same day and pesos — paste, feed or statement PDF — pairs with it
 *     and teaches the mapping (`groceryBranchLearning.ts`, hooked into the shared card-write
 *     funnel). A chain with a match rule (`CHAIN_MATCH_RULES`: Jumbo, paid on a card whose feed
 *     already carries the purchase) is LINKED to its existing card line; any other chain is
 *     items-only.
 *
 * `details.final` tells the feeder whether the outcome can still change (`pending_branch`,
 * `awaiting_card_line`): it stamps only final outcomes and sends the others again next run.
 */
import type { StoreReceiptApplyDetails, StoreReceiptDocumentKind, StoreReceiptPayload } from "nw-tracker-contracts";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { ccCardRegistry } from "./ccCardRegistry.js";
import {
  learnBranchForPendingReceipt,
  markReceiptCardLine,
  receiptCardLineRawLinePrefix,
  receiptCardLineStatus,
  resolveBranchMerchant,
  type PendingBranchReceipt,
} from "./groceryBranchLearning.js";
import { lastPdfBillingMonthForAccount, periodToIsoForBillingMonth } from "./ccManualBillingMonth.js";
import { importCcWebPasteLines } from "./accountImports.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";
import type { ImportBatchKind } from "./importBatches.js";
import { classifyLiderLines, liderMasterAccountId } from "./liderMovementsImport.js";
import { statementLineDateIso } from "./ccInstallmentPayBy.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

export const GROCERY_CHAIN_LIDER = "lider";

/** The `grocery_receipts.source` of each document kind (migration 205 named them alike). */
export type GroceryReceiptSource = StoreReceiptDocumentKind;
const GROCERY_RECEIPT_SOURCES: readonly GroceryReceiptSource[] = ["email", "pdf", "photo"];
/** Which document owns a receipt when two describe it: a PDF (mailed or saved) over an OCR'd photo. */
const SOURCE_RANK: Readonly<Record<GroceryReceiptSource, number>> = { email: 2, pdf: 2, photo: 1 };

function isGroceryReceiptSource(v: unknown): v is GroceryReceiptSource {
  return typeof v === "string" && (GROCERY_RECEIPT_SOURCES as readonly string[]).includes(v);
}

/** A movement outcome that no later import could change: the feeder stamps only these. */
export function movementIsTerminal(status: StoreReceiptApplyDetails["movement"]["status"]): boolean {
  // Both wait for the bank's own line: an unknown branch to learn, a recent purchase to link.
  return status !== "pending_branch" && status !== "awaiting_card_line";
}

/** One receipt as this module handles it: the payload's fields under the names the tables use. */
export type IncomingReceipt = {
  source: GroceryReceiptSource;
  source_key: string;
  chain: string;
  photo_taken_on: string | null;
  parsed: {
    boleta_number: string | null;
    sucursal: string;
    city: string | null;
    purchased_at: string | null;
    purchase_date_source: "printed" | "declared" | null;
    items: StoreReceiptPayload["receipt"]["items"];
    receipt_discounts: StoreReceiptPayload["receipt"]["receipt_discounts"];
    payments: { method: string; amount_clp: number }[];
    mi_club_points: number | null;
  };
};

export function incomingReceiptFromPayload(payload: StoreReceiptPayload): IncomingReceipt {
  const r = payload.receipt;
  return {
    source: payload.document.kind,
    source_key: payload.document.key,
    chain: r.chain,
    photo_taken_on: payload.document.photo_taken_on,
    parsed: {
      boleta_number: r.number,
      sucursal: r.branch,
      city: r.city,
      purchased_at: r.purchased_at,
      purchase_date_source: r.purchase_date_source,
      items: r.items,
      receipt_discounts: r.receipt_discounts,
      payments: r.payments.map((p) => ({ method: p.method, amount_clp: p.amount })),
      mi_club_points: r.loyalty_points,
    },
  };
}

type ParsedReceipt = IncomingReceipt["parsed"];

/** A receipt whose number and purchase date are known (`resolveReceiptFacts`). */
export type ResolvedReceipt = IncomingReceipt & {
  parsed: ParsedReceipt & { boleta_number: string; purchased_at: string };
};

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/**
 * Natural receipt identity, `<chain>|<receipt_number>|<YYYY-MM-DD>` — the same formula
 * migration 178 backfilled (`groceryReceiptKey178.ts`); keep the two in step.
 */
export function groceryReceiptKey(chain: string, receiptNumber: string, purchasedAt: string): string {
  const day = purchasedAt.slice(0, 10);
  if (!chain || !receiptNumber || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `grocery receipt key needs chain, receipt number and a 'YYYY-MM-DD …' purchase datetime, got ${JSON.stringify({ chain, receiptNumber, purchasedAt })}`
    );
  }
  return `${chain}|${receiptNumber}|${day}`;
}

export type ReceiptResolution =
  | { action: "insert" }
  /** This document already owns the row (re-import, or its identity re-derived onto a free key). */
  | { action: "update"; id: number }
  /** A higher-ranked document takes the row over from `displaced`. */
  | { action: "replace"; id: number; displaced: GroceryReceiptSource }
  /** A lower- or equal-ranked document arrived second: nothing is written. */
  | { action: "skip"; id: number; owner: GroceryReceiptSource };

const selectByKey = db.prepare(
  `SELECT id, source, source_key FROM grocery_receipts WHERE receipt_key = ?`
);
const selectBySourceKey = db.prepare(`SELECT id, receipt_key FROM grocery_receipts WHERE source_key = ?`);

export function resolveReceiptOwnership(staged: ResolvedReceipt): {
  receiptKey: string;
  resolution: ReceiptResolution;
} {
  const receiptKey = groceryReceiptKey(staged.chain, staged.parsed.boleta_number, staged.parsed.purchased_at);
  const bySource = selectBySourceKey.get(staged.source_key) as { id: number; receipt_key: string } | undefined;
  const byKey = selectByKey.get(receiptKey) as { id: number; source: string; source_key: string } | undefined;
  if (bySource) {
    if (byKey && byKey.id !== bySource.id) {
      throw new Error(
        `document ${staged.source}:${staged.source_key} now resolves to receipt ${receiptKey}, owned by ` +
          `${byKey.source}:${byKey.source_key} (row ${byKey.id}), while this document owns row ${bySource.id} ` +
          `(${bySource.receipt_key}) — a parser change moved a receipt identity; resolve by hand`
      );
    }
    return { receiptKey, resolution: { action: "update", id: bySource.id } };
  }
  if (byKey) {
    if (!isGroceryReceiptSource(byKey.source)) {
      throw new Error(`receipt ${receiptKey} (row ${byKey.id}) carries unknown source ${JSON.stringify(byKey.source)}`);
    }
    return SOURCE_RANK[staged.source] > SOURCE_RANK[byKey.source]
      ? { receiptKey, resolution: { action: "replace", id: byKey.id, displaced: byKey.source } }
      : { receiptKey, resolution: { action: "skip", id: byKey.id, owner: byKey.source } };
  }
  return { receiptKey, resolution: { action: "insert" } };
}

// ---------------------------------------------------------------------------------------------
// Per-chain card-movement rules
// ---------------------------------------------------------------------------------------------

type ChainCardRule = {
  /** The parsed payment method that is the chain's co-branded card — the only leg that becomes a card line. */
  payment_method: string;
  batch_kind: ImportBatchKind;
  master_account_id: () => number;
  /** Printed branch string (every rendering of it) → the bank's exact merchant string. */
  branch_merchants: () => Readonly<Record<string, string>>;
  classify: (accountId: number, lines: readonly CcWebPasteLine[]) => { importable: CcWebPasteLine[] };
  raw_line_prefix: string;
};

const CHAIN_CARD_RULES: Readonly<Record<string, ChainCardRule>> = {
  [GROCERY_CHAIN_LIDER]: {
    payment_method: "tarjeta_lider_bci",
    batch_kind: "cc_lider_boleta",
    master_account_id: liderMasterAccountId,
    branch_merchants: () => ccCardRegistry().boleta_sucursal_merchants,
    classify: classifyLiderLines,
    raw_line_prefix: receiptCardLineRawLinePrefix(GROCERY_CHAIN_LIDER),
  },
};

/** The card master a chain's receipts can write movements on; null for items-only chains. */
export function chainCardMasterAccountId(chain: string): number | null {
  const rule = CHAIN_CARD_RULES[chain];
  return rule ? rule.master_account_id() : null;
}

function cardPaidClp(parsed: ParsedReceipt, rule: ChainCardRule | undefined): number {
  if (!rule) return 0;
  return parsed.payments
    .filter((p) => p.method === rule.payment_method)
    .reduce((sum, p) => sum + p.amount_clp, 0);
}

function totalClp(parsed: ParsedReceipt): number {
  return parsed.payments.reduce((sum, p) => sum + p.amount_clp, 0);
}

/**
 * A chain whose purchases the card data already carries (its card is not co-branded: the bank's
 * own feed and statements list the purchase): nothing is written, the receipt is LINKED to the
 * card line that is its purchase — same pesos, the chain's merchant name, the purchase day (or,
 * for a receipt that prints no date, the days up to the photo) — and an undated receipt takes
 * that line's date.
 */
type ChainMatchRule = {
  /** Payment legs that are a card charge. */
  payment_methods: readonly string[];
  /** How the bank names the chain's stores. */
  merchant: RegExp;
};

const CHAIN_MATCH_RULES: Readonly<Record<string, ChainMatchRule>> = {
  jumbo: { payment_methods: ["t_credito"], merchant: /\b(JUMBO|CENCOSUD)\b/i },
};

/** A photo is taken on or up to this many days after the purchase it shows. */
export const UNDATED_RECEIPT_LOOKBACK_DAYS = 7;
/** A dated receipt whose card line is missing waits this long for the feed / statement to list it. */
export const CARD_LINE_WAIT_DAYS = 45;

export type CardLineMatch =
  | { status: "matched"; account_id: number; line_date: string; merchant: string }
  | { status: "no_card_line" | "not_card_paid" }
  | { status: "ambiguous_card_line"; candidates: number };

const selectCardLinesByAmount = db.prepare(
  `SELECT DISTINCT s.account_id, l.transaction_date, l.posting_date, l.merchant
   FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
   WHERE l.amount_clp = ?`
);

function ymdAddDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The card line that is this purchase, in `[fromYmd, toYmd]`. */
export function findReceiptCardLine(rule: ChainMatchRule, paidClp: number, fromYmd: string, toYmd: string): CardLineMatch {
  if (paidClp <= 0) return { status: "not_card_paid" };
  const seen = new Set<string>();
  const hits: Extract<CardLineMatch, { status: "matched" }>[] = [];
  for (const row of selectCardLinesByAmount.all(paidClp) as {
    account_id: number;
    transaction_date: string | null;
    posting_date: string | null;
    merchant: string | null;
  }[]) {
    const date = statementLineDateIso(row);
    if (!date || date < fromYmd || date > toYmd || !rule.merchant.test(row.merchant ?? "")) continue;
    // The same purchase on two statement versions (or a bucket line and its statement) is one hit.
    const key = `${row.account_id}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ status: "matched", account_id: row.account_id, line_date: date, merchant: row.merchant ?? "" });
  }
  if (hits.length === 1) return hits[0]!;
  return hits.length === 0 ? { status: "no_card_line" } : { status: "ambiguous_card_line", candidates: hits.length };
}

export type PurchaseDateSource = "printed" | "declared" | "card_line" | "photo";

/**
 * The receipt's identity fields where the photo lost them, and its card line. A receipt with no
 * printed number is keyed on the photo (`photo-<sha12>` — stable across runs, so a re-import is
 * a repeat, not a new receipt). A receipt with no date takes its card line's date (a line of the
 * chain for the paid pesos in the week up to the photo), else the photo's own date; one with
 * neither a date nor a dated photo name throws — declare it in the correction file.
 */
export function resolveReceiptFacts(staged: IncomingReceipt): {
  staged: ResolvedReceipt;
  date_source: PurchaseDateSource;
  card_line: CardLineMatch | null;
} {
  const { parsed } = staged;
  let boleta = parsed.boleta_number;
  if (!boleta) {
    if (staged.source !== "photo") throw new Error(`${staged.chain} receipt ${staged.source_key}: no number on a ${staged.source}`);
    boleta = `photo-${staged.source_key.slice(0, 12)}`;
  }
  const rule = CHAIN_MATCH_RULES[staged.chain];
  const paid = rule ? parsed.payments.filter((p) => rule.payment_methods.includes(p.method)).reduce((s, p) => s + p.amount_clp, 0) : 0;
  let purchasedAt = parsed.purchased_at;
  let dateSource: PurchaseDateSource = parsed.purchase_date_source === "declared" ? "declared" : "printed";
  let cardLine: CardLineMatch | null = null;
  if (purchasedAt) {
    const day = purchasedAt.slice(0, 10);
    cardLine = rule ? findReceiptCardLine(rule, paid, day, day) : null;
  } else {
    if (!staged.photo_taken_on) {
      throw new Error(
        `${staged.chain} receipt ${staged.source_key}: the receipt prints no date and the photo is not named YYYY:MM:DD — declare it in ocr.corrected.txt (#! purchase_date: YYYY-MM-DD)`
      );
    }
    const photo = staged.photo_taken_on;
    cardLine = rule ? findReceiptCardLine(rule, paid, ymdAddDays(photo, -UNDATED_RECEIPT_LOOKBACK_DAYS), photo) : null;
    if (cardLine?.status === "matched") {
      purchasedAt = `${cardLine.line_date} 00:00:00`;
      dateSource = "card_line";
    } else {
      purchasedAt = `${photo} 00:00:00`;
      dateSource = "photo";
    }
  }
  return {
    staged: { ...staged, parsed: { ...parsed, boleta_number: boleta, purchased_at: purchasedAt } },
    date_source: dateSource,
    card_line: cardLine,
  };
}

// ---------------------------------------------------------------------------------------------
// Receipt + items write
// ---------------------------------------------------------------------------------------------

const RECEIPT_COLUMNS = `receipt_key, source, source_key, receipt_number, store_chain, branch, city, purchased_at,
     total_clp, discount_total_clp, receipt_discount_clp, receipt_discounts_json,
     payments_json, card_paid_clp, mi_club_points`;
const insertReceipt = db.prepare(
  `INSERT INTO grocery_receipts (${RECEIPT_COLUMNS})
   VALUES (@receipt_key, @source, @source_key, @receipt_number, @store_chain, @branch, @city, @purchased_at,
     @total_clp, @discount_total_clp, @receipt_discount_clp, @receipt_discounts_json,
     @payments_json, @card_paid_clp, @mi_club_points)`
);
const updateReceipt = db.prepare(
  `UPDATE grocery_receipts SET
     receipt_key = @receipt_key, source = @source, source_key = @source_key,
     receipt_number = @receipt_number, store_chain = @store_chain, branch = @branch, city = @city,
     purchased_at = @purchased_at, total_clp = @total_clp, discount_total_clp = @discount_total_clp,
     receipt_discount_clp = @receipt_discount_clp, receipt_discounts_json = @receipt_discounts_json,
     payments_json = @payments_json, card_paid_clp = @card_paid_clp, mi_club_points = @mi_club_points
   WHERE id = @id`
);

const selectItem = db.prepare(
  `SELECT id, description, product_id FROM grocery_receipt_items WHERE receipt_id = ? AND position = ?`
);
const insertItem = db.prepare(
  `INSERT INTO grocery_receipt_items (
     receipt_id, position, barcode, description, qty, qty_unit, unit_price_clp, total_clp,
     discount_clp, discount_labels_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateItem = db.prepare(
  `UPDATE grocery_receipt_items SET barcode = ?, description = ?, qty = ?, qty_unit = ?,
     unit_price_clp = ?, total_clp = ?, discount_clp = ?, discount_labels_json = ?,
     product_id = ?, product_source = ?
   WHERE id = ?`
);
const deleteTailItems = db.prepare(
  `DELETE FROM grocery_receipt_items WHERE receipt_id = ? AND position >= ?`
);

const aliasByBarcode = db.prepare(
  `SELECT product_id FROM grocery_product_aliases WHERE store_chain = ? AND barcode = ?`
);
const aliasByDescription = db.prepare(
  `SELECT product_id FROM grocery_product_aliases WHERE store_chain = ? AND description = ?`
);
const stampItem = db.prepare(
  `UPDATE grocery_receipt_items SET product_id = ?, product_source = 'alias'
   WHERE id = ? AND product_id IS NULL`
);

/** Alias resolution for one chain: barcode identity first, printed description second. */
export function resolveAliasProductId(
  chain: string,
  barcode: string | null,
  description: string
): number | null {
  if (barcode) {
    const hit = aliasByBarcode.get(chain, barcode) as { product_id: number } | undefined;
    if (hit) return hit.product_id;
  }
  const hit = aliasByDescription.get(chain, description) as { product_id: number } | undefined;
  return hit?.product_id ?? null;
}

function writeReceiptRow(
  staged: ResolvedReceipt,
  receiptKey: string,
  resolution: Exclude<ReceiptResolution, { action: "skip" }>,
  rule: ChainCardRule | undefined
): number {
  const { parsed } = staged;
  const params = {
    receipt_key: receiptKey,
    source: staged.source,
    source_key: staged.source_key,
    receipt_number: parsed.boleta_number,
    store_chain: staged.chain,
    branch: parsed.sucursal,
    city: parsed.city,
    purchased_at: parsed.purchased_at,
    total_clp: totalClp(parsed),
    discount_total_clp: parsed.items.reduce((s, i) => s + i.discount, 0),
    receipt_discount_clp: parsed.receipt_discounts.reduce((s, d) => s + d.amount, 0),
    // Stored in the shape the receipts page has always read.
    receipt_discounts_json: parsed.receipt_discounts.length
      ? JSON.stringify(parsed.receipt_discounts.map((d) => ({ label: d.label, amount_clp: d.amount })))
      : null,
    payments_json: JSON.stringify(parsed.payments),
    card_paid_clp: cardPaidClp(parsed, rule),
    mi_club_points: parsed.mi_club_points,
  };
  if (resolution.action === "insert") {
    return Number(insertReceipt.run(params).lastInsertRowid);
  }
  updateReceipt.run({ ...params, id: resolution.id });
  return resolution.id;
}

function upsertReceiptItems(receiptId: number, chain: string, parsed: ParsedReceipt): number {
  for (const item of parsed.items) {
    const existing = selectItem.get(receiptId, item.position) as
      | { id: number; description: string; product_id: number | null }
      | undefined;
    const labels = item.discount_labels.length ? JSON.stringify(item.discount_labels) : null;
    if (!existing) {
      insertItem.run(
        receiptId,
        item.position,
        item.barcode,
        item.description,
        item.qty,
        item.qty_unit,
        item.unit_price,
        item.total,
        item.discount,
        labels
      );
    } else {
      // Preserve the stamp unless the printed description itself changed under this position.
      const keepStamp = existing.description === item.description;
      const productId = keepStamp ? existing.product_id : null;
      updateItem.run(
        item.barcode,
        item.description,
        item.qty,
        item.qty_unit,
        item.unit_price,
        item.total,
        item.discount,
        labels,
        productId,
        productId != null ? "alias" : null,
        existing.id
      );
    }
  }
  deleteTailItems.run(receiptId, parsed.items.length);

  // Resolve still-unclassified items through the alias table.
  const unclassified = db
    .prepare(
      `SELECT id, barcode, description FROM grocery_receipt_items
       WHERE receipt_id = ? AND product_id IS NULL`
    )
    .all(receiptId) as { id: number; barcode: string | null; description: string }[];
  for (const item of unclassified) {
    const productId = resolveAliasProductId(chain, item.barcode, item.description);
    if (productId != null) stampItem.run(productId, item.id);
  }
  const stillNull = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ? AND product_id IS NULL`)
      .get(receiptId) as { c: number }
  ).c;
  return parsed.items.length - stillNull;
}

const writeReceipt = db.transaction(
  (
    staged: ResolvedReceipt,
    receiptKey: string,
    resolution: Exclude<ReceiptResolution, { action: "skip" }>,
    rule: ChainCardRule | undefined
  ): { receiptId: number; classified: number } => {
    const receiptId = writeReceiptRow(staged, receiptKey, resolution, rule);
    const classified = upsertReceiptItems(receiptId, staged.chain, staged.parsed);
    return { receiptId, classified };
  }
);

/** Inclusive ISO end of the last fully-closed facturación; null when no statement exists. */
export function lastClosedPeriodEndIso(accountId: number): string | null {
  const bm = lastPdfBillingMonthForAccount(accountId);
  if (!bm) return null;
  return periodToIsoForBillingMonth(accountId, bm);
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export function applyStoreReceipt(payload: StoreReceiptPayload): StoreReceiptApplyDetails {
  const dryRun = !payload.apply;
  const facts = resolveReceiptFacts(incomingReceiptFromPayload(payload));
  const receipt = facts.staged;
  const { receiptKey, resolution } = resolveReceiptOwnership(receipt);
  const rule = CHAIN_CARD_RULES[receipt.chain];
  const paid = cardPaidClp(receipt.parsed, rule);
  const purchaseIso = receipt.parsed.purchased_at.slice(0, 10);
  let receiptId = resolution.action === "insert" ? -1 : resolution.id;
  let classified = 0;
  if (resolution.action !== "skip" && !dryRun) {
    ({ receiptId, classified } = writeReceipt(receipt, receiptKey, resolution, rule));
  }

  let movement: StoreReceiptApplyDetails["movement"];
  if (resolution.action === "skip") {
    movement = { status: "not_attempted" };
  } else if (!rule) {
    const line = facts.card_line;
    if (line === null) {
      movement = { status: "chain_items_only" };
    } else if (line.status === "matched") {
      movement = { status: "matched", branch: receipt.parsed.sucursal, merchant: line.merchant };
      if (!dryRun) markReceiptCardLine(receiptId, "matched", line.account_id);
    } else if (line.status === "no_card_line") {
      // A dated purchase the feed or statement has not listed yet keeps checking; an old one
      // (or an undated photo, whose date is now the photo's) stops.
      const waitFrom = ymdAddDays(chileCalendarTodayYmd(), -CARD_LINE_WAIT_DAYS);
      movement =
        facts.date_source !== "photo" && purchaseIso >= waitFrom ? { status: "awaiting_card_line" } : { status: "no_card_line" };
    } else if (line.status === "ambiguous_card_line") {
      movement = { status: "ambiguous_card_line", candidates: line.candidates };
    } else {
      movement = { status: "not_card_paid" };
    }
  } else if (paid <= 0) {
    movement = { status: "not_card_paid" };
  } else {
    const accountId = rule.master_account_id();
    const closedThrough = lastClosedPeriodEndIso(accountId);
    const branch = receipt.parsed.sucursal;
    const stored = dryRun || receiptId < 0 ? null : receiptCardLineStatus(receiptId);
    const pending: PendingBranchReceipt = {
      receipt_id: receiptId,
      store_chain: receipt.chain,
      branch,
      card_line_account_id: accountId,
      purchase_ymd: purchaseIso,
      card_paid_clp: paid,
    };
    if (stored === "matched") {
      // Paired with the bank's own line by an earlier card write or an earlier import.
      movement = { status: "matched", branch, merchant: resolveBranchMerchant(receipt.chain, branch, rule.branch_merchants()) };
    } else if (closedThrough != null && purchaseIso <= closedThrough) {
      // Statement-covered. A receipt still pending at the close now has the statement's own
      // line to pair with, so it gets one more attempt before settling.
      if (stored === "pending_branch") {
        const learned = learnBranchForPendingReceipt(pending);
        movement = learned.status === "learned" ? { status: "matched", branch, merchant: learned.merchant } : { status: "closed_month" };
      } else {
        movement = { status: "closed_month" };
      }
    } else {
      const merchant = resolveBranchMerchant(receipt.chain, branch, rule.branch_merchants());
      if (!merchant) {
        if (dryRun) {
          movement = { status: "pending_branch", branch };
        } else {
          // Flag, don't fail: the bank's own line for this day and amount — whichever source
          // writes it — pairs the receipt and teaches the branch's merchant string. The line
          // may already be there (a paste that beat the receipt), so try at once.
          markReceiptCardLine(receiptId, "pending_branch", accountId);
          const learned = learnBranchForPendingReceipt(pending);
          movement = learned.status === "learned" ? { status: "matched", branch, merchant: learned.merchant } : { status: "pending_branch", branch };
        }
      } else if (dryRun) {
        movement = { status: "created" };
      } else {
        const line: CcWebPasteLine = {
          transaction_date: purchaseIso,
          merchant,
          amount_clp: paid,
          amount_usd: null,
          currency: "clp",
          raw_line: `${rule.raw_line_prefix}|${receipt.parsed.boleta_number}|${purchaseIso}|${paid}`,
        };
        const { importable } = rule.classify(accountId, [line]);
        if (importable.length === 0) {
          movement = { status: "same_day_amount" };
        } else {
          const res = importCcWebPasteLines(accountId, { lines: importable, errors: [] }, rule.batch_kind);
          movement = { status: res.inserted > 0 ? "created" : "duplicate" };
          // In-process writes do not bump data_version: drop the card's caches from the purchase on.
          if (res.inserted > 0) invalidateAggregationForAccountDate(accountId, purchaseIso);
        }
        markReceiptCardLine(receiptId, movement.status === "created" ? "created" : "covered", accountId);
      }
    }
  }

  return {
    chain: receipt.chain,
    receipt_key: receiptKey,
    receipt_id: receiptId,
    receipt_status:
      resolution.action === "insert"
        ? "inserted"
        : resolution.action === "update"
          ? "updated"
          : resolution.action === "replace"
            ? "replaced"
            : "skipped_duplicate",
    other_document: resolution.action === "replace" ? resolution.displaced : resolution.action === "skip" ? resolution.owner : null,
    purchased_at: receipt.parsed.purchased_at,
    purchase_date_source: facts.date_source,
    card_paid: paid,
    items: receipt.parsed.items.length,
    items_classified: classified,
    movement,
    final: movementIsTerminal(movement.status),
  };
}
