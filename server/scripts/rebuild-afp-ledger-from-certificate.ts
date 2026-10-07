/**
 * Rebuild the AFP account's cuota ledger and price series from a full-history movements
 * certificate and the Superintendencia de Pensiones' official valor cuota (PARSERS.md «AFP
 * account ledger»). Report by default; `--apply` writes everything in one transaction.
 *
 *   npm run parse:afp-uno-certificate -w nw-tracker-ingest -- --pdf=<movimientos.pdf> --out=<rows.json>
 *   npx tsx scripts/rebuild-afp-ledger-from-certificate.ts --cert=<rows.json> [--apply]
 *
 * 1. Fetches fund A of every AFP (2016 → this year) from the SP and, with --apply, stores it in
 *    `pension_fund_unit_official`.
 * 2. Dates each certificate row: its valor cuota names the AFP and the official day it was bought
 *    at (exact and unique, `certificateRowPriceWindow`); the ledger day is the day that price
 *    became visible, `AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS` Chile business days later (the rule the
 *    nightly sync writes with, `afpUnoOfficialSync.ts`).
 * 3. Converts each earlier AFP's cuotas to UNO cuotas with the transfers' own ratios (the
 *    certificate's «Traspaso Egreso / Ingreso Cuentas» rows), checking that each AFP's rows net to
 *    exactly the cuotas it transferred.
 * 4. Writes the earlier funds' series (`afp_prior_funds_a`: each AFP's official price in the
 *    display frame ÷ its ratio, frozen at the transfer-out price while the money is in transit)
 *    through the day before UNO's transfer-in shows, and declares it on the account
 *    (`accounts.fund_series_key`).
 * 5. Rewrites UNO's own series (`afp_uno_cuota_a`) in the display frame from the official one,
 *    through the day its latest published value shows (the sync's own rule).
 * 6. Replaces the account's movements with the shaped ledger (`pensionLedgerShape.ts`) and
 *    re-values its stored month-ends from it.
 *
 * Checked: every row's pesos = its cuotas × its official valor cuota; each earlier AFP's rows
 * net to the cuotas it transferred; the ledger's cuotas = the certificate's net. The report
 * prints every stored month-end before and after (the app's own mark).
 */
import fs from "node:fs";
import path from "node:path";
import type { PensionMovement } from "nw-tracker-contracts";
import { AFP_UNO_CUOTA_SERIES_KEY } from "../src/afpUnoSeries.js";
import { AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS, afpUnoDisplayNote } from "../src/afpUnoOfficialSync.js";
import { buildAfpDisplaySeries, afpDisplayDayForOfficialDay } from "../src/afpDisplayFrame.js";
import { afpCuotasCumulativeThroughDate, revalueAfpAccountFromCuotas } from "../src/afpUnoValuation.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "../src/chileDate.js";
import { isChileBusinessDay } from "../src/marketHolidays.js";
import { db } from "../src/db.js";
import { accountMarkClpAtYmd } from "../src/accountMarkClpAtYmd.js";
import {
  TRANSFER_CODES,
  certificateRowPriceWindow,
  firstVisibleDayOfValue,
  pensionLedgerNote,
  shapePensionLedgerRows,
  type DatedCertificateRow,
} from "../src/pensionLedgerShape.js";
import { fetchSpAfpFundUnits, upsertSpAfpFundUnits, type SpAfpFundUnitRow } from "../src/spAfpFundUnits.js";

const AFP_ACCOUNT_IMPORT_KEY = "import:excel|key=afp";
const PRIOR_FUNDS_SERIES_KEY = "afp_prior_funds_a";
const OFFICIAL_FROM_YEAR = 2016;

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const APPLY = process.argv.includes("--apply");
const certPath = arg("cert");
if (!certPath) throw new Error("usage: --cert=<rows.json> [--apply]");
const LAG = AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS;


const cert = JSON.parse(fs.readFileSync(path.resolve(certPath), "utf8")) as { rows: PensionMovement[]; folio: string };
const today = chileCalendarTodayYmd();
const thisYear = Number(today.slice(0, 4));

// ---- 1. official series ----
const official: SpAfpFundUnitRow[] = await fetchSpAfpFundUnits("A", OFFICIAL_FROM_YEAR, thisYear, today);
const byAfp = new Map<string, { day: string; unit_value_clp: number }[]>();
for (const r of official) {
  const list = byAfp.get(r.afp) ?? [];
  list.push({ day: r.day, unit_value_clp: r.unit_value_clp });
  byAfp.set(r.afp, list);
}
console.log(`official fund A: ${official.length} values, ${[...byAfp.keys()].join(", ")}; through ${official.at(-1)?.day}`);

