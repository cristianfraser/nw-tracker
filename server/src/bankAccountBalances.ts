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
 *
 * Any currency the app knows (`currencies`) is recorded and judged in the account's own currency to
 * its coin: pesos against the peso checking ledger, any other currency against the cash ledger held
 * in it (`foreignCashBalanceAt`). A declared account whose ledger is held in another currency throws.
 */
import { foreignCashBalanceAt, isForeignCashAccountIn } from "./foreignCashAccounts.js";
import { normalizeAccountNumber, type BankAccountBalancesApplyDetails, type BankAccountBalancesPayload } from "nw-tracker-contracts";
import { checkingMovementBalanceClpAt } from "./checkingCartolaBalances.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { requireLoadedCurrency } from "./ingestCurrencies.js";
import { currencyMinorDigits, isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { storeOnce } from "./ingestReceiver.js";


/** A currency code the app knows (`currencies`), lowercase. */
type Currency = string;

/** The account declared for `number`, compared as account numbers compare everywhere (digits, no leading zeros). */
function declaredAccountId(issuer: string, number: string, currency: Currency): number | null {
  const rows = db
    .prepare(`SELECT account_id, number FROM bank_account_numbers WHERE issuer = ? AND currency = ?`)
    .all(issuer, currency) as { account_id: number; number: string }[];
  const key = normalizeAccountNumber(number);
  const hits = rows.filter((r) => normalizeAccountNumber(r.number) === key);
  if (hits.length > 1) throw new Error(`bank_account_numbers declares ${issuer} ${currency} ${number} more than once`);
  return hits[0]?.account_id ?? null;
}

/**
 * Records one observation, once per source: a resend of the same file records nothing, and one
 * stating other balances under the same source is an `IngestConflict`.
 */
export function applyBankAccountBalances(received: BankAccountBalancesPayload, sourceRef: string): BankAccountBalancesApplyDetails {
  // Any currency the app knows; the check reads the account's ledger in it.
  const payload = {
    ...received,
    accounts: received.accounts.map((a) => ({ ...a, currency: requireLoadedCurrency(a.currency, "bank_account.balances") })),
  };
  const details: BankAccountBalancesApplyDetails = { recorded: 0, known: [], unknown: [] };
  const ins = db.prepare(
    `INSERT INTO bank_account_balance_snapshots
       (source_ref, issuer, number, product, currency, balance, label, status, observed_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const observation = (rows: readonly { number: string; product: string; currency: string; balance: number; label: string | null; status: string | null }[], observedAt: string) => ({
    observed_at: observedAt,
    rows: JSON.stringify(
      rows
        .map((r) => [r.number, r.product, r.currency, Number(r.balance), r.label ?? null, r.status ?? null])
        .sort((a, b) => `${a[0]}|${a[2]}`.localeCompare(`${b[0]}|${b[2]}`))
    ),
  });
  db.transaction(() => {
    for (const a of payload.accounts) {
      const accountId = declaredAccountId(payload.issuer, a.number, a.currency);
      if (accountId != null) {
        details.known.push({ account_id: accountId, number: a.number, currency: a.currency, balance: a.balance });
      } else {
        details.unknown.push({ number: a.number, currency: a.currency, label: a.label });
      }
    }
    storeOnce([payload], {
      table: "bank_account_balance_snapshots",
      key: () => `${payload.issuer}|${sourceRef}`,
      load: () => {
        const stored = db
          .prepare(
            `SELECT number, product, currency, balance, label, status, observed_at FROM bank_account_balance_snapshots
             WHERE source_ref = ? AND issuer = ?`
          )
          .all(sourceRef, payload.issuer) as { number: string; product: string; currency: string; balance: number; label: string | null; status: string | null; observed_at: string }[];
        return stored.length > 0 ? observation(stored, stored[0]!.observed_at) : undefined;
      },
      row: (p) => observation(p.accounts, p.observed_at),
      insert: (p) => {
        for (const a of p.accounts) {
          ins.run(sourceRef, p.issuer, a.number, a.product, a.currency, a.balance, a.label, a.status, p.observed_at, declaredAccountId(p.issuer, a.number, a.currency));
          details.recorded += 1;
        }
      },
    });
  })();
  return details;
}

/** The account's ledger balance in its own currency at `ymd`, to that currency's coin (pesos whole, dollars and euros to the cent). */
export function ledgerBalanceInOwnCurrency(accountId: number, currency: Currency, ymd: string): number {
  if (isHomeCurrency(currency)) return Math.round(checkingMovementBalanceClpAt(accountId, ymd));
  if (!isForeignCashAccountIn(accountId, currency)) {
    throw new Error(`account ${accountId} is declared ${currency.toUpperCase()} but is not a ${currency.toUpperCase()} cash account`);
  }
  return foreignCashBalanceAt(accountId, ymd);
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
  /**
   * The verdict at the latest earlier observation of the same account (the report marks a cleared
   * mismatch; the check notifies a new one) — not the same observation sent twice in one session.
   */
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
     WHERE s.account_id = ? AND s.currency = ? AND s.observed_at < ?
     ORDER BY s.observed_at DESC, s.id DESC LIMIT 1`
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
    const previous = (previousOf.get(r.account_id, r.currency, r.observed_at) as BankBalanceVerdict["previous"]) ?? null;
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
    const diff = roundToCurrency(ledger - r.balance, r.currency);
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

function fmt(n: number, currency: Currency): string {
  if (isHomeCurrency(currency)) return `$${Math.round(n)}`;
  if (currency === "usd") return `US$${n.toFixed(2)}`;
  return `${currency.toUpperCase()} ${n.toFixed(currencyMinorDigits(currency))}`;
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
