/**
 * Card lines estimated from receipts (docs/untangle-flow-model.md C; user decision 2026-11-08):
 *
 *   npx tsx scripts/estimate-card-lines-from-receipts.ts --since=YYYY-MM [--anchor=<json>] [--exclude=<id,…>] [--apply]
 *
 * For each card master, the months with no statement — from `since` (the card's start, which no
 * document states) to its first statement, the holes between statements — and the months whose
 * statement was rebuilt from mails: a receipt (processor receipt, shop order, Amazon shipment, Uber,
 * App Store) that the receipt matcher pairs with no card line and falls in such a month is the only
 * record of that purchase. It becomes one card line — the receipt's day, the payee as merchant, the
 * amount in the receipt's currency (a peso receipt of a sender that charged in dollars is a dollar
 * line at the day's rate when the card's own lines of that merchant were dollar lines) — on a
 * statement `import:estimate|receipts|<clp|usd>|<YYYY-MM>`, or on the rebuilt month's statement, whose
 * estimated weekly lumps shrink by the itemized sum (its billed total unchanged). Which card: the
 * one that carried the merchant in the nearest statement months; a tie is reported, not written.
 *
 * A rerun rewrites what an earlier run estimated: the `import:estimate|receipts|…` statements are
 * not statements to the gap detection (nor to the attribution), so their months are gaps again and
 * the funnel replaces the stored copies by key — a receipt the registry could not place before (a
 * plastic added to `cc-cards.json` since) lands in its month without deleting anything by hand.
 *
 * `--exclude` leaves receipts out by id (a line the matcher would not pair back with its receipt, as the
 * check below reports it). `--anchor` names a month whose only anchor is a mailed balance: `{card_master_account_id, date,
 * usd_debt_per_mail}`; the estimated dollar lines of that billing month may not exceed it.
 *
 * One IMMEDIATE transaction through the card line funnel (`replaceStatementLines`), rolled back
 * without `--apply`; inside it: the month-end valuations of months with a statement are unchanged,
 * every rebuilt statement's lines add up as before, and every line written pairs with its receipt
 * when the expense lines are rebuilt. Report-first; counts only.
 */
import fs from "node:fs";
import {
  addCalendarMonths,
  addDaysIso,
  cardLineKind,
  ddMmYyyyFromIso,
  EMPTY_CARD_STATEMENT_HEADER,
  parseDdMmYyToIso,
  type CardCanonicalLine,
  type CardCanonicalStatement,
} from "nw-tracker-contracts";
import { attributeToCard, gapBillingMonths, itemsWithLumpInBucket, monthDistance, shrinkLumpsByItems, type CardMerchantMonths, type GapMonth } from "../src/cardLinesFromReceipts.js";
import { billingMonthContainingPurchase, closeDateForBillingMonth } from "../src/cards/facturacion.js";
import { cardLineWrite, replaceStatementLines } from "../src/cards/lineWrites.js";
import { noteCardLineEvidence } from "../src/cards/lineWriteSession.js";
import { canonicalLineDedupeKeys, storedLineColumns, storedStatementFingerprint } from "../src/cards/statementStorage.js";
import { statementKeysOf } from "../src/ccInstallmentLedgerMerge.js";
import { isListingSourceKind } from "../src/ccStatementSourceKind.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount, type CcStatementRow } from "../src/ccStatementsDb.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import { creditCardMasterMetaForAccount } from "../src/ccWebPasteParse.js";
import { db } from "../src/db.js";
import { ESTIMATE_DOCUMENT_PREFIX, ESTIMATE_LINE_ID_PREFIX } from "../src/flows/flowTables279.js";
import { buildFlowsExpenseLines, listCreditCardMasterAccountIds } from "../src/flowsExpenses.js";
import { cachedFlowsExpenseLines } from "../src/flowsMortgageCarrying.js";
import { fxRowOnOrBefore } from "../src/fxRates.js";
import { APP_STORE_MERCHANT, deriveMerchantChargeLinks } from "../src/merchantExpenseNotes.js";
import {
  isOrderSummaryProcessor,
  loadPaymentProcessorReceipts,
  matchPaymentReceiptsToExpenseLines,
  pesoReceiptMayBeChargedInDollars,
  processorMerchantHint,
} from "../src/paymentProcessorReceipts.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const since = arg("since");
if (!since || !/^\d{4}-\d{2}$/.test(since)) {
  console.error("--since=YYYY-MM is required (the first month the cards may have been used)");
  process.exit(2);
}
const excluded = new Set((arg("exclude") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const anchor = arg("anchor")
  ? (JSON.parse(fs.readFileSync(arg("anchor")!, "utf8")) as { card_master_account_id: number; date: string; usd_debt_per_mail: number })
  : null;

const REBUILT_PREFIX = "import:santander-mail|";
const ESTIMATED_RECEIPTS_DOCUMENT_PREFIX = `${ESTIMATE_DOCUMENT_PREFIX}receipts|`;
const LUMP_MERCHANTS = new Set(["COMPRAS DEL PERIODO (ESTIMADO)", "COMPRAS INTERNACIONALES (ESTIMADO)"]);
const APP_STORE_LINE_MERCHANT = "APPLE.COM/BILL";

type Candidate = {
  id: string;
  source: string;
  /** The card the document itself names (an App Store receipt's plastic), when it does. */
  card_account_id?: number | null;
  day: string;
  merchant: string;
  hint: RegExp;
  amount: number;
  currency: "clp" | "usd";
  mayBeDollars: boolean;
};

/** The receipt's merchant as a statement would print it: its first word of four letters or more. */
function wordHint(name: string): RegExp {
  const word = name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Z0-9]+/)
    .find((w) => w.length >= 4);
  return new RegExp(word ? word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "(?!)", "i");
}