// ---- 2. AFP + official day of every row ----
type Located = PensionMovement & { afp: string; official_day: string };
const located: Located[] = cert.rows.map((r) => {
  const { fromDay: lo, beforeDay: hi } = certificateRowPriceWindow(r.period);
  const hits: { afp: string; day: string }[] = [];
  for (const [afp, series] of byAfp) {
    const day = firstVisibleDayOfValue(series, r.valor_cuota, lo, hi);
    if (day) hits.push({ afp, day });
  }
  if (hits.length !== 1) {
    throw new Error(
      `row ${r.period} ${r.code} ${r.description} valor ${r.valor_cuota}: ${hits.length === 0 ? "no" : "several"} official matches ${JSON.stringify(hits)}`
    );
  }
  return { ...r, afp: hits[0]!.afp, official_day: hits[0]!.day };
});

// Each row's pesos are its cuotas at its own valor cuota (the certificate prints cuotas cut to two
// decimals, so up to a hundredth of a cuota apart).
for (const r of located) {
  if (r.cuotas > 0 && Math.abs(r.pesos - r.cuotas * r.valor_cuota) > 0.0101 * r.valor_cuota) {
    throw new Error(`row ${r.period} ${r.code}: ${r.pesos} pesos ≠ ${r.cuotas} cuotas × ${r.valor_cuota}`);
  }
}

// ---- 3. transfers and ratios ----
const transfers = located.filter((r) => TRANSFER_CODES.has(r.code)).sort((a, b) => a.official_day.localeCompare(b.official_day));
type Hop = { from: string; to: string; out: Located; in: Located; ratio: number };
const hops: Hop[] = [];
for (let i = 0; i < transfers.length; i += 2) {
  const out = transfers[i]!;
  const inn = transfers[i + 1];
  if (!inn || out.direction !== "debit" || inn.direction !== "credit" || out.afp === inn.afp) {
    throw new Error(`transfers do not pair as out → in: ${JSON.stringify([out, inn])}`);
  }
  hops.push({ from: out.afp, to: inn.afp, out, in: inn, ratio: inn.cuotas / out.cuotas });
}
const finalAfp = hops.at(-1)?.to ?? located.at(-1)!.afp;
if (finalAfp !== "uno") throw new Error(`the account ends at ${finalAfp}, not UNO`);
const factor = new Map<string, number>([["uno", 1]]);
for (const h of [...hops].reverse()) factor.set(h.from, h.ratio * factor.get(h.to)!);
for (const h of hops) {
  const net = located
    .filter((r) => r.afp === h.from && !TRANSFER_CODES.has(r.code))
    .reduce((s, r) => s + (r.direction === "credit" ? r.cuotas : -r.cuotas), 0);
  const inbound = hops.find((x) => x.to === h.from)?.in.cuotas ?? 0;
  if (Math.abs(net + inbound - h.out.cuotas) >= 0.005) {
    throw new Error(`${h.from}: rows net ${net.toFixed(2)} + ${inbound} transferred in ≠ ${h.out.cuotas} transferred out`);
  }
  const late = located.find((r) => r.afp === h.from && r.official_day > h.out.official_day);
  if (late) throw new Error(`${h.from}: a row priced ${late.official_day}, after its transfer out on ${h.out.official_day}`);
  console.log(
    `transfer ${h.from} → ${h.to}: ${h.out.cuotas} out ${h.out.official_day} (${h.out.pesos}), ${h.in.cuotas} in ${h.in.official_day} (${h.in.pesos}); ratio ${h.ratio.toFixed(6)}`
  );
}

// ---- 4. ledger rows ----
const dated: DatedCertificateRow[] = located
  .filter((r) => !TRANSFER_CODES.has(r.code))
  .map(({ afp, official_day, ...r }) => ({ ...r, factor: factor.get(afp)!, day: afpDisplayDayForOfficialDay(official_day, LAG) }));
