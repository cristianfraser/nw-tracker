/**
 * Split the AFP account into one account per fund manager and fund
 * (docs/afp-fund-accounts-plan.md, piece C). Report by default; `--apply` writes everything in
 * one IMMEDIATE transaction.
 *
 *   npm run parse:afp-uno-certificate -w nw-tracker-ingest -- --pdf=<movimientos.pdf> --out=<rows.json>
 *   NW_TRACKER_TEST_DB=<copy> npx tsx scripts/split-afp-ledger-into-fund-accounts.ts --cert=<rows.json> [--apply]
 *
 * The one AFP account today holds every fund's cuotas converted into UNO cuotas with the
 * switches' ratios and priced through a synthetic series (`afp_prior_funds_a`). After this:
 *
 * 1. Every certificate row is located (its AFP and official day, `pensionCertificateChain.ts`)
 *    and the switches between fund managers are paired egreso → ingreso.
 * 2. Each earlier fund gets its own account («<AFP>-A», `import:afp|afp=<afp>|fund=A`, on
 *    the AFP asset group) holding its own rows in its own cuotas (`shapePensionLedgerRows`,
 *    factor 1), and its display series `afp_<afp>_cuota_a` from its first ledger day through
 *    the day its sale price showed (decision 2: an on-or-before read keeps the sold cuotas at
 *    the pesos that left while the money is in transit).
 * 3. Each switch is one transfer sender → receiver dated the day the receiving fund's credit
 *    price showed, carrying the cuotas sold (`units_delta`) and bought (`counter_units_delta`),
 *    `flow_kind = afp_fund_switch`. The pesos credited minus the pesos the sale produced are
 *    the receiving fund's P/L on that day — reported, never an error.
 * 4. The existing account becomes «UNO-A»: its rows dated before UNO's credit day (the
 *    converted earlier-fund rows plus the rebuild's rounding residue) and its stored valuations
 *    before that day are deleted; rows on or after it are never rewritten. `afp_prior_funds_a`
 *    is deleted.
 * 5. The nav tree is re-seeded so the new accounts join the AFP + AFC node.
 *
 * Checks: each sold fund's rows + its switch in = its switch out (0,005 cuotas); the UNO
 * account's cuotas today are unchanged (0,00005); today's value is unchanged to the peso. The
 * report prints every month-end's value before (the one account, in its pre-split frame) and
 * after (Σ of the three accounts).
 *
 * Guard: `--apply` without `NW_TRACKER_TEST_DB` targets the live DB and is refused unless
 * `--live` is passed too. The DB is opened only after that guard (a tsx script applies pending
 * migrations to whatever DB it opens).
 */
import fs from "node:fs";
import path from "node:path";
import type { PensionMovement } from "nw-tracker-contracts";

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const APPLY = process.argv.includes("--apply");
const LIVE = process.argv.includes("--live");
const certPath = arg("cert");
if (!certPath) throw new Error("usage: --cert=<rows.json> [--apply] [--live]");
if (APPLY && !process.env.NW_TRACKER_TEST_DB?.trim() && !LIVE) {
  console.error(
    "Refusing --apply: NW_TRACKER_TEST_DB is unset, so this would write the LIVE database. " +
      "Rehearse on a copy (NW_TRACKER_TEST_DB=<abs path to the copy>), then pass --live to apply for real."
  );
  process.exit(2);
}

// The DB opens on import (and applies pending migrations) — only after the guard above.
const { db } = await import("../src/db.js");
const { AFP_UNO_CUOTA_SERIES_KEY, afpDisplaySeriesKey } = await import("../src/afpUnoSeries.js");
const { AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS, buildAfpDisplayRowsForFund, upsertAfpDisplayRows } = await import(
  "../src/afpUnoOfficialSync.js"
);
const { listAfpFundAccounts } = await import("../src/afpAccounts.js");
const { afpCuotasCumulativeThroughDate, latestAfpUnoFundUnitRowOnOrBeforeForDisplay, revalueAfpAccountFromCuotas } =
  await import("../src/afpUnoValuation.js");
