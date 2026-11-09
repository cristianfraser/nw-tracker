/**
 * The facturación module (docs/untangle-plan.md F10): which month a card's money belongs to and
 * when that month closes. One place for the cycle rules:
 *
 * - closes, from the bank's own evidence ({@link closeEvidenceForBillingMonth}: statement → feed
 *   SALDO INICIAL → announced next period → estimate), and the cycle bounds they give
 *   ({@link nextPeriodStartIsoForBillingMonth});
 * - the month's state: closed by a statement ({@link pdfClosedBillingMonthsForAccount}),
 *   provisionally closed ({@link provisionallyClosedBillingMonthsForAccount}), open
 *   ({@link targetBillingMonthForManualImports}), projected beyond;
 * - purchase → month ({@link billingMonthContainingPurchase}), statement → month
 *   (`cards/statementMonth.ts`), the config cycle as bucket identity
 *   ({@link statementCloseDdMmYyyyForBillingMonth}).
 *
 * Pay-by derivation is `ccInstallmentPayBy.ts` (`derivedPayByIso`, by the issuer's rule) and
 * first-cuota timing `ccCuotaPurchaseKinds.ts` (by the issuer's data) — both data-driven.
 * The feed-close writer and the statement cross-check stay in `ccBillingCloses.ts`.
 */
import { ccIssuerSlugForMasterAccount } from "../ccIssuerForAccount.js";
import { ccIssuerBySlug } from "../ccIssuers.js";
import { db } from "../db.js";
import { isStatementSourceKind } from "../ccStatementSourceKind.js";
import { DEFAULT_BILLING_CYCLE_END_DAY, loadCreditCardBillingConfig, type CreditCardBillingConfig } from "./config.js";
import { billingMonthForStatementDate } from "./statementMonth.js";
import { ymCompare } from "../calendarMonth.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { listCcStatementsForAccount, type CcStatementRow } from "../ccStatementsDb.js";
import { addCalendarMonths, ddMmYyyyFromIso, parseDdMmYyToIso } from "nw-tracker-contracts";

// ---------------------------------------------------------------------------------------------
// Closes
// ---------------------------------------------------------------------------------------------

/*
 * When a credit-card facturación closes, from the best evidence the bank has given us.
 *
 * Until 2026-09 a close was known only once its statement PDF (or statement JSON) was imported;
 * before that the open month used the card config's tentative 21-to-20 cycle, off by two to six
 * days on every Santander month. The bank publishes the real close well ahead of the statement,
 * in two places this module reads (migration 185):
 *
 *  - **Announced.** Every current statement prints the following cycle — Santander «PRÓXIMO
 *    PERÍODO DE FACTURACIÓN 25/08/2026 24/09/2026» since June 2026, BCI Lider «Próximo Período
 *    de Facturación 27/08/2026 26/09/2026», and the Santander statement JSON as FechaProxFact —
 *    stored as `cc_statements.next_period_from` / `next_period_to`.
 *  - **Observed.** The Santander unbilled-movements feed always opens with a SALDO INICIAL row
 *    dated at the latest close and valued at that facturación's «Monto total facturado» (one per
 *    currency). The feed importer records it in `cc_feed_billing_closes` the morning after the
 *    close, days before the statement e-mail — which lets the month close provisionally.
 *
 * Precedence for a billing month's close: its imported statement, then the feed observation,
 * then the announcement, then an estimate — the day of the account's latest known close carried
 * into the month (the config cycle only for a card with no close on record). Only the estimate is
 * a guess, and callers that decide a month has closed refuse to act on it.
 *
 * Leaf module: no billing-view imports.
 */
export type CcCloseSource = "statement" | "feed" | "announced" | "estimated";

export type CcCloseEvidence = {
  /** ISO close date — the statement date the bank prints for this facturación. */
  close_iso: string;
  source: CcCloseSource;
};

