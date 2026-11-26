/**
 * Report-first: values every account that held money before its first value, from the day the
 * money arrived.
 *
 * Why. A bucket's daily value sums only the members that have a value that day, so money that
 * enters an account before its first valuation counts as money in without its value — a huge
 * loss on the day it arrived and a huge gain on the day the value appears, which wreck every
 * daily-chained % above it. The daily build throws on that state (`fundedUnvaluedRun` in
 * `src/dailySeries.ts`); this script repairs the stored history it finds.
 *
 * Fix. One `valuations` row in pesos on the first day money entered, equal to the net deposits
 * through that day (`netDepositFlowBetween`, the same events the daily flows read). The book-value
 * carry then adds the later deposits until the next stored valuation, so the account is valued
 * every day from the deposit on and the bucket reads no P/L on the deposit day. Only accounts
 * valued from stored valuations are repaired (the panel's valuation rule: no property, mortgage,
 * crypto or card); any other hit aborts the run, since its value comes from its own ledger.
 *
 * Take a snapshot first (`npm run db:snapshot -w nw-tracker-server`), then:
 *   npx tsx scripts/value-accounts-from-first-deposit.ts            # report
 *   npx tsx scripts/value-accounts-from-first-deposit.ts --apply    # write
 */
import { accountMarkClpSeriesOnGrid } from "../src/accountMarkDailyCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "../src/chileDate.js";
import { fundedUnvaluedRun } from "../src/dailySeries.js";
import { db } from "../src/db.js";
import { netDepositFlowWindows } from "../src/flowsDeposits.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { listAccountsForGroupTab } from "../src/valuationTimeseries.js";

const apply = process.argv.includes("--apply");

function dayGrid(): string[] {
  const end = chileCalendarTodayYmd();
  const grid: string[] = [];
  for (let d = chileCalendarAddDays(portfolioStartYmd(), -1); d <= end; d = chileCalendarAddDays(d, 1)) grid.push(d);
  return grid;
}

type Hit = { accountId: number; name: string; flowYmd: string; markYmd: string; value: number };

function findHits(grid: readonly string[]): Hit[] {
  const rows = new Map<number, { account_id: number; name: string | null }>();
  for (const slug of ["net_worth", "liabilities"]) {
    for (const r of listAccountsForGroupTab(slug)) if (r.account_id > 0) rows.set(r.account_id, r);
  }
  const hits: Hit[] = [];
  for (const r of rows.values()) {
    const marks = accountMarkClpSeriesOnGrid({ account_id: r.account_id }, grid);
    const windows = netDepositFlowWindows(r.account_id, "clp");
    // Deposit events sit on their movements' days: only those days can carry a flow.
    const movementDays = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT occurred_on AS d FROM movements
              WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
          )
          .all(r.account_id, r.account_id, r.account_id) as { d: string }[]
      ).map((m) => m.d)
    );
    const flows = grid.slice(1).map((day, i) => (movementDays.has(day) ? windows(grid[i]!, day) : 0));
    const run = fundedUnvaluedRun(marks, flows);
    if (!run) continue;
    const flowYmd = grid[run.flowGi]!;
    hits.push({
      accountId: r.account_id,
      name: r.name ?? "?",
      flowYmd,
      markYmd: grid[run.markGi]!,
      value: windows("0000-01-01", flowYmd),
    });
  }
  return hits;
}

/**
 * Only an account valued from stored valuations is repaired here: it already has some, and it is
 * not a card. Any other account a new row would not value (a ledger-valued one) is caught by the
 * re-check after the write, which rolls the whole run back.
 */
function assertStoredValuationAccount(accountId: number): void {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM valuations v WHERE v.account_id = ?) AS n_valuations,
              (SELECT COUNT(*) FROM credit_card_account_config c WHERE c.account_id = ?) AS is_card`
    )
    .get(accountId, accountId) as { n_valuations: number; is_card: number };
  if (row.n_valuations === 0 || row.is_card > 0) {
    throw new Error(
      `account #${accountId} is not valued from stored valuations; its value comes from its own ledger — fix that instead`
    );
  }
}

const grid = dayGrid();
const hits = findHits(grid);
if (!hits.length) {
  console.log("Every account is valued from the day money enters it — nothing to do.");
  process.exit(0);
}
for (const h of hits) {
  console.log(
    `#${h.accountId} ${h.name}: money from ${h.flowYmd}, first value ${h.markYmd} → valuation ${h.flowYmd} = ${h.value} CLP`
  );
  assertStoredValuationAccount(h.accountId);
  if (!(h.value > 0)) throw new Error(`#${h.accountId}: net deposits through ${h.flowYmd} are ${h.value}, not a value`);
}
if (!apply) {
  console.log(`Report only (${hits.length} account(s)). Re-run with --apply to write.`);
  process.exit(0);
}
db.transaction(() => {
  const insert = db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
  for (const h of hits) insert.run(h.accountId, h.flowYmd, h.value);
  const left = findHits(grid);
  if (left.length) {
    throw new Error(`still unvalued after the fix: ${left.map((h) => `#${h.accountId} ${h.flowYmd}`).join(", ")}`);
  }
})();
console.log(`Wrote ${hits.length} valuation(s).`);
