/**
 * Derive the AFC cuota ledger from the account's peso movements and the `afc_cic` valor cuota
 * series, benchmark it against the stored monthly valuations, and — with `--apply` — write
 * `movements.units_delta` so the account values as a cuota ledger (Σ cuotas × valor cuota at
 * the date) like AFP UNO.
 *
 *   npx tsx server/scripts/afc-cuota-ledger-derive.ts [--account-id=NN] [--apply]
 *
 * Report-first. Requires `backfill:afc-cic` to have covered the ledger's dates.
 *
 * NOTE: the ledger is normally rebuilt from the AFC documents (`import:afc-cert`, exact pay dates
 * plus cartola true-ups); this script stays as a benchmark for a ledger that has no certificate.
 *
 * Provenance of the derived cuotas: the excel-era AFC ledger carries pesos only, each
 * contribution dated at the month-end of its período. Until a cartola / certificado de
 * movimientos supplies the exact cuotas per abono, a movement's cuotas are |pesos| ÷ valor
 * cuota CIC on the movement's own date (the real acreditación lands a couple of weeks later,
 * so each contribution is off by that fortnight's fund move — a few tenths of a percent on a
 * conservative fund). A movement that CLOSES the position — the first stored valuation on or
 * after its date is 0 — takes exactly −(cuotas held) so the ledger lands on 0 instead of a
 * rounding residue. Movements that already carry units are left alone (a certificate-backed
 * re-entry wins over the derivation).
 *
 * The benchmark prints, for every stored valuation date, the stored value against the derived
 * Σ cuotas × valor cuota, and flags the dates where the stored value is merely the running sum
 * of contributions (the early excel rows carried no rentabilidad at all), which is why those
 * dates can never match a fund valuation.
 */
import { db } from "../src/db.js";
import { AFC_CIC_SERIES_KEY } from "../src/afcCicSeries.js";
import { revalueAfpAccountFromCuotas } from "../src/afpUnoValuation.js";
import { fundUnitClpOnOrBefore } from "../src/fundUnitDaily.js";
import { accountKindSlugForAccountId } from "../src/accountBucket.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

type LedgerRow = {
  id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  units_delta: number | null;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  note: string | null;
};