export type CcFeedBillingClose = {
  account_id: number;
  billing_month: string;
  close_date: string;
  saldo_inicial_clp: number | null;
  saldo_inicial_usd: number | null;
  first_seen_at: string;
  last_seen_at: string;
  source_file: string | null;
};

function isoFromField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

function addDaysIso(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`addDaysIso: bad date "${iso}"`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}


// ---------------------------------------------------------------------------------------------
// Observed closes (feed SALDO INICIAL)
// ---------------------------------------------------------------------------------------------

const selectFeedClose = db.prepare(
  `SELECT account_id, billing_month, close_date, saldo_inicial_clp, saldo_inicial_usd,
          first_seen_at, last_seen_at, source_file
   FROM cc_feed_billing_closes WHERE account_id = ? AND billing_month = ?`
);

const selectLatestFeedClose = db.prepare(
  `SELECT account_id, billing_month, close_date, saldo_inicial_clp, saldo_inicial_usd,
          first_seen_at, last_seen_at, source_file
   FROM cc_feed_billing_closes WHERE account_id = ?
   ORDER BY close_date DESC LIMIT 1`
);

export function feedBillingCloseForMonth(
  accountId: number,
  billingMonth: string
): CcFeedBillingClose | null {
  return (selectFeedClose.get(accountId, billingMonth) as CcFeedBillingClose | undefined) ?? null;
}

