/**
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
 * then the announcement, then the config estimate. Only the estimate is a guess, and callers
 * that route lines by date refuse to act on it.
 *
 * Leaf module (no billing-view imports) so `ccManualBillingMonth` can depend on it.
 */
import { db } from "./db.js";
import { billingPeriodIsoRange, loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";

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

/** `2026-09-24` → `24/09/2026`, the zero-padded form `cc_statements` stores. */
export function ddMmYyyyFromIso(iso: string): string {
  const [y, mo, d] = iso.split("-");
  return `${d}/${mo}/${y}`;
}

function isRealStatement(st: CcStatementRow): boolean {
  return !String(st.source_pdf ?? "").trim().startsWith("import:web-paste");
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

export type CcFeedCloseObservation = {
  close_iso: string;
  /** Debt-positive «Monto total facturado» per currency; null when the feed had no row for it. */
  saldo_inicial_clp: number | null;
  saldo_inicial_usd: number | null;
  source_file: string | null;
};

export type CcFeedCloseRecordResult = {
  status: "new" | "seen";
  close: CcFeedBillingClose;
};

/** A currency one fetch did not show is not evidence: only two observed figures can disagree. */
function amountsAgree(a: number | null, b: number | null, tolerance: number): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= tolerance;
}

/**
 * Store one SALDO INICIAL observation. The feed repeats the same row every day of the cycle, so
 * a repeat only refreshes `last_seen_at`. A repeat that disagrees — the same facturación with a
 * different close date or a different billed total — is a contradiction in the bank's own data
 * (or a parse bug) and throws: a provisional close must never silently change under the ledger.
 */
export function recordFeedBillingClose(
  accountId: number,
  obs: CcFeedCloseObservation
): CcFeedCloseRecordResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(obs.close_iso)) {
    throw new Error(`recordFeedBillingClose: bad close date "${obs.close_iso}"`);
  }
  const billingMonth = obs.close_iso.slice(0, 7);
  const existing = feedBillingCloseForMonth(accountId, billingMonth);
  if (existing) {
    if (existing.close_date !== obs.close_iso) {
      throw new Error(
        `Account ${accountId}: the card feed now dates the ${billingMonth} close ${obs.close_iso}, ` +
          `but it was observed as ${existing.close_date} (first seen ${existing.first_seen_at}). ` +
          `The bank moved a close it had already published — check the feed before importing.`
      );
    }
    const clpOk = amountsAgree(existing.saldo_inicial_clp, obs.saldo_inicial_clp, 0.5);
    const usdOk = amountsAgree(existing.saldo_inicial_usd, obs.saldo_inicial_usd, 0.005);
    if (!clpOk || !usdOk) {
      throw new Error(
        `Account ${accountId}: SALDO INICIAL for the ${obs.close_iso} close changed — ` +
          `CLP ${existing.saldo_inicial_clp ?? "none"} → ${obs.saldo_inicial_clp ?? "none"}, ` +
          `USD ${existing.saldo_inicial_usd ?? "none"} → ${obs.saldo_inicial_usd ?? "none"}. ` +
          `A billed total does not change after the close — check the feed before importing.`
      );
    }
    // A currency a previous fetch missed is filled in; one this fetch missed keeps its figure.
    db.prepare(
      `UPDATE cc_feed_billing_closes SET last_seen_at = datetime('now'), source_file = ?,
         saldo_inicial_clp = COALESCE(saldo_inicial_clp, ?),
         saldo_inicial_usd = COALESCE(saldo_inicial_usd, ?)
       WHERE account_id = ? AND billing_month = ?`
    ).run(obs.source_file, obs.saldo_inicial_clp, obs.saldo_inicial_usd, accountId, billingMonth);
    return { status: "seen", close: feedBillingCloseForMonth(accountId, billingMonth)! };
  }
  db.prepare(
    `INSERT INTO cc_feed_billing_closes
       (account_id, billing_month, close_date, saldo_inicial_clp, saldo_inicial_usd, source_file)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    billingMonth,
    obs.close_iso,
    obs.saldo_inicial_clp,
    obs.saldo_inicial_usd,
    obs.source_file
  );
  return { status: "new", close: feedBillingCloseForMonth(accountId, billingMonth)! };
}

// ---------------------------------------------------------------------------------------------
// Announced closes (statement «próximo período»)
// ---------------------------------------------------------------------------------------------

/**
 * The close the account's statements announced for `billingMonth` (the month of the printed
 * next-period end). Two statements announcing different closes for the same month is a
 * contradiction and throws; the CLP and USD twins of one facturación announce the same one.
 */
export function announcedCloseIsoForBillingMonth(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): string | null {
  let found: { iso: string; from: string } | null = null;
  for (const st of statements) {
    if (!isRealStatement(st)) continue;
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
    if (!isRealStatement(st)) continue;
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

function realStatementCloseIso(
  statements: readonly CcStatementRow[],
  billingMonth: string
): string | null {
  for (const st of statements) {
    if (st.billing_month !== billingMonth || !isRealStatement(st)) continue;
    const iso = isoFromField(st.period_to) ?? isoFromField(st.statement_date);
    if (iso) return iso;
  }
  return null;
}

/** Best-known close of `billingMonth`: statement → feed observation → announcement → config. */
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
  const range = billingPeriodIsoRange(billingMonth, loadCreditCardBillingConfig(accountId));
  return { close_iso: range?.period_to ?? `${billingMonth}-20`, source: "estimated" };
}

/**
 * First purchase date that belongs to the facturación AFTER `billingMonth`: the statement's
 * printed next-period start when it has one, else the known close shifted by the issuer's
 * close-day offset. With only a config estimate — or no statement that prints the offset — this
 * falls back to the day after the close, the inclusive reading the app used before.
 */
export function nextPeriodStartIsoForBillingMonth(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): { iso: string; source: CcCloseSource } {
  for (const st of statements) {
    if (st.billing_month !== billingMonth || !isRealStatement(st)) continue;
    const printed = isoFromField(st.next_period_from);
    if (printed) return { iso: printed, source: "statement" };
  }
  const close = closeEvidenceForBillingMonth(accountId, billingMonth, statements);
  if (close.source === "estimated") return { iso: addDaysIso(close.close_iso, 1), source: "estimated" };
  const offset = closeDayOffsetDays(accountId, statements) ?? 1;
  return { iso: addDaysIso(close.close_iso, offset), source: close.source };
}

// ---------------------------------------------------------------------------------------------
// Cross-check: feed SALDO INICIAL ↔ imported statement
// ---------------------------------------------------------------------------------------------

/**
 * Where a feed-observed close disagrees with the imported statement of the same facturación.
 *
 * The SALDO INICIAL row is the statement's «Monto total facturado» by definition — verified on the
 * July 2026 ·0901 close in both currencies (9xx.xxx CLP, US$xxx,xx on the feed and on the PDFs) —
 * and it is dated at the statement's close. A disagreement means one of the two parses is wrong.
 * A statement with no printed total (the JSON USD side's all-null header) is not compared.
 */
export function feedCloseStatementMismatches(
  accountId: number,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): string[] {
  const closes = db
    .prepare(
      `SELECT account_id, billing_month, close_date, saldo_inicial_clp, saldo_inicial_usd,
              first_seen_at, last_seen_at, source_file
       FROM cc_feed_billing_closes WHERE account_id = ?`
    )
    .all(accountId) as CcFeedBillingClose[];
  const problems: string[] = [];
  for (const close of closes) {
    for (const st of statements) {
      if (!isRealStatement(st) || st.billing_month !== close.billing_month) continue;
      const stClose = isoFromField(st.period_to) ?? isoFromField(st.statement_date);
      const label = `${st.currency.toUpperCase()} statement ${st.statement_date} (${st.source_pdf})`;
      if (stClose !== close.close_date) {
        problems.push(`${label} closes ${stClose}, the feed's SALDO INICIAL is dated ${close.close_date}`);
        continue;
      }
      const printed = st.monto_facturado;
      const observed = st.currency === "usd" ? close.saldo_inicial_usd : close.saldo_inicial_clp;
      // Nothing to compare: a statement with no printed total, or a currency the feed did not
      // show (its tab failed, or the card never billed in it).
      if (printed == null || observed == null) continue;
      const tolerance = st.currency === "usd" ? 0.005 : 0.5;
      if (Math.abs(printed - observed) > tolerance) {
        problems.push(`${label} bills ${printed}, the feed's SALDO INICIAL for that close is ${observed}`);
      }
    }
  }
  return problems;
}

/** Throws when {@link feedCloseStatementMismatches} finds anything (fail fast on either import). */
export function assertFeedClosesMatchStatements(accountId: number): void {
  const problems = feedCloseStatementMismatches(accountId);
  if (problems.length === 0) return;
  throw new Error(
    `Account ${accountId}: the card feed's SALDO INICIAL disagrees with the imported statement — ` +
      `${problems.join("; ")}. One of the two parses is wrong; fix it before importing.`
  );
}
