/**
 * Report-first: moves the category a hand-entered card plan still holds under its pre-amount
 * `installment-h:` key onto its current key (with the plan's total), so the legacy-key fallback in
 * `resolveCategoryIdForManualPurchase` (`src/ccManualInstallmentStatementReconcile.ts`) can be
 * deleted. Planner and outcomes: `scripts/lib/ccLegacyInstallmentKeyRekey.ts`. Ambiguous plans are
 * listed and never written; settle them by hand (pick the category in the plan's row) before the
 * fallback goes.
 *
 * Take a snapshot first (`npm run db:snapshot -w nw-tracker-server`), then from `server/`:
 *   npx tsx scripts/rekey-cc-manual-plan-legacy-categories.ts                  # report (live DB)
 *   NW_TRACKER_TEST_DB=<abs copy> npx tsx scripts/rekey-cc-manual-plan-legacy-categories.ts --apply
 *   npx tsx scripts/rekey-cc-manual-plan-legacy-categories.ts --apply --live   # write the live DB
 *
 * Guard: `--apply` without `NW_TRACKER_TEST_DB` targets the live DB and is refused unless `--live`
 * is passed too. The DB is opened only after that guard (a tsx script applies pending migrations
 * to whatever DB it opens). A second `--apply` finds nothing to move.
 */
const APPLY = process.argv.includes("--apply");
const LIVE = process.argv.includes("--live");
if (APPLY && !process.env.NW_TRACKER_TEST_DB?.trim() && !LIVE) {
  console.error(
    "Refusing --apply: NW_TRACKER_TEST_DB is unset, so this would write the LIVE database. " +
      "Rehearse on a copy (NW_TRACKER_TEST_DB=<abs path to the copy>), then pass --live to apply for real."
  );
  process.exit(2);
}

// The DB opens on import (and applies pending migrations) — only after the guard above.
const { db } = await import("../src/db.js");
const { applyLegacyInstallmentKeyRekey, planLegacyInstallmentKeyRekey } = await import(
  "./lib/ccLegacyInstallmentKeyRekey.js"
);

const items = planLegacyInstallmentKeyRekey(db);
const by = (o: string) => items.filter((i) => i.outcome === o);
for (const it of items) {
  console.log(
    [
      it.outcome.padEnd(9),
      `plan ${it.plan_id}`,
      `account ${it.account_id}`,
      it.purchase_date,
      JSON.stringify(it.merchant),
      `legacy category ${it.legacy_category_id}`,
      `current ${it.current_category_id === undefined ? "none" : it.current_category_id}`,
      it.reason ?? "",
    ].join(" · ")
  );
}
console.log(
  `manual plans with a categorized legacy key: ${items.length} — rekey ${by("rekey").length}, same ${by("same").length}, ambiguous ${by("ambiguous").length}`
);
if (!APPLY) {
  console.log("report only — nothing written (pass --apply).");
} else {
  const moved = db.transaction(() => applyLegacyInstallmentKeyRekey(db, items)).immediate();
  console.log(`moved ${moved} categories onto the current key.`);
  const left = planLegacyInstallmentKeyRekey(db).filter((i) => i.outcome === "rekey");
  if (left.length > 0) throw new Error(`still ${left.length} plans to re-key after the apply`);
}
if (by("ambiguous").length > 0) {
  console.log("ambiguous plans keep the fallback's answer until settled by hand; remove the fallback only after.");
}
