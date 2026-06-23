/**
 * Compare pre-2020 monthly expense categories from `flujos-Gasto mensual.csv`
 * against app gastos (CC + checking) and print proposed synthetic rows.
 *
 *   npm run propose:synthetic-gastos-from-excel -w nw-tracker-server
 *   npm run propose:synthetic-gastos-from-excel -w nw-tracker-server -- --apply
 *   npm run propose:synthetic-gastos-from-excel -w nw-tracker-server -- --repair-bills-split-2019
 */
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import {
  monthEndDate,
  monthKey,
  numCsv,
  parseSheetMonthCell,
  readSemicolonCsv,
  type MonthKey,
} from "../src/cfraserCsv.js";
import { ymCompare } from "../src/calendarMonth.js";
import { countsTowardCcExpenseGastosMes } from "../src/ccExpenseCategories.js";
import { db } from "../src/db.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";

const CSV_BASENAME = "flujos-Gasto mensual.csv";

/** Excel column indices (semicolon CSV). */
const COL = {
  month: 0,
  gastoReal: 12,
  gasto: 13,
  supermarket: 15,
  fun: 16,
  takeout: 17,
  clothes: 18,
  others: 19,
  bills: 20,
  drugs: 21,
  healthcare: 22,
  transport: 23,
  cabify: 24,
  scooters: 25,
  delivery: 26,
} as const;

const GAP_SLUGS = [
  "supermarket",
  "fun",
  "food",
  "clothes",
  "others",
  "bills",
  "trees",
  "healthcare",
  "transportation",
] as const;

type GapSlug = (typeof GAP_SLUGS)[number];

type SyntheticCategorySlug = GapSlug | "subscriptions";

/** Aug–Dec 2019 cuentas synthetics split into rent / utilities (excel cuentas total preserved). */
const BILLS_SPLIT_MONTHS_AUG_DEC_2019 = new Set<MonthKey>([
  "2019-08",
  "2019-09",
  "2019-10",
  "2019-11",
  "2019-12",
]);

const BILLS_SPLIT_RENT_CLP = 600_000;
const BILLS_SPLIT_VTR_CLP = 10_990;
const BILLS_SPLIT_AGUAS_CLP = 6_000;

/** Monthly cuentas breakdown (Aug–Dec 2019). Enel omitted → remainder vs excel cuentas total. */
const BILLS_SPLIT_BY_MONTH: Record<
  MonthKey,
  { gastos_comunes: number; enel?: number }
> = {
  "2019-08": { gastos_comunes: 94_595 },
  "2019-09": { gastos_comunes: 194_857, enel: 19_643 },
  "2019-10": { gastos_comunes: 188_206, enel: 17_159 },
  "2019-11": { gastos_comunes: 192_574, enel: 15_876 },
  "2019-12": { gastos_comunes: 190_224 },
};

/** Excel cuentas included streaming subs; later CC data has Spotify (2021+). */
const BILLS_EXCEL_SUBSCRIPTION_NOTE_KEY = "spotify";
const BILLS_EXCEL_SUBSCRIPTION_MERCHANT = "Spotify (sintético)";

function proposeBillsSplitRows(
  monthKey: MonthKey,
  spent_on: string,
  excelCuentasTotal: number
): ProposedRow[] {
  const split = BILLS_SPLIT_BY_MONTH[monthKey];
  if (!split) {
    throw new Error(`missing bills split override for ${monthKey}`);
  }

  const fixed: Array<{ key: string; label: string; amount: number }> = [
    { key: "rent", label: "Arriendo (sintético)", amount: BILLS_SPLIT_RENT_CLP },
    {
      key: "gastos_comunes",
      label: "Gastos comunes (sintético)",
      amount: split.gastos_comunes,
    },
    { key: "vtr", label: "VTR (sintético)", amount: BILLS_SPLIT_VTR_CLP },
    { key: "aguas_andinas", label: "Aguas Andinas (sintético)", amount: BILLS_SPLIT_AGUAS_CLP },
  ];

  const rows: ProposedRow[] = fixed.map((part) => ({
    spent_on,
    category_slug: "bills",
    amount_clp: part.amount,
    note: `synthetic:excel-gap|${monthKey}|bills|${part.key}`,
    merchant: part.label,
  }));

  const fixedSum = fixed.reduce((s, p) => s + p.amount, 0);
  const enelAmount = split.enel != null ? split.enel : excelCuentasTotal - fixedSum;

  if (!Number.isFinite(enelAmount) || enelAmount < 0) {
    throw new Error(
      `${monthKey}: bills split enel would be ${enelAmount} (excel cuentas ${excelCuentasTotal}, fixed sum ${fixedSum})`
    );
  }

  if (enelAmount > 0) {
    rows.push({
      spent_on,
      category_slug: "bills",
      amount_clp: Math.round(enelAmount),
      note: `synthetic:excel-gap|${monthKey}|bills|enel`,
      merchant: "Enel (sintético)",
    });
  }

  const billsSum = rows.reduce((s, r) => s + r.amount_clp, 0);
  const subscriptionGap = Math.round(excelCuentasTotal) - billsSum;
  if (subscriptionGap > 0) {
    rows.push({
      spent_on,
      category_slug: "subscriptions",
      amount_clp: subscriptionGap,
      note: `synthetic:excel-gap|${monthKey}|subscriptions|${BILLS_EXCEL_SUBSCRIPTION_NOTE_KEY}`,
      merchant: BILLS_EXCEL_SUBSCRIPTION_MERCHANT,
    });
  } else if (subscriptionGap < 0) {
    throw new Error(
      `${monthKey}: bills split (${billsSum}) exceeds excel cuentas (${excelCuentasTotal}) by ${-subscriptionGap}`
    );
  }

  return rows;
}