const { chileCalendarTodayYmd } = await import("../src/chileDate.js");
const { monthEndsBetweenInclusive } = await import("../src/calendarMonth.js");
const { recordContributionPeriods } = await import("../src/pensionContributionPeriods.js");
const { accountMarkClpAtYmd } = await import("../src/accountMarkClpAtYmd.js");
const { pensionLedgerNote, shapePensionLedgerRows } = await import("../src/pensionLedgerShape.js");
const { fundChain, fundHeldWindows, locateCertificateRows, pairFundSwitches, visibleDayOfRow } = await import(
  "../src/pensionCertificateChain.js"
);
const { FLOW_KIND_AFP_FUND_SWITCH } = await import("../src/movementFlowType.js");
const { validateTransferCreate } = await import("../src/movementTransfer.js");
const { seedNavTree } = await import("../src/seedNavTree.js");
const { reseedAccountSyncSources } = await import("../src/accountSyncSources.js");
const { clearAggregationCache, invalidateAggregationForAccountDate } = await import("../src/aggregationCache.js");
const { prettyRgbTripletForAccountId } = await import("../src/chartColorRgb.js");
type DatedCertificateRow = import("../src/pensionLedgerShape.js").DatedCertificateRow;
type LocatedCertificateRow = import("../src/pensionCertificateChain.js").LocatedCertificateRow;
type FundSwitch = import("../src/pensionCertificateChain.js").FundSwitch;

const PRIOR_FUNDS_SERIES_KEY = "afp_prior_funds_a";
const FUND = "A" as const;
const AFP_ASSET_GROUP_SLUG = "retirement_afp_afc__afp";
const LAG = AFP_UNO_DISPLAY_LAG_BUSINESS_DAYS;
const AFP_DISPLAY_NAMES: Record<string, string> = { planvital: "PlanVital", modelo: "Modelo", uno: "UNO" };
const FIRST_MONTH_END = "2017-06-30";

const cert = JSON.parse(fs.readFileSync(path.resolve(certPath), "utf8")) as { rows: PensionMovement[]; folio: string };
const today = chileCalendarTodayYmd();