const shaped = shapePensionLedgerRows(dated);
if (shaped.pending.length > 0) throw new Error(`rows with no visible day: ${JSON.stringify(shaped.pending)}`);
// The earlier AFPs' rows, converted at the transfer ratio and rounded to 4 decimals, must add up
// to exactly the cuotas UNO credited at the transfer-in (111,3702 vs 111,37 left the ledger
// 0,0002 cuotas — ~20 pesos — above UNO's stated balance). The rounding residue goes on the last
// row before the transfer-in.
{
  const unoIn = hops.find((h) => h.to === "uno");
  if (unoIn) {
    const inDay = afpDisplayDayForOfficialDay(unoIn.in.official_day, LAG);
    const before = shaped.rows.filter((r) => r.occurred_on < inDay);
    const residue = round4(unoIn.in.cuotas - before.reduce((s, r) => s + r.cuotas, 0));
    if (Math.abs(residue) >= 0.005) throw new Error(`earlier AFPs' rows miss UNO's transfer-in by ${residue} cuotas`);
    const last = before.at(-1);
    if (!last) throw new Error("no ledger row before UNO's transfer-in");
    if (residue !== 0) {
      console.log(`rounding residue ${residue} cuotas put on ${last.occurred_on} (${last.cuotas} → ${round4(last.cuotas + residue)})`);
      last.cuotas = round4(last.cuotas + residue);
    }
  }
}
const ledgerCuotas = shaped.rows.reduce((s, r) => s + r.cuotas, 0);
const certNet = located
  .filter((r) => r.afp === "uno")
  .reduce((s, r) => s + (r.direction === "credit" ? r.cuotas : -r.cuotas), 0);
if (Math.abs(ledgerCuotas - certNet) >= 0.00005) throw new Error(`ledger ${ledgerCuotas.toFixed(4)} cuotas ≠ certificate ${certNet.toFixed(4)}`);
console.log(`ledger: ${shaped.rows.length} rows, ${ledgerCuotas.toFixed(4)} UNO cuotas (certificate ${certNet.toFixed(2)})`);

// ---- 5. series ----
// Through the day UNO's latest published value shows, as the nightly sync writes it.
const unoLastValued = [...byAfp.get("uno")!].reverse().find((r) => isChileBusinessDay(r.day))!;
const unoThrough = [today, afpDisplayDayForOfficialDay(unoLastValued.day, LAG)].sort()[0]!;
const unoDisplay = buildAfpDisplaySeries(byAfp.get("uno")!, LAG, unoThrough);
const unoInVisible = afpDisplayDayForOfficialDay(hops.at(-1)!.in.official_day, LAG);
const displayByAfp = new Map([...byAfp].map(([afp, s]) => [afp, new Map(buildAfpDisplaySeries(s, LAG, today).map((r) => [r.day, r.unit_value_clp]))]));
const firstDay = shaped.rows[0]!.occurred_on;
const visible = (r: Located) => afpDisplayDayForOfficialDay(r.official_day, LAG);
const prior: { day: string; unit_value_clp: number; note: string }[] = [];
for (let day = firstDay; day < unoInVisible; day = chileCalendarAddDays(day, 1)) {
  let px: number | null = null;
  let note = "";
  hops.forEach((h, i) => {
    const heldFrom = i === 0 ? "" : visible(hops[i - 1]!.in);
    if (day >= heldFrom && day < visible(h.out)) {
      // Held in the hop's source fund: its official price as shown, in UNO cuotas.
      const shown = displayByAfp.get(h.from)!.get(day);
      if (shown == null) throw new Error(`${h.from} has no display price on ${day}`);
      px = shown / factor.get(h.from)!;
      note = `sp:official|afp=${h.from}|lag=${LAG}`;
    } else if (day >= visible(h.out) && day < visible(h.in)) {
      // In transit: the value the money left with, until the next fund prices it.
      px = h.out.valor_cuota / factor.get(h.from)!;
      note = `transit|${h.from}→${h.to}|lag=${LAG}`;
    }
  });
  if (px == null) throw new Error(`no fund holds the account on ${day}`);
  prior.push({ day, unit_value_clp: round4(px), note });
}
console.log(`prior funds series: ${prior.length} days ${prior[0]?.day} → ${prior.at(-1)?.day}; UNO from ${unoInVisible}`);

const stored = db
  .prepare(`SELECT day, unit_value_clp, note FROM fund_unit_daily WHERE series_key = ? ORDER BY day`)
  .all(AFP_UNO_CUOTA_SERIES_KEY) as { day: string; unit_value_clp: number; note: string | null }[];
