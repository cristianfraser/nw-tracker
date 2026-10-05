/**
 * Deposit-account balances as the bank states them (`bank_account.balances`; for Santander the
 * landing page's product summary, read at every login) and the nightly check of the accounts the
 * app knows against their ledgers.
 *
 * Which app account a bank number is lives in `bank_account_numbers` (declared once per account
 * on the live database — account numbers are personal data). An undeclared number is recorded and
 * reported, never checked. The check reads the ledger at the Chile day of the observation through
 * the display readers (a row dated that day or known ahead of it counts), the bank's balance being
 * the one at login: equal to the cent, else a mismatch — a movement the ledger is missing or holds
 * twice. Each snapshot is judged once.
 */
import type { BankAccountBalancesApplyDetails, BankAccountBalancesPayload } from "nw-tracker-contracts";
import { checkingMovementBalanceClpAt } from "./checkingCartolaBalances.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";

type Currency = "clp" | "usd";

function declaredAccountId(issuer: string, number: string, currency: Currency): number | null {
  const row = db
    .prepare(`SELECT account_id FROM bank_account_numbers WHERE issuer = ? AND number = ? AND currency = ?`)
    .get(issuer, number, currency) as { account_id: number } | undefined;
  return row?.account_id ?? null;
}

/** Records one observation (idempotent per source: a resend of the same file records nothing). */
export function applyBankAccountBalances(
  payload: BankAccountBalancesPayload,
  sourceRef: string
): { duplicate: boolean; details: BankAccountBalancesApplyDetails } {
  const details: BankAccountBalancesApplyDetails = { recorded: 0, known: [], unknown: [] };
  const seen = db
    .prepare(`SELECT 1 AS o FROM bank_account_balance_snapshots WHERE source_ref = ? AND issuer = ? LIMIT 1`)
    .get(sourceRef, payload.issuer);
  const ins = db.prepare(
    `INSERT INTO bank_account_balance_snapshots
       (source_ref, issuer, number, product, currency, balance, label, status, observed_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const a of payload.accounts) {
      const accountId = declaredAccountId(payload.issuer, a.number, a.currency);
      if (accountId != null) {
        details.known.push({ account_id: accountId, number: a.number, currency: a.currency, balance: a.balance });
      } else {
        details.unknown.push({ number: a.number, currency: a.currency, label: a.label });
      }
      if (seen) continue;
      ins.run(
        sourceRef,
        payload.issuer,
        a.number,
        a.product,
        a.currency,
        a.balance,
        a.label,
        a.status,
        payload.observed_at,
        accountId
      );
      details.recorded += 1;
    }
  })();
  return { duplicate: seen != null, details };
}

/** The account's ledger balance in its own currency at `ymd` (pesos whole, dollars to the cent). */
export function ledgerBalanceInOwnCurrency(accountId: number, currency: Currency, ymd: string): number {
  if (currency === "usd") {
    if (!isUsdCashAccount(accountId)) throw new Error(`account ${accountId} is declared USD but is not a USD cash account`);
    return usdCashBalanceUsdAt(accountId, ymd);
  }
  return Math.round(checkingMovementBalanceClpAt(accountId, ymd));
}

export type BankBalanceVerdict = {
  snapshot_id: number;
  account_id: number;
  account_name: string;
  currency: Currency;
  observed_at: string;
  bank_balance: number;
  ledger_balance: number;
  diff: number;
  status: "ok" | "mismatch";
  /** Judged by this run (false: an earlier run's verdict on the same snapshot). */
  fresh: boolean;
  /** The previous snapshot's verdict for the same account, for the notify-once rule. */
  previous: { status: "ok" | "mismatch"; diff: number } | null;
};

type SnapshotRow = {
  id: number;
  account_id: number;
  account_name: string;
  currency: Currency;
  balance: number;
  observed_at: string;
  checked_status: "ok" | "mismatch" | null;
  checked_ledger: number | null;
  checked_diff: number | null;
};

/** Judges the latest snapshot of every declared account (`recheck` re-judges an already-judged one). */
export function judgeLatestBankAccountBalances(opts: { recheck?: boolean } = {}): BankBalanceVerdict[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.account_id, a.name AS account_name, s.currency, s.balance, s.observed_at,
              c.status AS checked_status, c.ledger_balance AS checked_ledger, c.diff AS checked_diff
       FROM bank_account_balance_snapshots s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN bank_account_balance_checks c ON c.snapshot_id = s.id
       WHERE s.id = (SELECT MAX(s2.id) FROM bank_account_balance_snapshots s2
                     WHERE s2.account_id = s.account_id AND s2.currency = s.currency)
       ORDER BY s.account_id, s.currency`
    )
    .all() as SnapshotRow[];
  const previousOf = db.prepare(
    `SELECT c.status, c.diff FROM bank_account_balance_checks c
     JOIN bank_account_balance_snapshots s ON s.id = c.snapshot_id
     WHERE s.account_id = ? AND s.currency = ? AND s.id < ?
     ORDER BY s.id DESC LIMIT 1`
  );
  const upsert = db.prepare(
    `INSERT INTO bank_account_balance_checks (snapshot_id, status, ledger_balance, diff)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(snapshot_id) DO UPDATE SET
       status = excluded.status, ledger_balance = excluded.ledger_balance, diff = excluded.diff,
       checked_at = datetime('now')`
  );
  const verdicts: BankBalanceVerdict[] = [];
  for (const r of rows) {
    const previous = (previousOf.get(r.account_id, r.currency, r.id) as BankBalanceVerdict["previous"]) ?? null;
    if (r.checked_status != null && !opts.recheck) {
      verdicts.push({
        snapshot_id: r.id,
        account_id: r.account_id,
        account_name: r.account_name,
        currency: r.currency,
        observed_at: r.observed_at,
        bank_balance: r.balance,
        ledger_balance: r.checked_ledger!,
        diff: r.checked_diff!,
        status: r.checked_status,
        fresh: false,
        previous,
      });
      continue;
    }
    const ymd = chileWallClockAt(new Date(r.observed_at)).ymd;
    const ledger = ledgerBalanceInOwnCurrency(r.account_id, r.currency, ymd);
    const diff = Math.round((ledger - r.balance) * 100) / 100;
    const status = diff === 0 ? "ok" : "mismatch";
    upsert.run(r.id, status, ledger, diff);
    verdicts.push({
      snapshot_id: r.id,
      account_id: r.account_id,
      account_name: r.account_name,
      currency: r.currency,
      observed_at: r.observed_at,
      bank_balance: r.balance,
      ledger_balance: ledger,
      diff,
      status,
      fresh: true,
      previous,
    });
  }
  return verdicts;
}