function afpName(afp: string): string {
  return AFP_DISPLAY_NAMES[afp] ?? afp.charAt(0).toUpperCase() + afp.slice(1);
}
function accountName(afp: string): string {
  return `${afpName(afp)}-${FUND}`;
}
function importKey(afp: string): string {
  return `import:afp|afp=${afp}|fund=${FUND}`;
}
function fmtPesos(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function fmtCuotas(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

// ---- 0. idempotency + the account to split ----
const afpAccounts = listAfpFundAccounts();
const finalAfp = "uno";
if (afpAccounts.some((a) => a.import_key === importKey("planvital"))) {
  console.log("already applied: an account with import key", importKey("planvital"), "exists — nothing to do.");
  process.exit(0);
}
if (afpAccounts.length !== 1) {
  throw new Error(`expected exactly one afp account before the split, found ${afpAccounts.length}: ${JSON.stringify(afpAccounts)}`);
}
const unoAccount = db
  .prepare(`SELECT id, name, asset_group_id, import_key, fund_series_key, exclude_from_group_totals FROM accounts WHERE id = ?`)
  .get(afpAccounts[0]!.id) as {
  id: number;
  name: string;
  asset_group_id: number;
  import_key: string | null;
  fund_series_key: string | null;
  exclude_from_group_totals: number;
};
const assetGroup = db.prepare(`SELECT id, slug FROM asset_groups WHERE id = ?`).get(unoAccount.asset_group_id) as { id: number; slug: string };
if (assetGroup.slug !== AFP_ASSET_GROUP_SLUG) {
  throw new Error(`account ${unoAccount.id} sits on asset group ${assetGroup.slug}, not ${AFP_ASSET_GROUP_SLUG}`);
}
console.log(`AFP account ${unoAccount.id} «${unoAccount.name}» (${unoAccount.import_key}, series ${unoAccount.fund_series_key}) on asset group ${assetGroup.slug}`);

// ---- 1. locate, pair, chain ----
const afpsOnRecord = (db.prepare(`SELECT DISTINCT afp FROM pension_fund_unit_official WHERE fund = ? ORDER BY afp`).all(FUND) as { afp: string }[]).map((r) => r.afp);
const byAfp = new Map(
  afpsOnRecord.map((afp) => [
    afp,
    db.prepare(`SELECT day, unit_value_clp FROM pension_fund_unit_official WHERE afp = ? AND fund = ? ORDER BY day`).all(afp, FUND) as {
      day: string;
      unit_value_clp: number;
    }[],
  ])
);
console.log(`official fund ${FUND}: ${afpsOnRecord.join(", ")}`);
const located = locateCertificateRows(cert.rows, byAfp);
const switches = pairFundSwitches(located);
const legs = fundChain(located, switches);
const windows = fundHeldWindows(legs, LAG);
const lastLeg = legs.at(-1)!;
if (lastLeg.afp !== finalAfp) throw new Error(`the chain ends at ${lastLeg.afp}, not ${finalAfp}`);
if (lastLeg.switch_in == null) throw new Error("the chain has no switch into UNO — nothing to split");
const unoInDay = visibleDayOfRow(lastLeg.switch_in.in, LAG);
const visible = (r: LocatedCertificateRow) => visibleDayOfRow(r, LAG);
for (const s of switches) {
  console.log(
    `switch ${s.from} → ${s.to}: egreso ${s.out.cuotas} @ ${s.out.valor_cuota} = ${fmtPesos(s.out.pesos)} (official ${s.out.official_day}, shows ${visible(s.out)}); ` +
      `ingreso ${s.in.cuotas} @ ${s.in.valor_cuota} = ${fmtPesos(s.in.pesos)} (official ${s.in.official_day}, shows ${visible(s.in)}); ` +
      `ratio ${s.ratio.toFixed(6)}; credited − sold = ${s.pesos_gap >= 0 ? "+" : ""}${fmtPesos(s.pesos_gap)} (the receiving fund's first-day P/L)`
  );
}
for (const w of windows) console.log(`held ${w.afp}: ${w.from_day} → ${w.through_day ?? "today"}`);
console.log(`UNO's credit shows ${unoInDay}: rows of account ${unoAccount.id} before that day are replaced`);

// ---- 2. the «before» frame, captured before any write ----
// The pre-split account priced the earlier funds through `afp_prior_funds_a` until the day
// before UNO's credit showed and through UNO's series from then on (the rule
// `cuotaLedgerSeriesKeyForAccount` applied until the series moved to the column). The column
// rule cannot read that account at all (`afp_prior_funds_a` names no fund, so the mark path
// throws), so the old marks are computed here with the old rule: Σ cuotas × that series on or
// before the day — exactly what `liveCuotaLedgerDisplayValueClp` computed before the change.
function oldMarkClp(d: string): number {
  const cuotas = afpCuotasCumulativeThroughDate(unoAccount.id, d);
  const series = d < unoInDay ? PRIOR_FUNDS_SERIES_KEY : AFP_UNO_CUOTA_SERIES_KEY;
  const px = latestAfpUnoFundUnitRowOnOrBeforeForDisplay(series, d)?.unit_value_clp;
  if (px == null) throw new Error(`no ${series} value on or before ${d}`);
  return cuotas > 1e-9 ? Math.round(cuotas * px * 100) / 100 : 0;
}
const lastFullMonthEnd = monthEndsBetweenInclusive(FIRST_MONTH_END, today).filter((d) => d < today.slice(0, 7) + "-01").at(-1)!;
const monthEnds = monthEndsBetweenInclusive(FIRST_MONTH_END, lastFullMonthEnd);
const oldByDay = new Map<string, number>();
for (const d of monthEnds) oldByDay.set(d, oldMarkClp(d));
// Today reads the stored valuation first (its sync stamps one from the same cuotas × px), the
// path the split leaves untouched — the live server before the apply shows this figure.
const oldTodayDisplayed = accountMarkClpAtYmd(unoAccount.id, today)?.value_clp;
if (oldTodayDisplayed == null) throw new Error(`account ${unoAccount.id} has no value today`);
const oldTodayLedger = oldMarkClp(today);
const cuotasBefore = afpCuotasCumulativeThroughDate(unoAccount.id, today);
console.log(`before: ${cuotasBefore.toFixed(4)} cuotas today; displayed ${fmtPesos(oldTodayDisplayed)}, ledger × UNO ${fmtPesos(oldTodayLedger)}`);

// ---- 3. write ----
type NewAccount = { id: number; afp: string; name: string; series_key: string; first_day: string };
const created: NewAccount[] = [];
const accountIdByAfp = new Map<string, number>([[finalAfp, unoAccount.id]]);

function stripLocated(r: LocatedCertificateRow): DatedCertificateRow {
  const { afp: _afp, official_day, ...rest } = r;
  return { ...rest, factor: 1, day: visibleDayOfRow({ official_day }, LAG) };
}

function insertLedgerRows(accountId: number, rows: ReturnType<typeof shapePensionLedgerRows>["rows"]): number {
  const insert = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, ?)`
  );
  for (const r of rows) {
    const res = insert.run(accountId, r.pesos, r.occurred_on, `${pensionLedgerNote(r)} | certificado ${cert.folio}`, r.cuotas);
    if (r.kind !== "withdrawal") recordContributionPeriods(Number(res.lastInsertRowid), r.periods);
  }
  return rows.length;
}

function createFundAccount(afp: string, firstDay: string, throughDay: string): NewAccount {
  const key = importKey(afp);
  const seriesKey = afpDisplaySeriesKey(afp, FUND);
  const dup = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(key) as { id: number } | undefined;
  if (dup) throw new Error(`an account with import key ${key} already exists (id ${dup.id}) — a half-applied split?`);
  const seriesRows = db.prepare(`SELECT COUNT(*) AS n FROM fund_unit_daily WHERE series_key = ?`).get(seriesKey) as { n: number };
  if (seriesRows.n > 0) throw new Error(`series ${seriesKey} already holds ${seriesRows.n} rows — a half-applied split?`);
  const name = accountName(afp);
  const res = db
    .prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, import_key, exclude_from_group_totals, fund_series_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(unoAccount.asset_group_id, name, key, key, unoAccount.exclude_from_group_totals, seriesKey);
  const id = Number(res.lastInsertRowid);
  db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(prettyRgbTripletForAccountId(id), id);
  const display = buildAfpDisplayRowsForFund(afp, FUND, firstDay, throughDay);
  const written = upsertAfpDisplayRows(seriesKey, afp, display, false);
  console.log(`account ${id} «${name}» (${key}): series ${seriesKey} ${display[0]!.day} → ${display.at(-1)!.day} (${written.written} rows)`);
  return { id, afp, name, series_key: seriesKey, first_day: firstDay };
}

function insertSwitch(s: FundSwitch): number {
  const from = accountIdByAfp.get(s.from);
  const to = accountIdByAfp.get(s.to);
  if (from == null || to == null) throw new Error(`switch ${s.from} → ${s.to}: no account for one side`);
  const occurredOn = visible(s.in);
  const note =
    `Traspaso AFP ${afpName(s.from)} → ${afpName(s.to)} — ${fmtPesos(s.out.pesos)} pesos, ` +
    `${fmtCuotas(s.out.cuotas)} → ${fmtCuotas(s.in.cuotas)} cuotas; ${afpName(s.to)} acreditó ${fmtPesos(s.in.pesos)} | certificado ${cert.folio}`;
  const input = {
    from_account_id: from,
    to_account_id: to,
    occurred_on: occurredOn,
    note,
    amount: s.out.pesos,
    currency: "clp" as const,
    counter_amount: null,
    counter_currency: null,
    units_delta: s.out.cuotas,
    counter_units_delta: s.in.cuotas,
    flow_kind: FLOW_KIND_AFP_FUND_SWITCH,
    ticker: null,
  };
  validateTransferCreate(input);
  const res = db
    .prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, counter_units_delta, flow_kind)
       VALUES (?, ?, ?, 'clp', ?, ?, ?, ?, ?)`
    )
    .run(from, to, input.amount, occurredOn, note, input.units_delta, input.counter_units_delta, input.flow_kind);
  const id = Number(res.lastInsertRowid);
  console.log(`switch ${s.from} → ${s.to}: movement ${id} on ${occurredOn}, ${fmtPesos(s.out.pesos)} pesos, ${s.out.cuotas} → ${s.in.cuotas} cuotas (gap ${s.pesos_gap >= 0 ? "+" : ""}${fmtPesos(s.pesos_gap)})`);
  return id;
}