export function latestFeedBillingClose(accountId: number): CcFeedBillingClose | null {
  return (selectLatestFeedClose.get(accountId) as CcFeedBillingClose | undefined) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Announced closes (statement «próximo período»)
// ---------------------------------------------------------------------------------------------

/**
 * The close the account's statements announced for `billingMonth` (the month of the printed
 * next-period end). Two statements announcing different closes for the same month is a
 * contradiction and throws; the CLP and USD twins of one facturación announce the same one.
 */
function announcedCloseIsoForBillingMonth(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): string | null {
  let found: { iso: string; from: string } | null = null;
  for (const st of statements) {
    if (!isStatementSourceKind(st.source_kind)) continue;
    const iso = isoFromField(st.next_period_to);
    if (!iso || iso.slice(0, 7) !== billingMonth) continue;
    if (found && found.iso !== iso) {
      throw new Error(
        `Account ${accountId}: statements announce two closes for ${billingMonth} ` +
          `(${found.iso} per ${found.from}, ${iso} per ${st.source_pdf})`
      );
    }
    found = { iso, from: st.source_pdf };
  }
  return found?.iso ?? null;
}

/**
 * Days between a statement's own period end and the first day of the cycle it announces — the
 * issuer's close-day rule. Santander prints the next cycle starting ON the close day (a purchase
 * dated the close day bills next month: 24/09/2026 rows sat in «por facturar» the day after the
 * September close), BCI starts it the day after. Read from the latest statement that prints
 * both; null when none does.
 */
export function closeDayOffsetDays(
  accountId: number,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): number | null {
  let latest: { close: string; offset: number } | null = null;
  for (const st of statements) {
    if (!isStatementSourceKind(st.source_kind)) continue;
    const periodTo = isoFromField(st.period_to);
    const nextFrom = isoFromField(st.next_period_from);
    if (!periodTo || !nextFrom) continue;
    if (!latest || periodTo > latest.close) {
      latest = { close: periodTo, offset: daysBetweenIso(periodTo, nextFrom) };
    }
  }
  return latest?.offset ?? null;
}

// ---------------------------------------------------------------------------------------------
// Close evidence per billing month
// ---------------------------------------------------------------------------------------------

/** A statement's own close: its printed period end, else its statement date. */
export function statementOwnCloseIso(st: CcStatementRow): string | null {
  return isoFromField(st.period_to) ?? isoFromField(st.statement_date);
}

function realStatementCloseIso(
  statements: readonly CcStatementRow[],
  billingMonth: string
): string | null {
  for (const st of statements) {
    if (st.billing_month !== billingMonth || !isStatementSourceKind(st.source_kind)) continue;
    const iso = statementOwnCloseIso(st);
    if (iso) return iso;
  }
  return null;
}

/**
 * The latest close the bank has put on record for this account: an imported statement's own close
 * (either currency), the feed-observed close, or an announced one — every announcement, or only
 * those on or before `announcedThrough` (a future announcement is a date, not yet a close).
 */
export function latestKnownCloseIso(
  accountId: number,
  statements: readonly CcStatementRow[],
  announcedThrough?: string
): string | null {
  let latest = latestFeedBillingClose(accountId)?.close_date ?? null;
  for (const st of statements) {
    if (!isStatementSourceKind(st.source_kind)) continue;
    const announced = isoFromField(st.next_period_to);
    const counted = announced != null && (announcedThrough == null || announced <= announcedThrough);
    for (const iso of [statementOwnCloseIso(st), counted ? announced : null]) {
      if (iso && (latest == null || iso > latest)) latest = iso;
    }
  }
  return latest;
}

/**
 * A month the bank has published nothing for yet: the day of the account's latest known close —
 * a statement's, the feed-observed one or the latest announcement — carried into that month
 * (clamped to its length). Issuers keep a rhythm (BCI Lider the 26th, Santander 23–25) that the
 * config cycle cannot stand in for: the config close keys the open buckets
 * (`statementCloseDdMmYyyyForBillingMonth`) and must stay off the real close days, so it only
 * estimates for a card with no close on record at all.
 */
function estimatedCloseIso(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[]
): string {
  const latest = latestKnownCloseIso(accountId, statements);
  if (latest == null) {
    const range = billingPeriodIsoRange(billingMonth, loadCreditCardBillingConfig(accountId));
    return range?.period_to ?? `${billingMonth}-20`;
  }
  const [y, m] = billingMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const day = Math.min(Number(latest.slice(8, 10)), lastDay);
  return `${billingMonth}-${String(day).padStart(2, "0")}`;
}

/** Best-known close of `billingMonth`: statement → feed observation → announcement → estimate. */
export function closeEvidenceForBillingMonth(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): CcCloseEvidence {
  const fromStatement = realStatementCloseIso(statements, billingMonth);
  if (fromStatement) return { close_iso: fromStatement, source: "statement" };
  const observed = feedBillingCloseForMonth(accountId, billingMonth);
  if (observed) return { close_iso: observed.close_date, source: "feed" };
  const announced = announcedCloseIsoForBillingMonth(accountId, billingMonth, statements);
  if (announced) return { close_iso: announced, source: "announced" };
  return { close_iso: estimatedCloseIso(accountId, billingMonth, statements), source: "estimated" };
}

/**
 * First purchase date that belongs to the facturación AFTER `billingMonth`: the statement's
 * printed next-period start when it has one, else the known close shifted by the issuer's
 * close-day offset — the latest statement that prints it, else the issuer's rule
 * (`CC_ISSUERS[…].close_day_offset_days`). With only an estimated close this is the day after it.
 */
export function nextPeriodStartIsoForBillingMonth(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): { iso: string; source: CcCloseSource } {
  for (const st of statements) {
    if (st.billing_month !== billingMonth || !isStatementSourceKind(st.source_kind)) continue;
    const printed = isoFromField(st.next_period_from);
    if (printed) return { iso: printed, source: "statement" };
  }
  const close = closeEvidenceForBillingMonth(accountId, billingMonth, statements);
  if (close.source === "estimated") return { iso: addDaysIso(close.close_iso, 1), source: "estimated" };
  const offset =
    closeDayOffsetDays(accountId, statements) ??
    ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.close_day_offset_days;
  return { iso: addDaysIso(close.close_iso, offset), source: close.source };
}

// ---------------------------------------------------------------------------------------------
// The config cycle
// ---------------------------------------------------------------------------------------------

/**
 * Inclusive billing period [from, to] ISO dates for a billing month YYYY-MM, by the config cycle —
 * tentative. It keys the open web-paste buckets (`statementCloseDdMmYyyyForBillingMonth`) and
 * estimates the close of a card with no close on record (`closeEvidenceForBillingMonth`); which
 * facturación a purchase belongs to is `billingMonthContainingPurchase`, from the bank's closes.
 */
export function billingPeriodIsoRange(
  billingMonth: string,
  config: CreditCardBillingConfig
): { period_from: string; period_to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  const startDay = config.billing_cycle_start_day;
  const endDay = config.billing_cycle_end_day ?? DEFAULT_BILLING_CYCLE_END_DAY;
  const prevMo = mo === 1 ? 12 : mo - 1;
  const prevY = mo === 1 ? y - 1 : y;
  const pad = (n: number) => String(n).padStart(2, "0");
  const period_from = `${prevY}-${pad(prevMo)}-${pad(Math.min(startDay, 28))}`;
  const period_to = `${y}-${pad(mo)}-${pad(Math.min(endDay, 28))}`;
  return { period_from, period_to };
}

// ---------------------------------------------------------------------------------------------
// Months: closed, provisional, open; purchase → month
// ---------------------------------------------------------------------------------------------

/**
 * True when this account's imported PDF history carries a USD statement stream — closing a
 * facturación then waits for the USD twin too, until the bank closes a later facturación
 * ({@link pdfClosedBillingMonthsForAccount}). The requirement follows the imported stream,
 * not the card's nominal facilities: a card with a dormant, never-billed USD side keeps
 * closing on CLP alone until its first USD statement lands.
 */
export function accountRequiresUsdStatementClose(accountId: number): boolean {
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.currency === "usd" && isStatementSourceKind(st.source_kind)) return true;
  }
  return false;
}