/** A notification for a new or changed mismatch, or one that cleared; a log otherwise. */
export function bankBalanceMessageKind(verdicts: readonly BankBalanceVerdict[]): "notification" | "log" {
  for (const v of verdicts) {
    if (!v.fresh) continue;
    if (v.status === "mismatch" && (v.previous?.status !== "mismatch" || v.previous.diff !== v.diff)) {
      return "notification";
    }
    if (v.status === "ok" && v.previous?.status === "mismatch") return "notification";
  }
  return "log";
}

function fmt(n: number, currency: Currency): string {
  return currency === "usd" ? `US$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

export function formatBankBalanceReport(verdicts: readonly BankBalanceVerdict[]): string {
  if (verdicts.length === 0) return "No bank account balance observed for a declared account yet.";
  return verdicts
    .map((v) => {
      const head = `${v.status === "ok" ? "ok      " : "MISMATCH"} ${v.account_name} (${v.currency.toUpperCase()}, observed ${v.observed_at})`;
      const body = `bank ${fmt(v.bank_balance, v.currency)} · app ${fmt(v.ledger_balance, v.currency)}`;
      const tail =
        v.status === "mismatch"
          ? ` · app − bank ${v.diff > 0 ? "+" : ""}${fmt(v.diff, v.currency)} — a movement the ledger misses or holds twice`
          : "";
      const recovered = v.fresh && v.status === "ok" && v.previous?.status === "mismatch" ? " (cleared)" : "";
      return `${head}: ${body}${tail}${recovered}`;
    })
    .join("\n");
}