// --- the receipts no line pairs with ---------------------------------------------------------------
/** What became of each candidate (the attribution's counts; a few are noted while reading). */
const outcome: Record<string, number> = {};
const note = (what: string) => (outcome[what] = (outcome[what] ?? 0) + 1);
const lines = cachedFlowsExpenseLines();
const match = matchPaymentReceiptsToExpenseLines(lines);
const pairedIds = new Set([...match.byPurchaseKey.values()].map((r) => r.message_id));
const groupKey = (r: { processor: string; currency: string; order_ref: string | null }) =>
  r.order_ref ? `${r.processor}|${r.currency}|${r.order_ref}` : null;
const all = loadPaymentProcessorReceipts();
const pairedGroups = new Set(all.filter((r) => pairedIds.has(r.message_id)).map(groupKey).filter((k): k is string => k != null));
const skipped: Record<string, number> = {};
const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
const candidates: Candidate[] = [];
for (const r of all) {
  if (pairedIds.has(r.message_id)) continue;
  const gk = groupKey(r);
  if (gk && pairedGroups.has(gk)) {
    skip("part of a paired order");
    continue;
  }
  if (isOrderSummaryProcessor(r.processor)) {
    skip("order summary");
    continue;
  }
  if (r.amount == null) {
    skip("no amount");
    continue;
  }
  if (r.currency !== "clp" && r.currency !== "usd") {
    skip(`currency ${r.currency}`);
    continue;
  }
  candidates.push({
    id: r.message_id,
    source: r.processor,
    day: r.paid_at_chile.slice(0, 10),
    merchant: (r.statement_descriptor ?? r.payee).trim().toUpperCase(),
    hint: processorMerchantHint(r.processor) ?? wordHint(r.payee),
    amount: r.currency === "usd" ? Math.round(r.amount * 100) / 100 : Math.round(r.amount),
    currency: r.currency,
    mayBeDollars: pesoReceiptMayBeChargedInDollars(r.processor),
  });
}
const appLinks = deriveMerchantChargeLinks();
const appRows = db
  .prepare(
    `SELECT s.source_ref, r.issued_on, r.total_amount, r.currency, r.card_last4 FROM merchant_receipts r
     JOIN merchant_document_sources s ON s.id = r.source_id WHERE r.merchant = ? ORDER BY r.issued_on, r.id`
  )
  .all(APP_STORE_MERCHANT) as { source_ref: string; issued_on: string; total_amount: number; currency: "clp" | "usd"; card_last4: string | null }[];