/**
 * Latest facturación month (YYYY-MM) an imported statement closed on this master account (the
 * currency rule of {@link pdfClosedBillingMonthsForAccount}: one twin arriving alone must not
 * advance the open month).
 */
export function lastPdfBillingMonthForAccount(accountId: number): string | null {
  let max: string | null = null;
  for (const bm of pdfClosedBillingMonthsForAccount(accountId)) {
    if (!max || ymCompare(bm, max) > 0) max = bm;
  }
  return max;
}

/**
 * Every facturación month an imported statement closed. CLP always; the USD twin too when the
 * account carries a USD stream ({@link accountRequiresUsdStatementClose}) — the two are mailed the
 * same day, and one arriving alone must not close the month. But a twin still missing once the
 * bank has closed a LATER facturación (a later statement in either currency, a feed-observed close,
 * or an announced close that has passed) is not coming: that cycle billed nothing in dollars, and
 * the month closes on CLP alone. Without it every USD-quiet cycle stayed «open» for good — the
 * retired ·0161's CLP-only 2025 months, which flagged those months open on the group pages too.
 */
export function pdfClosedBillingMonthsForAccount(accountId: number): Set<string> {
  const statements = listCcStatementsForAccount(accountId);
  const requiresUsd = accountRequiresUsdStatementClose(accountId);
  const latestBankClose = requiresUsd
    ? latestKnownCloseIso(accountId, statements, chileCalendarTodayYmd())
    : null;
  const byMonth = new Map<string, { currencies: Set<string>; clpCloseIso: string | null }>();
  for (const st of statements) {
    if (!isStatementSourceKind(st.source_kind)) continue;
    const bm = st.billing_month;
    if (!bm) continue;
    let month = byMonth.get(bm);
    if (!month) byMonth.set(bm, (month = { currencies: new Set(), clpCloseIso: null }));
    month.currencies.add(st.currency);
    if (st.currency !== "usd") month.clpCloseIso = statementOwnCloseIso(st);
  }
  const closed = new Set<string>();
  for (const [bm, { currencies, clpCloseIso }] of byMonth) {
    if (!currencies.has("clp")) continue;
    const twinPending =
      requiresUsd &&
      !currencies.has("usd") &&
      !(clpCloseIso != null && latestBankClose != null && latestBankClose > clpCloseIso);
    if (twinPending) continue;
    closed.add(bm);
  }
  return closed;
}