const unoLast = unoDisplay.at(-1)!.day;
const storedByDay = new Map(stored.map((s) => [s.day, s]));
let same = 0;
const differs: string[] = [];
for (const r of unoDisplay) {
  const s = storedByDay.get(r.day);
  if (!s) continue;
  if (Math.abs(s.unit_value_clp - r.unit_value_clp) <= 0.005) same += 1;
  else differs.push(`${r.day} ${s.unit_value_clp} → ${r.unit_value_clp} (${(s.note ?? "").slice(0, 24)})`);
}
console.log(`UNO display series: ${unoDisplay.length} days through ${unoLast}; stored rows equal ${same}, rewritten ${differs.length}`);
for (const d of differs.slice(0, 8)) console.log(`  ${d}`);
if (differs.length > 8) console.log(`  … ${differs.length - 8} more (last: ${differs.at(-1)})`);

// ---- 6. write ----
const account = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(AFP_ACCOUNT_IMPORT_KEY) as { id: number } | undefined;
if (!account) throw new Error(`no account ${AFP_ACCOUNT_IMPORT_KEY}`);
const legs = db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE from_account_id = ? OR to_account_id = ?`).get(account.id, account.id) as { n: number };
if (legs.n > 0) throw new Error(`account ${account.id} has transfer legs — not a single-leg ledger`);
const oldRows = db
  .prepare(`SELECT id, occurred_on, amount, units_delta FROM movements WHERE account_id = ? ORDER BY occurred_on, id`)
  .all(account.id) as { id: number; occurred_on: string; amount: number; units_delta: number | null }[];
console.log(`account ${account.id}: ${oldRows.length} movements replaced by ${shaped.rows.length}`);
const valuationsBefore = db
  .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
  .all(account.id) as { as_of_date: string; value: number }[];

const write = () => {
  upsertSpAfpFundUnits(official, { dryRun: false });
  const upsertSeries = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  );
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(PRIOR_FUNDS_SERIES_KEY);
  for (const p of prior) upsertSeries.run(PRIOR_FUNDS_SERIES_KEY, p.day, p.unit_value_clp, p.note);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(AFP_UNO_CUOTA_SERIES_KEY);
  for (const r of unoDisplay) {
    upsertSeries.run(AFP_UNO_CUOTA_SERIES_KEY, r.day, r.unit_value_clp, afpUnoDisplayNote(r));
  }
  db.prepare(`UPDATE accounts SET fund_series_key = ? WHERE id = ?`).run(PRIOR_FUNDS_SERIES_KEY, account.id);
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(account.id);
  const insert = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, ?)`
  );
  for (const r of shaped.rows) {
    insert.run(account.id, r.pesos, r.occurred_on, `${pensionLedgerNote(r)} | certificado ${cert.folio}`, r.cuotas);
  }
  const reval = revalueAfpAccountFromCuotas({ accountId: account.id, dryRun: false });
  console.log(`stored month-ends re-valued: ${reval.updated} (skipped ${reval.skipped})`);
};

// Run inside a transaction so the report reads the rebuilt state; roll back unless --apply.
const ROLLBACK = new Error("rollback (report only)");
try {
  db.transaction(() => {
    write();
    verifyAndReport(account.id);
    if (!APPLY) throw ROLLBACK;
  }).immediate();
  console.log("APPLIED.");
} catch (e) {
  if (e !== ROLLBACK) throw e;
  console.log("report only — nothing written (pass --apply).");
}

function verifyAndReport(accountId: number) {
  const cuotas = afpCuotasCumulativeThroughDate(accountId, today);
  if (Math.abs(cuotas - certNet) >= 0.00005) throw new Error(`after the rebuild the ledger holds ${cuotas} cuotas, not ${certNet}`);
  const monthEnds = db
    .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? AND as_of_date <= ? ORDER BY as_of_date`)
    .all(accountId, today) as { as_of_date: string; value: number }[];
  console.log(`\nmonth-end        before       after       diff`);
  const before = new Map(valuationsBefore.map((v) => [v.as_of_date, v.value]));
  for (const { as_of_date: d } of monthEnds) {
    const mark = accountMarkClpAtYmd(accountId, d)?.value_clp;
    if (mark == null) throw new Error(`no mark on ${d} after the rebuild`);
    const was = before.get(d) ?? 0;
    console.log(`${d}  ${was.toFixed(0).padStart(11)} ${mark.toFixed(0).padStart(11)} ${(mark - was).toFixed(0).padStart(10)}`);
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