for (const r of appRows) {
  if (appLinks.receipt_charges.has(r.source_ref)) continue;
  // The receipt prints the plastic it charged: a plastic the registry knows names its master (as
  // the App Store matcher reads it); one it does not know restricts nothing, as there too.
  const cardAccount = r.card_last4 ? resolveMasterAccountIdForImportCardLast4(r.card_last4) : null;
  if (r.card_last4 && cardAccount == null) note("App Store receipt on a plastic the registry does not know");
  candidates.push({
    id: r.source_ref,
    source: APP_STORE_MERCHANT,
    card_account_id: cardAccount,
    day: r.issued_on,
    merchant: APP_STORE_LINE_MERCHANT,
    hint: /APPLE\.COM/i,
    amount: r.currency === "usd" ? Math.round(r.total_amount * 100) / 100 : Math.round(r.total_amount),
    currency: r.currency,
    mayBeDollars: false,
  });
}
console.log(`Receipts: ${all.length} processor + ${appRows.length} App Store; unpaired candidates ${candidates.length}; skipped ${JSON.stringify(skipped)}.`);

// --- the cards and their gap months --------------------------------------------------------------
type Master = {
  account_id: number;
  statements: readonly CcStatementRow[];
  gaps: Map<string, GapMonth>;
  /** Every non-listing line's merchant with its statement month, for the attribution. */
  merchantMonths: { merchant: string; month: string; usd: boolean }[];
  firstStatementMonth: string | null;
};
const masters: Master[] = listCreditCardMasterAccountIds().map((account_id) => {
  // An earlier run's own estimated statements are rewritten, so they count as gaps, not statements.
  const statements = listCcStatementsForAccount(account_id).filter(
    (s) => !isListingSourceKind(s.source_kind) && !s.source_pdf.startsWith(ESTIMATED_RECEIPTS_DOCUMENT_PREFIX)
  );
  const months = statements.map((s) => s.statement_date_iso.slice(0, 7));
  const rebuilt = statements.filter((s) => s.source_pdf.startsWith(REBUILT_PREFIX)).map((s) => s.statement_date_iso.slice(0, 7));
  const gaps = new Map(gapBillingMonths(months, rebuilt, since).map((g) => [g.month, g]));
  const merchantMonths: Master["merchantMonths"] = [];
  for (const s of statements) {
    for (const l of listCcStatementLinesForStatement(s.id)) {
      if (l.merchant) merchantMonths.push({ merchant: l.merchant, month: s.statement_date_iso.slice(0, 7), usd: l.amount_usd != null && l.amount_usd !== 0 });
    }
  }
  return { account_id, statements, gaps, merchantMonths, firstStatementMonth: months.length ? [...months].sort()[0]! : null };
});
for (const m of masters) {
  const kinds: Record<string, number> = {};
  for (const g of m.gaps.values()) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1;
  console.log(`Card ${m.account_id}: ${m.statements.length} statement(s), first ${m.firstStatementMonth ?? "—"}; gap months ${JSON.stringify(kinds)}.`);
}

