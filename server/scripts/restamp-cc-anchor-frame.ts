/**
 * Re-stamp CC month-end valuation anchors after the balance_total frame fix (2026-08-12):
 * `billingDetailBalanceClp` no longer subtracts `cuota_a_pagar_next_mes` (the term
 * double-removed the billed cuota — see the function doc in ccBillingViews.ts), so every
 * closed month-end anchor moves up by roughly that month's billed cuota.
 *
 * Report-first; `--apply` rewrites. Apply also purges the recent non-month-end daily
 * stamps (they froze the OLD frame — leaving them would put a phantom one-cuota step
 * between the last rewritten month-end and the first old stamp) and restamps today from
 * the owed walk based on the new anchors. Frame changes are exactly what stored stamps
 * do not survive (AGENTS: today-stamps self-purge on contradicted evidence).
 *
 *   npx tsx server/scripts/restamp-cc-anchor-frame.ts [--apply]
 */
import { db } from "../src/db.js";
import { accountBucketKindSlug } from "../src/accountBucket.js";
import {
  ccLedgerStatementClosingPointsClp,
  upsertCreditCardValuationsFromLedger,
} from "../src/ccCreditCardValuations.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";

const apply = process.argv.includes("--apply");

function isMonthEndIso(ymd: string): boolean {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t + 86_400_000).toISOString().slice(8, 10) === "01";
}

const accounts = (
  db
    .prepare(
      `SELECT a.id, a.name, g.slug AS bucket_slug
       FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       ORDER BY a.id`
    )
    .all() as { id: number; name: string; bucket_slug: string }[]
).filter((a) => accountBucketKindSlug(a.bucket_slug) === "credit_card");

const today = chileCalendarTodayYmd();
let totalChanged = 0;

for (const a of accounts) {
  const stored = db
    .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
    .all(a.id) as { as_of_date: string; value: number }[];
  const storedByDate = new Map(stored.map((r) => [r.as_of_date, Math.round(r.value)]));
  const pts = ccLedgerStatementClosingPointsClp(a.id) ?? [];

  const changes: string[] = [];
  for (const p of pts) {
    const old = storedByDate.get(p.as_of_date);
    if (old == null || old !== p.value_clp) {
      const delta = old == null ? null : p.value_clp - old;
      changes.push(
        `  ${p.as_of_date}  ${old == null ? "(new)" : old.toLocaleString("en")} -> ${p.value_clp.toLocaleString("en")}${
          delta == null ? "" : `  (${delta > 0 ? "+" : ""}${delta.toLocaleString("en")})`
        }`
      );
    }
  }
  const staleStamps = stored
    .filter((r) => r.as_of_date < today && !isMonthEndIso(r.as_of_date))
    .map((r) => `  purge ${r.as_of_date}  ${Math.round(r.value).toLocaleString("en")}`);

  if (changes.length === 0 && staleStamps.length === 0) {
    console.log(`account ${a.id} (${a.name}): no changes`);
    continue;
  }
  console.log(`account ${a.id} (${a.name}): ${changes.length} anchor changes, ${staleStamps.length} daily stamps to purge`);
  for (const line of [...changes, ...staleStamps]) console.log(line);
  totalChanged += changes.length;

  if (apply) {
    const n = upsertCreditCardValuationsFromLedger(a.id, {
      affectedEvidenceFromYmd: "2000-01-01",
    });
    const todayRow = db
      .prepare(`SELECT value FROM valuations WHERE account_id = ? AND as_of_date = ?`)
      .get(a.id, today) as { value: number } | undefined;
    console.log(
      `  applied: ${n} rows written; today (${today}) = ${todayRow ? Math.round(todayRow.value).toLocaleString("en") : "—"}`
    );
  }
}

console.log(
  `${apply ? "APPLIED" : "REPORT ONLY"} — ${accounts.length} CC masters, ${totalChanged} anchor value changes${apply ? "" : " (run with --apply to write)"}`
);