function usesAugDec2019BillsSplit(monthKey: MonthKey): boolean {
  return BILLS_SPLIT_MONTHS_AUG_DEC_2019.has(monthKey);
}

type ExcelMonthRow = {
  monthKey: MonthKey;
  gastoTotal: number | null;
  bySlug: Record<GapSlug, number>;
  cabify: number;
  scooters: number;
};

type ProposedRow = {
  spent_on: string;
  category_slug: SyntheticCategorySlug;
  amount_clp: number;
  note: string;
  merchant: string;
};

function sumPos(...vals: (number | null)[]): number {
  let s = 0;
  for (const v of vals) {
    if (v != null && v > 0) s += v;
  }
  return s;
}

function parseExcelRows(csvPath: string): ExcelMonthRow[] {
  const rows = readSemicolonCsv(csvPath);
  if (rows.length < 2) return [];

  const out: ExcelMonthRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const d = parseSheetMonthCell(row[COL.month] ?? "");
    if (!d) continue;

    const mk = monthKey(d);
    const gastoTotal = numCsv(row[COL.gastoReal]) ?? numCsv(row[COL.gasto]);

    const cabify = numCsv(row[COL.cabify]) ?? 0;
    const scooters = numCsv(row[COL.scooters]) ?? 0;
    const transport = numCsv(row[COL.transport]) ?? 0;

    if (cabify + scooters > transport + 1 && transport > 0) {
      console.warn(
        `WARN ${mk}: Cabify (${cabify}) + Scooters (${scooters}) > Transporte (${transport}) — subcols may overlap differently in sheet`
      );
    }

    out.push({
      monthKey: mk,
      gastoTotal,
      bySlug: {
        supermarket: numCsv(row[COL.supermarket]) ?? 0,
        fun: numCsv(row[COL.fun]) ?? 0,
        food: sumPos(numCsv(row[COL.takeout]), numCsv(row[COL.delivery])),
        clothes: numCsv(row[COL.clothes]) ?? 0,
        others: numCsv(row[COL.others]) ?? 0,
        bills: numCsv(row[COL.bills]) ?? 0,
        trees: numCsv(row[COL.drugs]) ?? 0,
        healthcare: numCsv(row[COL.healthcare]) ?? 0,
        transportation: transport,
      },
      cabify: cabify > 0 ? cabify : 0,
      scooters: scooters > 0 ? scooters : 0,
    });
  }
  return out;
}

function aggregateAppGastosByMonthCategory(): Map<string, number> {
  const payload = buildFlowsCreditCardExpensesPayload();
  const totals = new Map<string, number>();

  for (const line of payload.lines) {
    if (line.amount_clp <= 0) continue;
    if (!countsTowardCcExpenseGastosMes(line.category_slug, line)) continue;
    if (!GAP_SLUGS.includes(line.category_slug as GapSlug)) continue;

    const key = `${line.expense_month}|${line.category_slug}`;
    totals.set(key, (totals.get(key) ?? 0) + line.amount_clp);
  }
  return totals;
}

function appTotal(totals: Map<string, number>, monthKey: MonthKey, slug: GapSlug): number {
  return totals.get(`${monthKey}|${slug}`) ?? 0;
}