// --- attribution --------------------------------------------------------------------------------
type PlannedLine = Candidate & { account_id: number; billing_month: string; line_currency: "clp" | "usd"; line_amount: number; origin_clp: number | null };
const planned: PlannedLine[] = [];
const ambiguous: string[] = [];
for (const c of candidates) {
  if (excluded.has(c.id)) {
    note("excluded by the flag");
    continue;
  }
  if (c.day.slice(0, 7) < since) {
    note("before since");
    continue;
  }
  // Every card that ever carried the merchant competes, whether or not it has a gap: a receipt
  // whose nearest card has a statement for its month is a purchase that statement does not show —
  // paid by other means, or simply unmatched — never a line on a card created years later.
  const fitting: { master: Master; billing_month: string; cm: CardMerchantMonths; usdShare: number }[] = [];
  for (const m of masters) {
    if (m.statements.length === 0) continue;
    if (c.card_account_id != null && m.account_id !== c.card_account_id) continue;
    const hits = m.merchantMonths.filter((x) => c.hint.test(x.merchant));
    if (hits.length === 0) continue;
    // Which currency the card charged this merchant in is a question about the era: the lines of
    // the nearest statement months (within three months of the nearest), not the card's whole history.
    const receiptMonth = c.day.slice(0, 7);
    const nearest = Math.min(...hits.map((h) => Math.abs(monthDistance(receiptMonth, h.month))));
    const near = hits.filter((h) => Math.abs(monthDistance(receiptMonth, h.month)) <= nearest + 3);
    fitting.push({
      master: m,
      billing_month: billingMonthContainingPurchase(m.account_id, c.day, m.statements),
      cm: { account_id: m.account_id, merchant_months: hits.map((h) => h.month) },
      usdShare: near.filter((h) => h.usd).length / near.length,
    });
  }
  const a = attributeToCard(c.day.slice(0, 7), fitting.map((f) => f.cm));
  if (a.kind === "none") {
    note("merchant on no card");
    continue;
  }
  if (a.kind === "ambiguous") {
    note("ambiguous card");
    ambiguous.push(`${c.day} ${c.source}: cards ${a.account_ids.join(", ")}`);
    continue;
  }
  const f = fitting.find((x) => x.master.account_id === a.account_id)!;
  if (!f.master.gaps.has(f.billing_month)) {
    note(`nearest card has a statement for the month (card ${a.account_id})`);
    continue;
  }
  let line_currency: "clp" | "usd" = c.currency;
  let line_amount = c.amount;
  let origin_clp: number | null = null;
  if (c.currency === "clp" && c.mayBeDollars && f.usdShare > 0.5) {
    const fx = fxRowOnOrBefore(c.day);
    if (!fx) throw new Error(`${c.day}: no USD/CLP rate on or before it`);
    line_currency = "usd";
    line_amount = Math.round((c.amount / fx.clp_per_usd) * 100) / 100;
    origin_clp = c.amount;
  }
  if (!(line_amount > 0)) {
    note("below the currency's smallest coin after conversion");
    continue;
  }
  planned.push({ ...c, account_id: a.account_id, billing_month: f.billing_month, line_currency, line_amount, origin_clp });
  note(`written to card ${a.account_id}`);
}
console.log(`Attribution: ${JSON.stringify(outcome)}.`);
for (const x of ambiguous) console.log(`  ambiguous: ${x}`);

// --- the statements to write ---------------------------------------------------------------------
function estimateLine(p: PlannedLine): CardCanonicalLine {
  return {
    kind: cardLineKind({
      installment_flag: false,
      merchant: p.merchant,
      amount_clp: p.line_currency === "clp" ? p.line_amount : 0,
      amount_usd: p.line_currency === "usd" ? p.line_amount : null,
      statement_currency: p.line_currency,
    }),
    transaction_date: p.day,
    posting_date: null,
    printed_transaction_date: null,
    printed_posting_date: null,
    merchant: p.merchant,
    description: null,
    place: null,
    country: null,
    currency: p.line_currency,
    amount: p.line_amount,
    origin_amount: p.origin_clp,
    installment: null,
    origin_card_last4: null,
    cuota_purchase: null,
    document: {
      line_id: `${ESTIMATE_LINE_ID_PREFIX}${p.id}`,
      dedupe_key: `${ESTIMATE_LINE_ID_PREFIX}${p.id}`,
      section: "estimate",
      raw_text: `estimado: recibo ${p.source} ${p.id}`,
      duplicate_across_statements: false,
      baseline_match: null,
    },
  };
}