/**
 * Latest facturación the BANK has closed: the latest statement-closed month, a later month whose
 * close the card feed observed (SALDO INICIAL — see `ccBillingCloses.ts`), or a later month whose
 * statement-announced next cycle has already started (today on/after its first day). This is what
 * moves the open month forward. It is deliberately not what the installment schedule treats as
 * negative evidence (`lastPdfBillingMonthForAccount`): a close without its statement says nothing
 * about which cuotas it billed.
 */
export function lastClosedBillingMonthForAccount(
  accountId: number,
  todayIso: string = chileCalendarTodayYmd()
): string | null {
  const lastPdf = lastPdfBillingMonthForAccount(accountId);
  const observed = latestFeedBillingClose(accountId)?.billing_month ?? null;
  let last =
    observed && (!lastPdf || ymCompare(observed, lastPdf) > 0) ? observed : lastPdf;
  if (!last) return null;
  // Walk forward through closes the bank announced and whose next cycle is already running.
  // Bounded: an announcement only ever reaches the month after the latest statement.
  const statements = listCcStatementsForAccount(accountId);
  for (let i = 0; i < 3; i++) {
    const candidate = addCalendarMonths(last, 1);
    const next = nextPeriodStartIsoForBillingMonth(accountId, candidate, statements);
    if (next.source === "estimated" || todayIso < next.iso) break;
    last = candidate;
  }
  return last;
}

/**
 * A facturación the bank has closed but whose statement is not imported yet — closed by the
 * feed's SALDO INICIAL (billed total known) or by its announced close passing (total still the
 * app's estimate). Line detail is pending either way; the statement supersedes it.
 */
export function isProvisionallyClosedBillingMonth(accountId: number, billingMonth: string): boolean {
  return provisionallyClosedBillingMonthsForAccount(accountId).has(billingMonth);
}

/** Every provisionally closed month: after the latest statement close, up to the bank's latest. */
export function provisionallyClosedBillingMonthsForAccount(accountId: number): Set<string> {
  const out = new Set<string>();
  const lastClosed = lastClosedBillingMonthForAccount(accountId);
  if (!lastClosed) return out;
  const lastPdf = lastPdfBillingMonthForAccount(accountId);
  let bm = lastPdf ? addCalendarMonths(lastPdf, 1) : lastClosed;
  while (ymCompare(bm, lastClosed) <= 0) {
    out.add(bm);
    bm = addCalendarMonths(bm, 1);
  }
  return out;
}

/**
 * Facturación month whose cycle contains a purchase dated `purchaseIso`. A cycle runs from the
 * first day after the previous facturación's close up to (not including) the first day after its
 * own — `nextPeriodStartIsoForBillingMonth`, so statement, feed and announced closes and the
 * issuer's close-day rule all apply (a Santander purchase ON the close day belongs to the next
 * cycle). A month whose close is only estimated ends the day after that estimate.
 *
 * The one rule for which facturación a purchase belongs to: the manual first-cuota guess, the
 * first cuota of a plan made from a feed-typed purchase, the web-paste first-due nudge, the
 * purchase tables' `purchase_billing_month`, the ledger facturado projection and the mortgage UF
 * reminder all read it. The config cycle (21→20) only stands in, through the close estimate, for
 * a card with no close on record. It used to decide on its own for half of those callers, which
 * put a purchase dated between the 20th and the real close (the 24th on ·0901, the 26th on ·0101)
 * a month late. A caller resolving many purchases passes the account's `statements` once.
 */