function proposeTransportRows(
  monthKey: MonthKey,
  gap: number,
  cabify: number,
  scooters: number
): ProposedRow[] {
  if (gap <= 0) return [];

  const spent_on = monthEndDate(monthKey);
  const baseNote = `synthetic:excel-gap|${monthKey}|transportation`;

  if (cabify <= 0 && scooters <= 0) {
    return [
      {
        spent_on,
        category_slug: "transportation",
        amount_clp: Math.round(gap),
        note: baseNote,
        merchant: "Transporte (sintético)",
      },
    ];
  }

  const rows: ProposedRow[] = [];
  let remaining = gap;

  const cabifyAmt = cabify > 0 ? Math.min(remaining, cabify) : 0;
  if (cabifyAmt > 0) {
    rows.push({
      spent_on,
      category_slug: "transportation",
      amount_clp: Math.round(cabifyAmt),
      note: `${baseNote}|cabify`,
      merchant: "Cabify (sintético)",
    });
    remaining -= cabifyAmt;
  }

  const scooterAmt = scooters > 0 ? Math.min(remaining, scooters) : 0;
  if (scooterAmt > 0) {
    rows.push({
      spent_on,
      category_slug: "transportation",
      amount_clp: Math.round(scooterAmt),
      note: `${baseNote}|scooters`,
      merchant: "Scooters (sintético)",
    });
    remaining -= scooterAmt;
  }

  if (remaining > 0) {
    rows.push({
      spent_on,
      category_slug: "transportation",
      amount_clp: Math.round(remaining),
      note: `${baseNote}|gas`,
      merchant: "Combustible / auto (sintético)",
    });
  }

  return rows;
}

function proposeForMonth(
  excel: ExcelMonthRow,
  appTotals: Map<string, number>,
  includeBills: boolean
): ProposedRow[] {
  const proposed: ProposedRow[] = [];
  const mk = excel.monthKey;
  const spent_on = monthEndDate(mk);

  for (const slug of GAP_SLUGS) {
    if (slug === "bills" && !includeBills) continue;
    if (slug === "transportation") continue;

    const excelAmt = excel.bySlug[slug];
    const appAmt = appTotal(appTotals, mk, slug);
    const gap = Math.max(0, excelAmt - appAmt);
    if (gap <= 0) continue;

    if (slug === "bills" && usesAugDec2019BillsSplit(mk)) {
      proposed.push(...proposeBillsSplitRows(mk, spent_on, excelAmt));
      continue;
    }

    proposed.push({
      spent_on,
      category_slug: slug,
      amount_clp: Math.round(gap),
      note: `synthetic:excel-gap|${mk}|${slug}`,
      merchant: `${slug} (sintético)`,
    });
  }

  const transportGap = Math.max(
    0,
    excel.bySlug.transportation - appTotal(appTotals, mk, "transportation")
  );
  proposed.push(...proposeTransportRows(mk, transportGap, excel.cabify, excel.scooters));

  return proposed;
}

function formatClp(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}

function printComparisonTable(
  title: string,
  months: ExcelMonthRow[],
  appTotals: Map<string, number>,
  includeBills: boolean
) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(title);
  console.log("=".repeat(72));

  for (const excel of months) {
    const mk = excel.monthKey;
    console.log(`\n--- ${mk} (excel gasto total: ${excel.gastoTotal != null ? formatClp(excel.gastoTotal) : "—"}) ---`);
    console.log(
      `${"category".padEnd(16)} ${"excel".padStart(12)} ${"app".padStart(12)} ${"gap".padStart(12)}`
    );

    for (const slug of GAP_SLUGS) {
      if (slug === "bills" && !includeBills) continue;
      const excelAmt = excel.bySlug[slug];
      const appAmt = appTotal(appTotals, mk, slug);
      const gap = Math.max(0, excelAmt - appAmt);
      if (excelAmt === 0 && appAmt === 0 && gap === 0) continue;
      console.log(
        `${slug.padEnd(16)} ${formatClp(excelAmt).padStart(12)} ${formatClp(appAmt).padStart(12)} ${formatClp(gap).padStart(12)}`
      );
    }
  }
}

function printProposedRows(title: string, rows: ProposedRow[]) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(title);
  console.log(`Proposed rows: ${rows.length} | Total CLP: ${formatClp(rows.reduce((s, r) => s + r.amount_clp, 0))}`);
  console.log("=".repeat(72));
  console.log(`${"spent_on".padEnd(12)} ${"slug".padEnd(16)} ${"amount_clp".padStart(12)}  note`);
  for (const r of rows) {
    console.log(
      `${r.spent_on.padEnd(12)} ${r.category_slug.padEnd(16)} ${formatClp(r.amount_clp).padStart(12)}  ${r.note}`
    );
  }
}

function filterMonths(
  rows: ExcelMonthRow[],
  pred: (mk: MonthKey) => boolean
): ExcelMonthRow[] {
  return rows.filter((r) => pred(r.monthKey)).sort((a, b) => ymCompare(a.monthKey, b.monthKey));
}