function write(): void {
  // Earlier funds: account, series, rows, net check.
  for (const leg of legs) {
    if (!leg.switch_out) continue;
    const w = windows.find((x) => x.afp === leg.afp)!;
    const acct = createFundAccount(leg.afp, w.from_day, w.through_day!);
    accountIdByAfp.set(leg.afp, acct.id);
    created.push(acct);
    const shaped = shapePensionLedgerRows(leg.rows.map(stripLocated));
    if (shaped.pending.length > 0) throw new Error(`${leg.afp}: rows with no visible day: ${JSON.stringify(shaped.pending)}`);
    const n = insertLedgerRows(acct.id, shaped.rows);
    const sum = shaped.rows.reduce((s, r) => s + r.cuotas, 0);
    const inbound = leg.switch_in?.in.cuotas ?? 0;
    if (Math.abs(sum + inbound - leg.switch_out.out.cuotas) >= 0.005) {
      throw new Error(`${leg.afp}: ledger rows ${sum.toFixed(4)} + ${inbound} credited ≠ ${leg.switch_out.out.cuotas} sold`);
    }
    console.log(`  ${n} rows, ${sum.toFixed(4)} cuotas + ${inbound} credited by its switch in = ${leg.switch_out.out.cuotas} sold`);
  }
  // Switches.
  for (const s of switches) insertSwitch(s);

  // The UNO account: replace the pre-credit rows, drop the pre-credit valuations and the
  // synthetic series, re-declare identity and series.
  const oldRows = db
    .prepare(`SELECT id, occurred_on, units_delta FROM movements WHERE account_id = ? AND occurred_on < ? ORDER BY occurred_on, id`)
    .all(unoAccount.id, unoInDay) as { id: number; occurred_on: string; units_delta: number | null }[];
  const oldIds = oldRows.map((r) => r.id);
  const oldSum = oldRows.reduce((s, r) => s + (r.units_delta ?? 0), 0);
  if (oldIds.length > 0) {
    const ph = oldIds.map(() => "?").join(",");
    // Children that do not cascade would refuse the delete, and children that do would be
    // lost silently: none of them may reference these rows (the contribution periods cascade
    // by design — they belong to the rows that replace them).
    for (const [table, col] of [
      ["payroll_work_earnings", "movement_id"],
      ["checking_income_movement_overrides", "movement_id"],
      ["f22_settlements", "movement_id"],
      ["expense_deposit_links", "deposit_movement_id"],
      ["movement_mirror_merges", "transfer_movement_id"],
    ] as const) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IN (${ph})`).get(...oldIds) as { n: number }).n;
      if (n > 0) throw new Error(`${n} ${table} rows reference the account's pre-credit movements`);
    }
    db.prepare(`DELETE FROM movements WHERE id IN (${ph})`).run(...oldIds);
  }
  console.log(
    `account ${unoAccount.id}: deleted ${oldRows.length} rows before ${unoInDay} (${oldSum.toFixed(4)} converted cuotas; the switch credits ${lastLeg.switch_in!.in.cuotas})`
  );
  if (Math.abs(oldSum - lastLeg.switch_in!.in.cuotas) >= 0.00005) {
    throw new Error(`the deleted rows held ${oldSum.toFixed(4)} cuotas, not the ${lastLeg.switch_in!.in.cuotas} UNO credited`);
  }
  const unoEarly = shapePensionLedgerRows(lastLeg.rows.map(stripLocated)).rows.filter((r) => r.occurred_on < unoInDay);
  const n = insertLedgerRows(unoAccount.id, unoEarly);
  console.log(`account ${unoAccount.id}: ${n} UNO-priced rows before ${unoInDay} inserted`);
  const vals = db.prepare(`DELETE FROM valuations WHERE account_id = ? AND as_of_date < ?`).run(unoAccount.id, unoInDay);
  console.log(`account ${unoAccount.id}: ${vals.changes} stored valuations before ${unoInDay} deleted`);
  db.prepare(`UPDATE accounts SET name = ?, import_key = ?, notes = ?, fund_series_key = ? WHERE id = ?`).run(
    accountName(finalAfp),
    importKey(finalAfp),
    importKey(finalAfp),
    AFP_UNO_CUOTA_SERIES_KEY,
    unoAccount.id
  );
  const prior = db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(PRIOR_FUNDS_SERIES_KEY);
  console.log(`series ${PRIOR_FUNDS_SERIES_KEY}: ${prior.changes} rows deleted`);

  const cuotasAfter = afpCuotasCumulativeThroughDate(unoAccount.id, today);
  if (Math.abs(cuotasAfter - cuotasBefore) >= 0.00005) {
    throw new Error(`account ${unoAccount.id} holds ${cuotasAfter.toFixed(4)} cuotas after the split, ${cuotasBefore.toFixed(4)} before`);
  }
  // The remaining stored month-ends are UNO's own: re-value only when one moved.
  const reval = revalueAfpAccountFromCuotas({ accountId: unoAccount.id, dryRun: true });
  const moved = reval.lines.filter((l) => {
    const m = /value=([-\d.]+)\tprev=([-\d.]+)/.exec(l);
    return m != null && Math.abs(Number(m[1]) - Number(m[2])) > 0.5;
  });
  if (moved.length > 0) {
    revalueAfpAccountFromCuotas({ accountId: unoAccount.id, dryRun: false });
    console.log(`account ${unoAccount.id}: ${moved.length} of ${reval.updated} stored month-ends re-valued:`);
    for (const l of moved.slice(0, 10)) console.log(`  ${l}`);
  } else {
    console.log(`account ${unoAccount.id}: ${reval.updated} stored month-ends unchanged (${reval.skipped} skipped)`);
  }

  // Nav tree, sync sources, caches.
  seedNavTree();
  for (const id of [unoAccount.id, ...created.map((a) => a.id)]) reseedAccountSyncSources(id);
  const earliest = [...created.map((a) => a.first_day), unoInDay].sort()[0]!;
  for (const id of [unoAccount.id, ...created.map((a) => a.id)]) invalidateAggregationForAccountDate(id, earliest);
  clearAggregationCache();
}