type Written = { account_id: number; statement: CardCanonicalStatement; receipts: PlannedLine[] };
/** A rebuilt month: its statement row, the lumps' new amounts and the receipt lines to add. */
type Itemized = {
  account_id: number;
  statement: CcStatementRow;
  currency: "clp" | "usd";
  lumps: { line_id: number; date: string; amount: number }[];
  receipts: PlannedLine[];
  before_sum: number;
};
const toWrite: Written[] = [];
const toItemize: Itemized[] = [];
const byKey = new Map<string, PlannedLine[]>();
for (const p of planned) {
  const k = `${p.account_id}|${p.billing_month}|${p.line_currency}`;
  byKey.set(k, [...(byKey.get(k) ?? []), p]);
}
const rebuiltNoLump: string[] = [];
const strandedInRebuilt: string[] = [];
for (const [k, items] of byKey) {
  const [acct, bm, currency] = k.split("|") as [string, string, "clp" | "usd"];
  const accountId = Number(acct);
  const master = masters.find((m) => m.account_id === accountId)!;
  const gap = master.gaps.get(bm)!;
  const meta = creditCardMasterMetaForAccount(accountId);
  if (gap.kind === "rebuilt") {
    // The mail-rebuilt statements were written raw and never satisfied the import gate (their
    // header carries the mailed facturado, not a printed identity), so they are not re-stated
    // through it: the lumps shrink and the lines land inside one framed card-line write below.
    const existing = master.statements.find((s) => s.statement_date_iso.slice(0, 7) === bm && s.source_pdf.startsWith(REBUILT_PREFIX) && s.currency === currency);
    if (!existing) {
      rebuiltNoLump.push(`${accountId} ${bm} ${currency}`);
      continue;
    }
    const stored = listCcStatementLinesForStatement(existing.id);
    const amountOf = (l: (typeof stored)[number]) => (currency === "usd" ? l.amount_usd ?? 0 : l.amount_clp ?? 0);
    const lumpRows = stored.filter((l) => l.merchant && LUMP_MERCHANTS.has(l.merchant));
    if (lumpRows.length === 0) {
      rebuiltNoLump.push(`${accountId} ${bm} ${currency}`);
      continue;
    }
    const dated = lumpRows.map((l) => ({ line_id: l.id, date: parseDdMmYyToIso(l.transaction_date ?? "") ?? "", amount: amountOf(l) }));
    // An item shrinks a lump of its own month and on the same side of the previous close: the
    // month-end anchors beside the rebuilt statement count the post-close lines by date, so a receipt
    // re-dated across either boundary would move one. A receipt with no such lump is left out.
    const previousClose = closeDateForBillingMonth(accountId, addCalendarMonths(bm, -1)).close_iso;
    const bucketOf = (d: string) => `${d.slice(0, 7)}|${d <= previousClose ? "on_or_before_close" : "after_close"}`;
    const split = itemsWithLumpInBucket(dated, items.map((p) => ({ date: p.day, item: p })), bucketOf);
    const itemizable = split.itemizable.map((x) => x.item);
    const stranded = split.stranded.map((x) => x.item);
    for (const p of stranded) {
      note("rebuilt month: no lump on the receipt's side of the close and month-end");
      strandedInRebuilt.push(`${p.day} ${p.source} (card ${accountId}, ${bm} ${currency})`);
    }
    if (itemizable.length === 0) continue;
    const shrunk = shrinkLumpsByItems(dated, itemizable.map((p) => ({ date: p.day, amount: p.line_amount })), bucketOf);
    const lumps = dated.map((l) => ({ ...l, amount: shrunk.find((x) => x.date === l.date)!.amount }));
    toItemize.push({ account_id: accountId, statement: existing, currency, lumps, receipts: itemizable, before_sum: stored.reduce((s, l) => s + amountOf(l), 0) });
  } else {
    // The month's cycle as the card closes it: from the day after the previous close to this one.
    const close = closeDateForBillingMonth(accountId, bm);
    const previousClose = closeDateForBillingMonth(accountId, addCalendarMonths(bm, -1));
    toWrite.push({
      account_id: accountId,
      statement: {
        // One document per currency: the ledger keys a statement on document + close.
        document: `${ESTIMATED_RECEIPTS_DOCUMENT_PREFIX}${currency}|${bm}`,
        card_group: meta.cardGroup,
        close: close.close_ddmmyyyy,
        period_from: ddMmYyyyFromIso(addDaysIso(previousClose.close_iso, 1)),
        period_to: close.close_ddmmyyyy,
        pay_by: null,
        card_last4: meta.cardLast4,
        card_product: null,
        currency,
        layout: "compact",
        header: EMPTY_CARD_STATEMENT_HEADER,
        lines: items.map(estimateLine),
      },
      receipts: items,
    });
  }
}
for (const x of rebuiltNoLump) console.log(`  rebuilt month without a lump to itemize (nothing written): ${x}`);
for (const x of strandedInRebuilt) console.log(`  rebuilt month, no lump beside the receipt (nothing written): ${x}`);
console.log(
  `Statements: ${toWrite.length} written, earlier estimates of the same months replaced (${toWrite.reduce((s, w) => s + w.receipts.length, 0)} line(s)); ${toItemize.length} rebuilt statement(s) itemized (${toItemize.reduce((s, w) => s + w.receipts.length, 0)} line(s)).`
);