export function billingMonthContainingPurchase(
  accountId: number,
  purchaseIso: string,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseIso)) {
    throw new Error(`billingMonthContainingPurchase: bad date "${purchaseIso}"`);
  }
  let bm = purchaseIso.slice(0, 7);
  for (let i = 0; i < 4; i++) {
    const cycleStart = nextPeriodStartIsoForBillingMonth(accountId, addCalendarMonths(bm, -1), statements).iso;
    if (purchaseIso < cycleStart) {
      bm = addCalendarMonths(bm, -1);
      continue;
    }
    const nextCycleStart = nextPeriodStartIsoForBillingMonth(accountId, bm, statements).iso;
    if (purchaseIso >= nextCycleStart) {
      bm = addCalendarMonths(bm, 1);
      continue;
    }
    return bm;
  }
  throw new Error(`Account ${accountId}: no billing cycle contains ${purchaseIso} (close evidence overlaps)`);
}

/**
 * Billing month for manual imports (web paste): current open period = month after the last
 * facturación the bank closed (statement or feed-observed), or the current calendar billing
 * month when already past that.
 */
export function targetBillingMonthForManualImports(
  accountId: number,
  cardLast4: string
): string {
  const todayIso = chileCalendarTodayYmd();
  const currentBm =
    billingMonthForStatementDate(todayIso) ??
    todayIso.slice(0, 7);
  const lastClosed = lastClosedBillingMonthForAccount(accountId);
  if (!lastClosed) return currentBm;
  const nextAfterClosed = addCalendarMonths(lastClosed, 1);
  return ymCompare(currentBm, nextAfterClosed) >= 0 ? currentBm : nextAfterClosed;
}

/** Card last4 for a credit-card master account (`credit_card_account_config.card_last4` —
 * the card identity; a master without a config row is a data problem). */
export function cardLast4ForCreditCardAccount(accountId: number): string | null {
  const row = db
    .prepare(`SELECT card_last4 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { card_last4: string | null } | undefined;
  const fromConfig = String(row?.card_last4 ?? "").trim();
  return fromConfig || null;
}

/** Open facturación month for manually entered ledger purchases (ignores purchase date). */
export function billingMonthForManualLedgerPurchase(accountId: number): string | null {
  const cardLast4 = cardLast4ForCreditCardAccount(accountId);
  if (!cardLast4) return null;
  return targetBillingMonthForManualImports(accountId, cardLast4);
}

/**
 * Billing month for a ledger purchase when projecting facturado.
 * Manual entries → open facturación; PDF entries → the cycle the purchase date falls in
 * ({@link billingMonthContainingPurchase}).
 */
export function billingMonthForLedgerPurchase(
  accountId: number,
  purchase: { purchase_date: string; source: string },
  statements?: readonly CcStatementRow[]
): string | null {
  if (purchase.source === "manual") {
    return billingMonthForManualLedgerPurchase(accountId);
  }
  return billingMonthContainingPurchase(accountId, purchase.purchase_date, statements);
}

/**
 * The `statement_date` an open web-paste bucket is keyed by: the config cycle's close for the
 * month. It is an IDENTITY, not the displayed close — `cc_statements` is unique on
 * (source, statement_date) and several sums group lines by statement date, so a bucket must not
 * move onto the real close (it would share its date with the incoming statement). What the app
 * shows as the close comes from {@link closeDateForBillingMonth}.
 */
export function statementCloseDdMmYyyyForBillingMonth(
  accountId: number,
  billingMonth: string
): string {
  const config = loadCreditCardBillingConfig(accountId);
  const range = billingPeriodIsoRange(billingMonth, config);
  const iso = range?.period_to ?? `${billingMonth}-20`;
  return ddMmYyyyFromIso(iso);
}

/**
 * Displayed close of a billing month, with where it came from — the statement, the feed's
 * SALDO INICIAL, the previous statement's announced next period, or (`estimated`) the config
 * cycle when the bank has published nothing yet.
 */
export function closeDateForBillingMonth(
  accountId: number,
  billingMonth: string
): { close_iso: string; close_ddmmyyyy: string; source: CcCloseSource } {
  const ev = closeEvidenceForBillingMonth(accountId, billingMonth);
  return { close_iso: ev.close_iso, close_ddmmyyyy: ddMmYyyyFromIso(ev.close_iso), source: ev.source };
}