function resolveAccountId(): number {
  const explicit = arg("account-id");
  if (explicit != null) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--account-id must be a positive integer`);
    return n;
  }
  const rows = db
    .prepare(`SELECT id FROM accounts WHERE fund_series_key = ? ORDER BY id`)
    .all(AFC_CIC_SERIES_KEY) as { id: number }[];
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one account with fund_series_key='${AFC_CIC_SERIES_KEY}', found ${rows.length}; pass --account-id=NN`
    );
  }
  return rows[0]!.id;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function fmtClp(n: number): string {
  return Math.round(n).toLocaleString("en-US"); // convention-ok: script stdout, not user-facing UI
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const accountId = resolveAccountId();
  const kind = accountKindSlugForAccountId(accountId);
  if (kind !== "afc") throw new Error(`account ${accountId} is kind ${kind ?? "?"}, expected afc`);
  const seriesKey = (
    db.prepare(`SELECT fund_series_key FROM accounts WHERE id = ?`).get(accountId) as {
      fund_series_key: string | null;
    }
  ).fund_series_key;
  if (seriesKey !== AFC_CIC_SERIES_KEY) {
    throw new Error(`account ${accountId} has fund_series_key=${seriesKey ?? "NULL"}, expected ${AFC_CIC_SERIES_KEY}`);
  }
  const seriesCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM fund_unit_daily WHERE series_key = ?`).get(seriesKey) as { c: number }
  ).c;
  if (seriesCount === 0) throw new Error(`no ${seriesKey} rows — run npm run backfill:afc-cic first`);

  const ledger = db
    .prepare(
      `SELECT id, occurred_on, amount, currency, units_delta, account_id, from_account_id, to_account_id, note
       FROM movements
       WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
       ORDER BY date(occurred_on), id`
    )
    .all(accountId, accountId, accountId) as LedgerRow[];
  const stored = db
    .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
    .all(accountId) as { as_of_date: string; value: number }[];
  const firstStoredOnOrAfter = (ymd: string) => stored.find((v) => v.as_of_date >= ymd) ?? null;

  console.log(`AFC cuota ledger derivation — account ${accountId}, series ${seriesKey} (${seriesCount} rows)`);
  console.log(`${apply ? "APPLY" : "REPORT ONLY"}: ${ledger.length} movements, ${stored.length} stored valuations\n`);
  console.log("movement  date        pesos            px CIC     cuotas       running   note");

  const plan: { id: number; units: number }[] = [];
  let running = 0;
  let derived = 0;
  let kept = 0;
  const runningByDate: { ymd: string; cuotas: number }[] = [];
  for (const m of ledger) {
    if (m.currency !== "clp") throw new Error(`movement ${m.id} is ${m.currency}, expected clp`);
    const isTransfer = m.account_id == null;
    const outflow = isTransfer ? m.from_account_id === accountId : m.amount < 0;
    const pesos = Math.abs(m.amount);
    const px = fundUnitClpOnOrBefore(seriesKey, m.occurred_on);
    if (px == null) throw new Error(`no ${seriesKey} valor cuota on or before ${m.occurred_on} (movement ${m.id})`);
    let signedUnits: number;
    let tag: string;
    if (m.units_delta != null && m.units_delta !== 0) {
      const mag = Math.abs(m.units_delta);
      signedUnits = outflow ? -mag : mag;
      tag = "kept (already has units)";
      kept += 1;
    } else {
      const closes = outflow && (firstStoredOnOrAfter(m.occurred_on)?.value ?? NaN) === 0;
      if (closes) {
        signedUnits = -round4(running);
        tag = `closes position (stored 0 at ${firstStoredOnOrAfter(m.occurred_on)!.as_of_date})`;
      } else {
        const mag = round4(pesos / px);
        signedUnits = outflow ? -mag : mag;
        tag = "pesos ÷ px";
      }
      // Transfer legs store the magnitude; direction lives in from/to (`transferLegUnitsThroughDate`).
      plan.push({ id: m.id, units: isTransfer ? Math.abs(signedUnits) : signedUnits });
      derived += 1;
    }
    running = round4(running + signedUnits);
    runningByDate.push({ ymd: m.occurred_on, cuotas: running });
    console.log(
      `${String(m.id).padStart(8)}  ${m.occurred_on}  ${fmtClp(outflow ? -pesos : pesos).padStart(13)}  ${px
        .toFixed(2)
        .padStart(10)}  ${signedUnits.toFixed(4).padStart(11)}  ${running.toFixed(4).padStart(11)}   ${tag}`
    );
  }
  if (Math.abs(running) > 0.00005) {
    console.log(`\nNOTE: ledger ends with ${running.toFixed(4)} cuotas (position open).`);
  } else {
    console.log(`\nLedger ends at 0 cuotas.`);
  }

  // Benchmark: stored monthly values vs the derived ledger × valor cuota at each stored date.
  console.log(`\nBenchmark — stored valuation vs derived Σ cuotas × valor cuota`);
  console.log("date        stored          derived         diff        diff%    cuotas     note");
  const cuotasAt = (ymd: string): number => {
    let c = 0;
    for (const r of runningByDate) {
      if (r.ymd <= ymd) c = r.cuotas;
      else break;
    }
    return c;
  };
  let contribRunning = 0;
  let contribIdx = 0;
  const diffs: number[] = [];
  let bookRows = 0;
  let zeroRows = 0;
  for (const v of stored) {
    while (contribIdx < ledger.length && ledger[contribIdx]!.occurred_on <= v.as_of_date) {
      const m = ledger[contribIdx]!;
      const isTransfer = m.account_id == null;
      const signed = isTransfer ? (m.from_account_id === accountId ? -Math.abs(m.amount) : Math.abs(m.amount)) : m.amount;
      contribRunning += signed;
      contribIdx += 1;
    }
    const px = fundUnitClpOnOrBefore(seriesKey, v.as_of_date);
    if (px == null) throw new Error(`no ${seriesKey} valor cuota on or before ${v.as_of_date}`);
    const cuotas = cuotasAt(v.as_of_date);
    const derivedClp = Math.round(cuotas * px);
    const diff = derivedClp - v.value;
    const isBook = v.value !== 0 && Math.round(contribRunning) === Math.round(v.value);
    let note = "";
    if (v.value === 0 && cuotas === 0) {
      note = "both 0";
      zeroRows += 1;
    } else if (isBook) {
      note = "stored = Σ contributions (book, no rentabilidad)";
      bookRows += 1;
    } else if (v.value !== 0) {
      diffs.push(diff / v.value);
    }
    const pct = v.value !== 0 ? `${((diff / v.value) * 100).toFixed(2)}%` : "—";
    console.log(
      `${v.as_of_date}  ${fmtClp(v.value).padStart(13)}  ${fmtClp(derivedClp).padStart(13)}  ${fmtClp(diff).padStart(10)}  ${pct.padStart(8)}  ${cuotas
        .toFixed(4)
        .padStart(9)}  ${note}`
    );
  }
  if (diffs.length > 0) {
    const abs = diffs.map((d) => Math.abs(d)).sort((a, b) => a - b);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const median = abs[Math.floor(abs.length / 2)]!;
    console.log(
      `\nBenchmark over ${diffs.length} fund-valued dates (${bookRows} book-only dates and ${zeroRows} zero dates excluded): ` +
        `mean ${(mean * 100).toFixed(2)}%, median |diff| ${(median * 100).toFixed(2)}%, max |diff| ${(abs[abs.length - 1]! * 100).toFixed(2)}%`
    );
  }
  console.log(`\nPlan: derive units on ${derived} movement(s), keep ${kept} already-united.`);

  if (!apply) {
    console.log("Report only — re-run with --apply to write units_delta (and stamp units_snapshot on the stored rows).");
    return;
  }
  const upd = db.prepare(`UPDATE movements SET units_delta = ? WHERE id = ?`);
  db.transaction(() => {
    for (const p of plan) upd.run(p.units, p.id);
  })();
  console.log(`Wrote units_delta on ${plan.length} movement(s).`);
  const stamp = revalueAfpAccountFromCuotas({
    accountId,
    seriesKey,
    dryRun: false,
    preserveExcelValues: true,
  });
  console.log(`Stamped units_snapshot on ${stamp.updated} stored valuation row(s) (values preserved as the benchmark).`);
}

main();