/** The statement's fingerprint from its stored rows (the 292 rule), after its lines changed. */
function refreshStoredFingerprint(statementId: number): void {
  const statement = db
    .prepare(
      `SELECT card_group, period_from, period_to, pay_by, card_last4, card_product, layout, currency,
              saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado, monto_pagado_anterior,
              monto_pagado_anterior_date, next_period_from, next_period_to FROM cc_statements WHERE id = ?`
    )
    .get(statementId) as Record<string, unknown>;
  const lines = db
    .prepare(
      `SELECT transaction_date, posting_date, place, merchant, description_merged, country, amount_orig,
              amount_clp, amount_usd, installment_flag, nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp,
              interest_rate_text, tipo_cuota, parser_row_id, raw_line, origin_card_last4
       FROM cc_statement_lines WHERE statement_id = ?`
    )
    .all(statementId) as Record<string, unknown>[];
  db.prepare(`UPDATE cc_statements SET import_fingerprint = ? WHERE id = ?`).run(
    storedStatementFingerprint(statement as Parameters<typeof storedStatementFingerprint>[0], lines as Parameters<typeof storedStatementFingerprint>[1]),
    statementId
  );
}

function itemizeRebuilt(w: Itemized): void {
  const shell: CardCanonicalStatement = {
    document: w.statement.source_pdf,
    card_group: w.statement.card_group,
    close: w.statement.statement_date,
    period_from: w.statement.period_from,
    period_to: w.statement.period_to,
    pay_by: w.statement.pay_by,
    card_last4: w.statement.card_last4,
    card_product: w.statement.card_product,
    currency: w.currency,
    layout: "compact",
    header: EMPTY_CARD_STATEMENT_HEADER,
    lines: [],
  };
  const upd = db.prepare(`UPDATE cc_statement_lines SET amount = ? WHERE id = ? AND currency = '${w.currency}'`);
  for (const lump of w.lumps) {
    upd.run(lump.amount, lump.line_id);
    noteCardLineEvidence(w.account_id, lump.date);
  }
  const ins = db.prepare(
    `INSERT INTO cc_statement_lines (
       statement_id, transaction_date, posting_date, place, merchant, description_merged, country, amount_orig,
       amount, currency, installment_flag, nro_cuota_current, nro_cuota_total, cuota_amount,
       interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line, origin_card_last4, kind
     ) VALUES (
       @statement_id, @transaction_date, @posting_date, @place, @merchant, @description_merged, @country, @amount_orig,
       @amount, @currency, @installment_flag, @nro_cuota_current, @nro_cuota_total, @cuota_amount,
       @interest_rate_text, @tipo_cuota, @dedupe_key, @parser_row_id, @raw_line, @origin_card_last4, @kind
     )`
  );
  for (const p of w.receipts) {
    const line = estimateLine(p);
    const keys = canonicalLineDedupeKeys(w.statement.card_group, line);
    ins.run({ statement_id: w.statement.id, ...storedLineColumns(shell, line), dedupe_key: keys[keys.length - 1] ?? null, kind: line.kind });
    noteCardLineEvidence(w.account_id, p.day);
  }
  refreshStoredFingerprint(w.statement.id);
}

// --- write and check ------------------------------------------------------------------------------
/** The card's month-end anchors from its first statement month on (the daily stamps are the write's to re-sync). */
const valuationsSnapshot = (accountId: number, fromMonth: string | null) =>
  JSON.stringify(
    db
      .prepare(
        `SELECT as_of_date, value FROM valuations
         WHERE account_id = ? AND as_of_date >= ? AND as_of_date = date(as_of_date, 'start of month', '+1 month', '-1 day')
         ORDER BY as_of_date`
      )
      .all(accountId, fromMonth ? `${fromMonth}-01` : "0000")
  );
