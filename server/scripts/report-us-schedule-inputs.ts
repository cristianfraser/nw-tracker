/**
 * Report only: Schedule E (with Form 8582), Form 1116's Chilean taxes and Form 8621's roll-forward
 * for the generated demo DB, converted at `fx_daily` on or before each day (mid).
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/report-us-schedule-inputs.ts [--magi=<usd>] [--arrival=2024-04-15]
 *
 * Writes nothing. The MAGI defaults to the 1040 draft's line 9 of each year (wages + interest + dividends, taking
 * the draft's lines as the demo has them); `--magi=` overrides it.
 */
import { buildF1040Draft } from "../src/f1040Draft.js";
import { convertCurrency, isCurrencyCode } from "../src/rates.js";
import { form8582 } from "../src/us1040/form8582.js";
import { form8621Inputs, form8621RollForward } from "../src/us1040/form8621.js";
import { scheduleE, scheduleEInputs, type UsdAt } from "../src/us1040/scheduleE.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const ARRIVAL = flag("arrival") ?? "2024-04-15";
const magiFlag = flag("magi");

const usdAt: UsdAt = (amount, currency, ymd) => {
  if (!isCurrencyCode(currency)) throw new Error(`no currency ${currency}`);
  const v = convertCurrency(amount, currency, "usd", ymd, { side: "mid" });
  if (v == null) throw new Error(`no rate for ${currency} on ${ymd}`);
  return v;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

console.log(`US person since ${ARRIVAL}\n`);
let suspended = 0;
for (const year of [2024, 2025]) {
  const window = { fromYmd: year === 2024 ? ARRIVAL : `${year}-01-01`, throughYmd: `${year}-12-31` };
  const inputs = scheduleEInputs(window, usdAt, { usPersonSince: ARRIVAL });
  const result = scheduleE(inputs);
  console.log(`== Schedule E ${year} (${window.fromYmd} → ${window.throughYmd})`);
  for (const [i, p] of result.places.entries()) {
    console.log(`  ${p.label}: ${JSON.stringify(Object.fromEntries(Object.entries(p.lines).map(([k, v]) => [k, r2(v)])))}`);
    const d = p.depreciation;
    console.log(`    depreciation: basis ${r2(inputs[i]!.depreciation.basisUsd)} (${inputs[i]!.depreciation.basisOrigin}), building ${r2(d.buildingBasisUsd)}, from ${d.startDate} (${d.reading}), ${d.monthsInWindow.toFixed(2)} months in window`);
  }
  console.log(`  net ${r2(result.netUsd)}`);
  const draft = buildF1040Draft(year);
  const magi = magiFlag != null ? Number(magiFlag) : (draft.lines["9"] as number);
  const f = form8582({ status: draft.filingStatus, magiUsd: magi, rentalNetUsd: result.netUsd, priorSuspendedLossUsd: suspended });
  console.log(`  Form 8582 at MAGI ${r2(magi)} (${draft.filingStatus}): ${JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, r2(v)])))}`);
  suspended = f.suspendedLossUsd;
  console.log("");
}

console.log("== Form 8621 (mark to market)");
const firstUsYear = Number(ARRIVAL.slice(0, 4));
const byAccount = new Map<number, ReturnType<typeof form8621Inputs>>();
for (const year of [2024, 2025]) {
  const window = { fromYmd: year === firstUsYear ? ARRIVAL : `${year}-01-01`, throughYmd: `${year}-12-31` };
  for (const i of form8621Inputs(year, window, usdAt, { firstUsYear })) byAccount.set(i.accountId, [...(byAccount.get(i.accountId) ?? []), i]);
}
for (const [, years] of byAccount) {
  for (const r of form8621RollForward(years)) {
    console.log(
      `  ${r.label} ${r.taxYear}: start ${r2(r.startBasisUsd)} (${r.startUnits.toFixed(4)} units), before mark ${r2(r.basisBeforeMarkUsd)}, FMV ${r2(r.fmvYearEndUsd)}, inclusion ${r2(r.inclusionUsd)}, deduction ${r2(r.deductionUsd)}, disallowed ${r2(r.disallowedLossUsd)}, disposals ${r.disposals.length}, ordinary ${r2(r.ordinaryIncomeUsd)}, capital loss ${r2(r.capitalLossUsd)}, end basis ${r2(r.stateOut.adjustedBasisUsd)}, unreversed ${r2(r.stateOut.unreversedInclusionsUsd)}, partV ${r.flags.partVPossible}`
    );
  }
}