function report(): void {
  const ids = [...created.map((a) => a.id), unoAccount.id];
  console.log("\naccount                      rows  legs    cuotas   first day   last day    series");
  for (const id of ids) {
    const a = db.prepare(`SELECT id, name, fund_series_key FROM accounts WHERE id = ?`).get(id) as { id: number; name: string; fund_series_key: string };
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`).get(id) as { n: number };
    const legsN = db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE from_account_id = ? OR to_account_id = ?`).get(id, id) as { n: number };
    const span = db
      .prepare(`SELECT MIN(occurred_on) AS lo, MAX(occurred_on) AS hi FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`)
      .get(id, id, id) as { lo: string; hi: string };
    const series = db.prepare(`SELECT MIN(day) AS lo, MAX(day) AS hi, COUNT(*) AS n FROM fund_unit_daily WHERE series_key = ?`).get(a.fund_series_key) as {
      lo: string;
      hi: string;
      n: number;
    };
    const cuotas = afpCuotasCumulativeThroughDate(id, today);
    console.log(
      `${`${a.id} ${a.name}`.padEnd(28)} ${String(rows.n).padStart(4)} ${String(legsN.n).padStart(5)} ${cuotas.toFixed(4).padStart(9)}   ${span.lo}  ${span.hi}  ${a.fund_series_key} ${series.lo} → ${series.hi} (${series.n})`
    );
  }
  const nav = db
    .prepare(
      `SELECT g.slug, a.id, a.name FROM portfolio_group_items i JOIN portfolio_groups g ON g.id = i.group_id JOIN accounts a ON a.id = i.account_id
       WHERE i.account_id IN (${ids.map(() => "?").join(",")}) ORDER BY i.sort_order`
    )
    .all(...ids) as { slug: string; id: number; name: string }[];
  console.log(`nav: ${nav.map((n) => `${n.id} ${n.name} under ${n.slug}`).join("; ")}`);

  // Month-ends: the one account before vs Σ of the three after.
  const transit = switches.map((s) => ({ from: visible(s.out), to: visible(s.in) }));
  const inTransit = (d: string) => transit.some((t) => d >= t.from && d <= t.to);
  console.log(`\nmonth-end     before (one account)   after (Σ ${ids.length} accounts)      diff`);
  const flagged: string[] = [];
  let maxAbs = 0;
  let maxAt = "";
  for (const d of monthEnds) {
    const old = oldByDay.get(d)!;
    let sum = 0;
    const parts: string[] = [];
    for (const id of ids) {
      const v = accountMarkClpAtYmd(id, d)?.value_clp ?? 0;
      sum += v;
      if (v !== 0) parts.push(`${id}:${fmtPesos(v)}`);
    }
    const diff = sum - old;
    if (Math.abs(diff) > maxAbs) {
      maxAbs = Math.abs(diff);
      maxAt = d;
    }
    const flag = Math.abs(diff) > 1 && !inTransit(d) ? "  <-- outside the transit windows" : "";
    if (flag) flagged.push(`${d} ${diff.toFixed(2)}`);
    console.log(`${d}  ${old.toFixed(0).padStart(20)} ${sum.toFixed(0).padStart(22)} ${diff.toFixed(2).padStart(10)}  ${parts.join(" ")}${flag}`);
  }
  console.log(`${monthEnds.length} month-ends; largest |diff| ${maxAbs.toFixed(2)} on ${maxAt || "—"}; ${flagged.length} above 1 peso outside the transit windows${flagged.length ? ": " + flagged.join(", ") : ""}`);

  let todaySum = 0;
  for (const id of ids) todaySum += accountMarkClpAtYmd(id, today)?.value_clp ?? 0;
  const newTodayLedger = afpCuotasCumulativeThroughDate(unoAccount.id, today) * (latestAfpUnoFundUnitRowOnOrBeforeForDisplay(AFP_UNO_CUOTA_SERIES_KEY, today)?.unit_value_clp ?? 0);
  console.log(`today ${today}: displayed before ${fmtPesos(oldTodayDisplayed!)} after ${fmtPesos(todaySum)}; ledger × UNO before ${fmtPesos(oldTodayLedger)} after ${fmtPesos(newTodayLedger)}`);
  if (Math.abs(todaySum - oldTodayDisplayed!) > 0.5) throw new Error(`today's value changed: ${oldTodayDisplayed} → ${todaySum}`);
  if (Math.abs(newTodayLedger - oldTodayLedger) > 0.5) throw new Error(`today's ledger value changed: ${oldTodayLedger} → ${newTodayLedger}`);
}

const ROLLBACK = new Error("rollback (report only)");
try {
  db.transaction(() => {
    write();
    report();
    if (!APPLY) throw ROLLBACK;
  }).immediate();
  console.log("APPLIED.");
} catch (e) {
  if (e !== ROLLBACK) throw e;
  console.log("report only — nothing written (pass --apply).");
}
