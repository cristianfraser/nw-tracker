/**
 * One-off: write every card's per-currency walk anchors (`cc_owed_anchors`, migration 259,
 * docs/holdings-cards-plan.md) and re-value its `valuations` rows at their own date's rate.
 *
 * Month-end anchors come from the statement frame split by currency
 * (`ccLedgerStatementClosingPointsNative`). Each stored daily stamp (a non-month-end row) froze the
 * old walk, whose dollars sat at the debt-frame rate; it is split as: dollars = the native dollar
 * walk from the month-end before it, pesos = the stamp − those dollars' old-frame pesos (the
 * old-frame dollar part of the month-end anchor plus the old-frame pesos of the dollar evidence
 * since). A stamp equal to the old walk thus becomes the native walk, and a card without dollars
 * keeps every peso. Then the ordinary writer runs (month-ends, today's stamp, every row re-valued).
 *
 * Cards without a plan ledger keep their CLP rows (the walk reads them as peso anchors).
 * Report-first: without `--apply` the whole transaction is rolled back after printing.
 *
 *   npx tsx scripts/restamp-cc-owed-anchors.ts [--apply]   (from server/)
 */
import { db } from "../src/db.js";
import { accountBucketKindSlug } from "../src/accountBucket.js";
import { normalizedPostCloseLines, type CcOwedNative } from "../src/ccBillingBalances.js";
import {
  ccLedgerStatementClosingPointsClp,
  ccLedgerStatementClosingPointsNative,
  upsertCreditCardValuationsFromLedger,
  writeCcOwedAnchor,
} from "../src/ccCreditCardValuations.js";
import { ccInstallmentLedgerRowCount } from "../src/ccInstallmentLedgerDb.js";


const apply = process.argv.includes("--apply");

const accounts = (
  db
    .prepare(
      `SELECT a.id, a.name, g.slug AS bucket_slug
       FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       ORDER BY a.id`
    )
    .all() as { id: number; name: string; bucket_slug: string }[]
).filter((a) => accountBucketKindSlug(a.bucket_slug) === "credit_card");

class Rollback extends Error {}

/** Dollars (native) and their old-frame pesos in (fromIso, toIso], deduped like the walk. */
function usdEvidence(accountId: number, fromIso: string, toIso: string): { usd: number; oldClp: number } {
  const seen = new Set<string>();
  let usd = 0;
  let oldClp = 0;
  for (const e of normalizedPostCloseLines(accountId)) {
    if (e.iso <= fromIso || e.iso > toIso || seen.has(e.key)) continue;
    seen.add(e.key);
    if (e.currency !== "usd") continue;
    if (e.amount != null) usd += e.amount;
    if (e.clp != null) oldClp += e.clp;
  }
  return { usd, oldClp };
}

let grandChanged = 0;
try {
  db.transaction(() => {
    for (const a of accounts) {
      if (ccInstallmentLedgerRowCount(a.id) === 0) {
        console.log(`#${a.id} ${a.name}: no plan ledger — CLP rows stay the walk's anchors`);
        continue;
      }
      const before = new Map(
        (
          db.prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ?`).all(a.id) as {
            as_of_date: string;
            value: number;
          }[]
        ).map((r) => [r.as_of_date, r.value])
      );
      const native = ccLedgerStatementClosingPointsNative(a.id) ?? [];
      const oldFrame = new Map((ccLedgerStatementClosingPointsClp(a.id) ?? []).map((p) => [p.as_of_date, p.value_clp]));
      const monthEnds = native.map((p) => p.as_of_date).sort();
      const nativeByDate = new Map(native.map((p) => [p.as_of_date, p.owed]));

      let stamps = 0;
      for (const [date, value] of before) {
        if (nativeByDate.has(date)) continue;
        const m = monthEnds.filter((d) => d < date).at(-1);
        let owed: CcOwedNative;
        if (m == null) {
          owed = { clp: Math.round(value), usd: 0 };
        } else {
          const mOwed = nativeByDate.get(m)!;
          const mOldUsdClp = (oldFrame.get(m) ?? 0) - mOwed.clp;
          const ev = usdEvidence(a.id, m, date);
          const usd = Math.round((mOwed.usd + ev.usd) * 100) / 100;
          owed = { clp: Math.round(value - mOldUsdClp - ev.oldClp), usd };
        }
        writeCcOwedAnchor(a.id, date, owed);
        stamps += 1;
      }
      upsertCreditCardValuationsFromLedger(a.id);
      const after = db.prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ?`).all(a.id) as {
        as_of_date: string;
        value: number;
      }[];
      let changed = 0;
      let maxAbs = 0;
      let maxDate = "";
      for (const r of after) {
        const old = before.get(r.as_of_date);
        if (old != null && Math.round(old) === Math.round(r.value)) continue;
        changed += 1;
        const d = old == null ? 0 : Math.abs(r.value - old);
        if (d > maxAbs) {
          maxAbs = d;
          maxDate = r.as_of_date;
        }
      }
      const usdDates = native.filter((p) => p.owed.usd !== 0).length;
      grandChanged += changed;
      console.log(
        `#${a.id} ${a.name}: ${native.length} month-end anchors (${usdDates} owing dollars), ` +
          `${stamps} stamps split; valuations changed ${changed}/${after.length}` +
          (changed ? `, largest ${Math.round(maxAbs).toLocaleString("en")} on ${maxDate}` : "")
      );
    }
    if (!apply) throw new Rollback();
  }).immediate();
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log(`\nReport only (rolled back). ${grandChanged} valuation rows would change; --apply to write.`);
  process.exit(0);
}
console.log(`\nApplied. ${grandChanged} valuation rows changed.`);
