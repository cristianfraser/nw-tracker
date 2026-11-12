/**
 * The feed-observed close's writer and the statement ↔ feed cross-check. Reading closes is the
 * facturación module's (`cards/facturacion.ts`).
 */
import { db } from "./db.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";
import { foreignBilledFromStatementLines } from "./ccForeignStatementBilled.js";
import { isStatementSourceKind } from "./ccStatementSourceKind.js";
import { FEED_CLOSE_COLUMNS_SQL, feedBillingCloseForMonth, feedCloseFromDbRow, type CcFeedBillingClose } from "./cards/facturacion.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

function isoFromField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
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

const insertCloseAmount = db.prepare(
  `INSERT INTO cc_feed_billing_close_amounts (close_id, currency, amount) VALUES (?, ?, ?)
   ON CONFLICT(close_id, currency) DO NOTHING`
);

/** The observation's SALDO INICIAL per currency, on the close; a currency already on file keeps its figure. */
function insertMissingCloseAmounts(closeId: number, obs: CcFeedCloseObservation): void {
  for (const [currency, amount] of [
    ["clp", obs.saldo_inicial_clp],
    ["usd", obs.saldo_inicial_usd],
  ] as const) {
    if (amount != null) insertCloseAmount.run(closeId, currency, amount);
  }
}

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
      `UPDATE cc_feed_billing_closes SET last_seen_at = datetime('now'), source_file = ?
       WHERE account_id = ? AND billing_month = ?`
    ).run(obs.source_file, accountId, billingMonth);
    insertMissingCloseAmounts(existing.id, obs);
    return { status: "seen", close: feedBillingCloseForMonth(accountId, billingMonth)! };
  }
  const closeId = Number(
    db
      .prepare(
        `INSERT INTO cc_feed_billing_closes (account_id, billing_month, close_date, source_file)
         VALUES (?, ?, ?, ?)`
      )
      .run(accountId, billingMonth, obs.close_iso, obs.source_file).lastInsertRowid
  );
  insertMissingCloseAmounts(closeId, obs);
  return { status: "new", close: feedBillingCloseForMonth(accountId, billingMonth)! };
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
 * A dollar statement with no printed total (the JSON USD side's all-null header) is compared by
 * what its lines bill (`foreignBilledFromStatementLines`, the figure its facturación row shows): a line
 * read in the wrong direction (the 09/10/2026 MONTO CANCELADO came in as a positive charge)
 * fails here. A peso statement with no printed total is not compared.
 */
export function feedCloseStatementMismatches(
  accountId: number,
  statements: readonly CcStatementRow[] = listCcStatementsForAccount(accountId)
): string[] {
  const closes = (
    db
      .prepare(`SELECT ${FEED_CLOSE_COLUMNS_SQL} FROM cc_feed_billing_closes c WHERE c.account_id = ?`)
      .all(accountId) as Parameters<typeof feedCloseFromDbRow>[0][]
  ).map(feedCloseFromDbRow);
  const problems: string[] = [];
  for (const close of closes) {
    for (const st of statements) {
      if (!isStatementSourceKind(st.source_kind) || st.billing_month !== close.billing_month) continue;
      const stClose = isoFromField(st.period_to) ?? isoFromField(st.statement_date);
      const label = `${st.currency.toUpperCase()} statement ${st.statement_date} (${st.source_pdf})`;
      if (stClose !== close.close_date) {
        problems.push(`${label} closes ${stClose}, the feed's SALDO INICIAL is dated ${close.close_date}`);
        continue;
      }
      const printed =
        st.monto_facturado ?? (st.currency === "usd" ? foreignBilledFromStatementLines(st.id, "usd") : null); // convention-ok: the feed's SALDO INICIAL is stated in pesos and dollars only (Santander feed)
      const observed = st.currency === "usd" ? close.saldo_inicial_usd : close.saldo_inicial_clp; // convention-ok: the feed's SALDO INICIAL is stated in pesos and dollars only (Santander feed)
      // Nothing to compare: a statement with no printed total, or a currency the feed did not
      // show (its tab failed, or the card never billed in it).
      if (printed == null || observed == null) continue;
      const tolerance = st.currency === "usd" ? 0.005 : 0.5; // convention-ok: pesos have no minor unit, so the tolerance is half a peso against half a cent
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