const before = new Map(masters.map((m) => [m.account_id, valuationsSnapshot(m.account_id, m.firstStatementMonth)]));
class RollBack extends Error {}
const run = db.transaction(() => {
  for (const accountId of new Set([...toWrite, ...toItemize].map((w) => w.account_id))) {
    const statements = toWrite.filter((w) => w.account_id === accountId).map((w) => w.statement);
    if (statements.length > 0) replaceStatementLines(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
    const itemized = toItemize.filter((w) => w.account_id === accountId);
    if (itemized.length > 0) {
      cardLineWrite(accountId, "receipt lines itemized into rebuilt statements", () => {
        for (const w of itemized) itemizeRebuilt(w);
      });
    }
  }
  // 1. Rebuilt statements add up as before.
  for (const w of toItemize) {
    const sum = listCcStatementLinesForStatement(w.statement.id).reduce((s, l) => s + (w.currency === "usd" ? l.amount_usd ?? 0 : l.amount_clp ?? 0), 0);
    if (Math.abs(sum - w.before_sum) > 0.005) throw new Error(`rebuilt statement ${w.statement.source_pdf}: lines add up to ${sum}, before ${w.before_sum}`);
  }
  // 2. The month-end anchors of every month with a statement are unchanged (an item shrinks a lump
  // of its own month on the same side of the close, so no pesos cross a month-end or a close).
  for (const m of masters) {
    const prev = JSON.parse(before.get(m.account_id)!) as { as_of_date: string; value: number }[];
    const now = JSON.parse(valuationsSnapshot(m.account_id, m.firstStatementMonth)) as { as_of_date: string; value: number }[];
    const prevBy = new Map(prev.map((r) => [r.as_of_date, r.value]));
    const moved = now.filter((r) => prevBy.get(r.as_of_date) !== r.value).map((r) => r.as_of_date);
    const gone = prev.filter((r) => !now.some((x) => x.as_of_date === r.as_of_date)).map((r) => r.as_of_date);
    const outside = [...moved, ...gone];
    if (outside.length > 0) throw new Error(`card ${m.account_id}: month-end anchor(s) of months with a statement moved: ${outside.join(", ")}`);
  }
  // 3. The mailed-balance anchor.
  if (anchor) {
    const month = anchor.date.slice(0, 7);
    const usd = [...toWrite, ...toItemize]
      .filter((w) => w.account_id === anchor.card_master_account_id && w.receipts[0]?.line_currency === "usd" && w.receipts[0]?.billing_month === month)
      .reduce((s, w) => s + w.receipts.reduce((t, p) => t + p.line_amount, 0), 0);
    console.log(`Anchor ${anchor.date}: estimated dollar lines of the month ${usd.toFixed(2)} against the mailed debt ${anchor.usd_debt_per_mail}.`);
    if (usd > anchor.usd_debt_per_mail + 0.005) throw new Error(`the estimated dollar lines of ${month} exceed the mailed balance`);
  }
  // 4. Every line written pairs with its receipt.
  const rebuilt = buildFlowsExpenseLines(listCreditCardMasterAccountIds());
  const after = matchPaymentReceiptsToExpenseLines(rebuilt);
  const appAfter = deriveMerchantChargeLinks();
  let paired = 0;
  const unpaired: string[] = [];
  for (const w of [...toWrite, ...toItemize]) {
    for (const p of w.receipts) {
      const line = rebuilt.find((l) => l.source === "cc" && l.account_id === w.account_id && l.purchase_key.includes(`${ESTIMATE_LINE_ID_PREFIX}${p.id}`));
      if (!line) throw new Error(`the line of receipt ${p.id} is not among the expense lines`);
      // Two identical receipts of one day pair with the two identical lines in order: a swap is a pair.
      const sameDocument = (r: { message_id: string; paid_at_chile: string; processor: string; amount: number | null }) =>
        r.message_id === p.id || (r.processor === p.source && r.paid_at_chile.slice(0, 10) === p.day && r.amount != null && Math.abs(r.amount - (p.origin_clp ?? p.amount)) < 0.005);
      const got = after.byPurchaseKey.get(line.purchase_key);
      const ok =
        p.source === APP_STORE_MERCHANT
          ? appAfter.links.some((k) => k.account_id === w.account_id && k.key === line.purchase_key) && appAfter.receipt_charges.has(p.id)
          : got != null && sameDocument(got);
      if (ok) paired += 1;
      else unpaired.push(`${p.day} ${p.source} (${p.id})`);
    }
  }
  console.log(`Pairing after the write: ${paired} line(s) pair with their receipt, ${unpaired.length} do not.`);
  for (const u of unpaired.slice(0, 20)) console.log(`  not paired: ${u}`);
  if (unpaired.length > 0) throw new Error("a written line does not pair with its receipt");
  if (!apply) throw new RollBack();
});
try {
  run.immediate();
  console.log(`\nApplied.`);
} catch (e) {
  if (e instanceof RollBack) console.log(`\nReport only — nothing written. Re-run with --apply.`);
  else {
    console.error(`\nFAILED (nothing written): ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