function applyProposedRows(rows: ProposedRow[]) {
  const noteExists = db.prepare(`SELECT 1 AS ok FROM expense_entries WHERE note = ? LIMIT 1`);
  const ins = db.prepare(
    `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`
  );
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    if (noteExists.get(row.note)) {
      skipped += 1;
      continue;
    }
    ins.run(row.amount_clp, row.spent_on, row.category_slug, row.note);
    inserted += 1;
  }
  console.log(`\nApply: inserted=${inserted}, skipped_existing_note=${skipped}`);
}

/** Replace Aug–Dec 2019 single-line cuentas synthetics with rent/utilities split. */
function repairAugDec2019BillsSplit(excelRows: ExcelMonthRow[]) {
  let deleted = 0;
  for (const mk of BILLS_SPLIT_MONTHS_AUG_DEC_2019) {
    for (const pattern of [
      `synthetic:excel-gap|${mk}|bills%`,
      `synthetic:excel-gap|${mk}|subscriptions%`,
    ]) {
      deleted += db
        .prepare(`DELETE FROM expense_entries WHERE note LIKE ?`)
        .run(pattern).changes;
    }
  }

  const months = filterMonths(excelRows, (mk) => usesAugDec2019BillsSplit(mk));
  const ins = db.prepare(
    `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`
  );

  const rows: ProposedRow[] = [];
  for (const excel of months) {
    const total = Math.round(excel.bySlug.bills);
    if (total <= 0) continue;
    rows.push(...proposeBillsSplitRows(excel.monthKey, monthEndDate(excel.monthKey), total));
  }

  for (const row of rows) {
    ins.run(row.amount_clp, row.spent_on, row.category_slug, row.note);
  }

  console.log(
    `\nRepair Aug–Dec 2019 bills: deleted=${deleted}, inserted=${rows.length} split row(s)`
  );
  for (const excel of months) {
    const split = rows.filter(
      (r) =>
        r.note.includes(`|${excel.monthKey}|bills|`) ||
        r.note.includes(`|${excel.monthKey}|subscriptions|`)
    );
    const sum = split.reduce((s, r) => s + r.amount_clp, 0);
    console.log(
      `  ${excel.monthKey}: excel cuentas ${formatClp(excel.bySlug.bills)} → split sum ${formatClp(sum)} (${split.length} lines)`
    );
    for (const r of split) {
      console.log(`    ${formatClp(r.amount_clp).padStart(10)}  ${r.merchant}`);
    }
  }
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes("--apply"),
    repairBillsSplit2019: argv.includes("--repair-bills-split-2019"),
  };
}

function main() {
  const { apply, repairBillsSplit2019 } = parseArgs(process.argv.slice(2));
  const csvPath = path.join(resolveCfraserCsvDir(), CSV_BASENAME);
  console.log(`Reading excel: ${csvPath}`);

  const excelRows = parseExcelRows(csvPath);
  if (excelRows.length === 0) {
    console.error(`No monthly rows parsed from ${csvPath}`);
    process.exit(1);
  }

  if (repairBillsSplit2019) {
    repairAugDec2019BillsSplit(excelRows);
    console.log("\nDone.");
    return;
  }

  console.log(`Parsed ${excelRows.length} excel months (${excelRows[0]!.monthKey} … ${excelRows[excelRows.length - 1]!.monthKey})`);
  console.log("Loading app gastos from SQLite…");

  const appTotals = aggregateAppGastosByMonthCategory();

  const julDec2019 = filterMonths(
    excelRows,
    (mk) => ymCompare(mk, "2019-07") >= 0 && ymCompare(mk, "2019-12") <= 0
  );
  const preAug2017 = filterMonths(excelRows, (mk) => ymCompare(mk, "2017-08") <= 0);

  printComparisonTable(
    "SECTION 1 — Jul–Dec 2019 (excel vs app vs gap; includes bills)",
    julDec2019,
    appTotals,
    true
  );

  const proposed2019 = julDec2019.flatMap((row) => proposeForMonth(row, appTotals, true));
  printProposedRows("SECTION 1 — Proposed synthetic expenses (Jul–Dec 2019)", proposed2019);

  printComparisonTable(
    "SECTION 2 — Aug 2017 and earlier (excel vs app vs gap; excludes bills)",
    preAug2017,
    appTotals,
    false
  );

  const proposedPre2017 = preAug2017.flatMap((row) => proposeForMonth(row, appTotals, false));
  printProposedRows(
    "SECTION 2 — Proposed synthetic expenses (Aug 2017 and earlier)",
    proposedPre2017
  );

  const allProposed = [...proposed2019, ...proposedPre2017];
  if (apply) {
    applyProposedRows(allProposed);
    console.log("\nDone. Synthetic rows inserted into expense_entries.");
  } else {
    console.log("\nDone. No database changes were made. Pass --apply to insert proposed rows.");
  }
}

main();
