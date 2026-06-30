/**
 * Propose plausible categories for EXISTING uncategorized CC expense lines (≤ 2021-10),
 * guided by the personal spreadsheet's monthly category totals.
 *
 * Unlike propose-synthetic-gastos (which inserts synthetic rows), this assigns a category
 * to each real uncategorized line so per-category monthly totals approximate the spreadsheet.
 *
 * GIRO EN CAJERO / MACH lines are "cash splittable": their amount is distributed across
 * multiple categories (one `cc_expense_line_splits` row per portion) so a single ATM
 * withdrawal can fill gaps in trees, healthcare, food, etc. simultaneously.
 *
 *   npm run propose:categorize-uncat -w nw-tracker-server            # dry run
 *   npm run propose:categorize-uncat -w nw-tracker-server -- --apply # write assignments
 *   ... -- --revert                                                   # dry-run revert
 *   ... -- --revert --apply                                           # apply revert
 *   ... -- --month 2020-09                                            # limit to one month
 *   ... -- --merchants                                                # merchant→category map
 */
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import {
  monthKey,
  numCsv,
  parseSheetMonthCell,
  readSemicolonCsv,
  type MonthKey,
} from "../src/cfraserCsv.js";
import { ymCompare } from "../src/calendarMonth.js";
import { countsTowardCcExpenseGastosMes } from "../src/ccExpenseCategories.js";
import { assignFlowExpenseLineCategory, type FlowExpenseLineCategorySource } from "../src/assignFlowExpenseLineCategory.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";
import {
  insertLineSplits,
  deleteAllExcelGapSplits,
  countExcelGapSplits,
  EXCEL_GAP_SPLIT_NOTE_PREFIX,
} from "../src/ccExpenseLineSplits.js";

const CSV_BASENAME = "flujos-Gasto mensual.csv";
const MAX_MONTH: MonthKey = "2021-10";

const COL = {
  month: 0,
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

const WILDCARD_TARGET_SLUGS = [
  "supermarket",
  "food",
  "transportation",
  "healthcare",
  "clothes",
  "fun",
  "trees",
  "others",
] as const;

type WildcardTargetSlug = (typeof WILDCARD_TARGET_SLUGS)[number];

type ExcelTargets = Partial<Record<string, number>>;

function parseExcelTargets(csvPath: string): Map<MonthKey, ExcelTargets> {
  const rows = readSemicolonCsv(csvPath);
  const out = new Map<MonthKey, ExcelTargets>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const d = parseSheetMonthCell(row[COL.month] ?? "");
    if (!d) continue;
    const mk = monthKey(d);
    if (ymCompare(mk, MAX_MONTH) > 0) continue;
    const pos = (v: number | null) => (v != null && v > 0 ? v : 0);
    out.set(mk, {
      supermarket: pos(numCsv(row[COL.supermarket])),
      fun: pos(numCsv(row[COL.fun])),
      food: pos(numCsv(row[COL.takeout])) + pos(numCsv(row[COL.delivery])),
      clothes: pos(numCsv(row[COL.clothes])),
      others: pos(numCsv(row[COL.others])),
      bills: pos(numCsv(row[COL.bills])),
      trees: pos(numCsv(row[COL.drugs])),
      healthcare: pos(numCsv(row[COL.healthcare])),
      transportation:
        pos(numCsv(row[COL.transport])) +
        pos(numCsv(row[COL.cabify])) +
        pos(numCsv(row[COL.scooters])),
    });
  }
  return out;
}

/** Months left untouched (already over target / noisy one-offs). */
const IGNORE_MONTHS = new Set<MonthKey>(["2021-08", "2021-09"]);

const MERCHANT_OVERRIDES: Record<string, string> = {
  "LA FETE CHOCOLAT": "others",
  "PAN MOSTACHO": "supermarket",
};

const FIXED_SUBSTRING_RULES: Array<{ cat: string; kw: string[] }> = [
  { cat: "others", kw: ["CORRADI DELGADO"] },
];

/** Cash transactions splittable across multiple categories (ATM / MACH). */
const CASH_SPLITTABLE_PATTERNS = [
  "GIRO EN CAJERO",
  "MACH ONE CLICK",
  "MACH WEBPAY",
];

/** Wildcard merchants that prefer specific categories first (while those still have a gap). */
const WILDCARD_PREFERRED: Array<{ match: string; order: string[] }> = [
  { match: "AGUSTINAS GIRO EN CAJERO", order: ["trees"] },
];

const SUBSCRIPTION_IF_MISSING = ["ITUNES.COM/BILL", "ITUNES.COM"];

const KEYWORD_RULES: Array<{ cat: string; kw: string[] }> = [
  { cat: "deposits", kw: ["PREVIRED"] },
  { cat: "subscriptions", kw: ["APPLE.COM", "SPOTIFY", "NETFLIX", "UDEMY", "GOOGLE *", "HBO", "DISNEY", "YOUTUBEPREMIUM", "AUDIBLE", "PATREON", "ICLOUD"] },
  { cat: "trees", kw: ["GROWSHOP", "GROW SHOP"] },
  { cat: "healthcare", kw: ["FARMACIA", "AHUM", "CRUZ VERDE", "SALCOBRAND", "MEGASALUD", "MED ", "MEDICA", "CLINICA", "DR ", "DENTAL", "LABORATORIO", "OPTICA", "REDSALUD", "INTEGRAMEDICA"] },
  { cat: "transportation", kw: ["SHELL", "COPEC", "PETROBRAS", "TERPEL", "PUNTO COPEC", "ESTACION", "PARKING", "SABA", "PARK", "AUTOPISTA", "PEAJE", "UBER", "CABIFY", "BEAT", "DIDI ", "SCOOTER", "BIRD", "LIM*RIDE", "LIMLIME", "LIME ", "METRO ", "MOVI", "COMBUSTIBLE", "GASOLINA", "PASAJE", "LATAM", "JETSMART", "SKY AIR"] },
  { cat: "supermarket", kw: ["LIDER", "LID EXPRESS", "HIP LIDER", "EXPRESS ", "JUMBO", "OK MARKET", "0K MARKET", "OKM ", "MINIMARKET", "MINI MARKET", "MARKET", "ABARROTES", "UNIMARC", "TOTTUS", "SANTA ISABEL", "ACUENTA", "MAYORISTA", "ALMACEN", "EL TRIGAL", "BUEN PAN", "COMERCIAL MONTERREY", "COMERCIAL VARGAS", "COMERCIAL DON ALFREDO", "DON CHAGO"] },
  { cat: "food", kw: ["RAPPI", "RAPP|", "PEDIDOSYA", "UBER *EATS", "UBEREATS", "MC DONALDS", "MCDONALDS", "BURGER KING", "STARBUCKS", "JUAN VALDEZ", "CASTANO", "PRONTO", "CHURRERIA", "CAFE", "COFFEE", "PASTELERIA", "HELADOS", "DONUTS", "RESTAUR", "FUENTE DE SODA", "EMPANAD", "BAKER", "DOMINO", "VENEZZIA", "MECHADA", "SANTA GULA", "MOSAICAFE", "BIG JOHN", "MILLE VOGLIE", "DI MAMMA", "PIZZ", "SUSHI", "SANGUCH", "BAR ", "GRINGOS", "LA LUCHA", "DUCK DONUTS", "STARBUCK", "COCA COLA", "OKASAN", "MAXIK", "VENEZIA", "SOL-INTI", "TIO MARIO", "LA K CEROLA", "CHOCOLAT", "JUAN MAESTRO", "DOGGIS", "TELEPIZZA", "PAPA JOHNS", "KFC", "SUBWAY", "TARRAGONA", "FUKASA", "NOLITA", "TANTA", "EMPORIO", "DELI", "GELATO", "WAFFLE", "CREPE", "PAN ", "PANADERIA"] },
  { cat: "clothes", kw: ["PARIS", "FALABELLA LOS", "DECATHLON", "DEPORTES SPARTA", "SPARTA", "H&M", "ZARA", "NIKE", "ADIDAS", "FORUS", "TRICOT", "HITES", "LA POLAR", "ROPA", "CALZADO", "LIPPI", "PATAGONIA", "NORTH FACE", "DOITE", "ANDESGEAR"] },
  { cat: "fun", kw: ["CINE", "CINEMARK", "CINEPOLIS", "HOYTS", "CASINO", "LIQUOR", "BOTILLERIA", "PUB ", "CLUB", "TEATRO", "CONCElabel", "TICKET", "PUNTOTICKET", "STEAM", "PLAYSTATION", "XBOX", "NINTENDO", "SPA "] },
  { cat: "others", kw: ["ALIEXPRESS", "AMZN", "AMAZON", "EBAY", "WISH", "ALI EXPRESS", "REGISTRO CIVIL", "SERVICIO DE REGISTRO", "REGISTRO C", "NOTARIA", "CORREOS", "PAPELAPIZ", "LAPIZ LOPEZ", "LIBRERIA", "JUMBO LIBROS", "FERRETERIA", "SODIMAC", "EASY ", "CONSTRUMART", "PARIS HOGAR", "FUNDACION", "DIFAB", "MATTER LTDA", "INCASE"] },
];

const WILDCARD_PATTERNS = [
  "TRANSF A ",
  "TRANSF. A ",
  "PAGO EN LINEA PROM. CMR FALABELLA",
  "RED BCO ESTADO",
  "COMPRA ",
  "REDELCOM",
  "SUMUP",
  "MERCADO PAGO",
  "GETITJO",
  "COMPRA FLASH",
  "COMPRA YIN JO",
  "COMPRA SILVANO",
];

const WILDCARD_AMOUNT_SPLIT: Array<{ match: string; threshold: number; low_cat: string; high_cat: string }> = [
  { match: "TRANSF. INTERNET", threshold: 30_000, low_cat: "fun", high_cat: "others" },
  { match: "TRANSF INTERNET", threshold: 30_000, low_cat: "fun", high_cat: "others" },
];

function up(s: string | null | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

type Classification =
  | { kind: "fixed"; cat: string }
  | { kind: "cashSplit" }
  | { kind: "wildcard"; preferredOrder?: string[] }
  | { kind: "subscription-if-missing" }
  | { kind: "unmatched" };

function classifyMerchant(merchant: string | null, amount: number): Classification {
  const u = up(merchant);
  if (!u) return { kind: "wildcard" };
  if (MERCHANT_OVERRIDES[u]) return { kind: "fixed", cat: MERCHANT_OVERRIDES[u]! };
  for (const rule of FIXED_SUBSTRING_RULES) {
    for (const kw of rule.kw) {
      if (u.includes(kw)) return { kind: "fixed", cat: rule.cat };
    }
  }
  for (const s of SUBSCRIPTION_IF_MISSING) {
    if (u.includes(s)) return { kind: "subscription-if-missing" };
  }
  // Cash-splittable check: before preferred/wildcard so AGUSTINAS → trees preferred doesn't conflict
  for (const p of CASH_SPLITTABLE_PATTERNS) {
    if (u.includes(p)) return { kind: "cashSplit" };
  }
  for (const w of WILDCARD_PREFERRED) {
    if (u.includes(w.match)) return { kind: "wildcard", preferredOrder: w.order };
  }
  for (const s of WILDCARD_AMOUNT_SPLIT) {
    if (u.includes(s.match)) {
      const pref = amount <= s.threshold ? s.low_cat : s.high_cat;
      return { kind: "wildcard", preferredOrder: [pref] };
    }
  }
  for (const p of WILDCARD_PATTERNS) {
    if (u.includes(p)) return { kind: "wildcard" };
  }
  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.kw) {
      if (u.includes(kw)) return { kind: "fixed", cat: rule.cat };
    }
  }
  return { kind: "unmatched" };
}

type UncatLine = {
  statement_line_id: number;
  source: FlowExpenseLineCategorySource;
  merchant: string | null;
  amount_clp: number;
  month: MonthKey;
};

function loadUncatLines(): Map<MonthKey, UncatLine[]> {
  const payload = buildFlowsCreditCardExpensesPayload();
  const byMonth = new Map<MonthKey, UncatLine[]>();
  for (const l of payload.lines as any[]) {
    if (l.amount_clp <= 0 || l.category_slug !== "unclassified") continue;
    const m = l.expense_month as MonthKey;
    if (!m || ymCompare(m, MAX_MONTH) > 0 || IGNORE_MONTHS.has(m)) continue;
    const arr = byMonth.get(m) ?? [];
    arr.push({
      statement_line_id: l.statement_line_id,
      source: l.source,
      merchant: l.merchant,
      amount_clp: l.amount_clp,
      month: m,
    });
    byMonth.set(m, arr);
  }
  return byMonth;
}

function loadCurrentClassified(): Map<string, number> {
  const payload = buildFlowsCreditCardExpensesPayload();
  const totals = new Map<string, number>();
  for (const l of payload.lines as any[]) {
    if (l.amount_clp <= 0 || l.category_slug === "unclassified") continue;
    if (!countsTowardCcExpenseGastosMes(l.category_slug, l)) continue;
    const m = l.expense_month as string;
    if (!m || ymCompare(m, MAX_MONTH) > 0) continue;
    totals.set(`${m}|${l.category_slug}`, (totals.get(`${m}|${l.category_slug}`) ?? 0) + l.amount_clp);
  }
  return totals;
}

type Assignment = {
  line: UncatLine;
  cat: string;
  via: "override" | "keyword" | "wildcard" | "unmatched-default";
};

type CashSplitAssignment = {
  line: UncatLine;
  portions: Array<{ cat: string; amount: number }>;
};

/** Greedy fill: allocate a cash line's amount across category gaps.
 *  trees has highest priority for months ≤ 2021-08; others is always last.
 *  Updates proposedByCat in place for each portion taken. */
function allocateCashSplits(
  lineAmount: number,
  mk: MonthKey,
  targets: ExcelTargets,
  proposedByCat: Map<string, number>,
  cur: (cat: string) => number
): Array<{ cat: string; amount: number }> {
  const remainingGap = (cat: string) =>
    Math.max(0, (targets[cat] ?? 0) - cur(cat) - (proposedByCat.get(cat) ?? 0));

  const isEarlyMonth = ymCompare(mk, "2021-08") <= 0;
  const candidateCats = [...WILDCARD_TARGET_SLUGS].filter((c) => c !== "others");

  candidateCats.sort((a, b) => {
    if (isEarlyMonth) {
      if (a === "trees" && b !== "trees") return -1;
      if (b === "trees" && a !== "trees") return 1;
    }
    return remainingGap(b) - remainingGap(a);
  });

  const portions: Array<{ cat: string; amount: number }> = [];
  let remaining = lineAmount;

  for (const cat of candidateCats) {
    if (remaining <= 0) break;
    const gap = Math.round(remainingGap(cat));
    if (gap <= 0) continue;
    const take = Math.min(remaining, gap);
    portions.push({ cat, amount: take });
    proposedByCat.set(cat, (proposedByCat.get(cat) ?? 0) + take);
    remaining -= take;
  }

  if (remaining > 0) {
    const othersIdx = portions.findIndex((p) => p.cat === "others");
    if (othersIdx >= 0) {
      portions[othersIdx]!.amount += remaining;
    } else {
      portions.push({ cat: "others", amount: remaining });
      proposedByCat.set("others", (proposedByCat.get("others") ?? 0) + remaining);
    }
  }

  return portions;
}

function proposeForMonth(
  mk: MonthKey,
  lines: UncatLine[],
  targets: ExcelTargets,
  currentByCat: Map<string, number>
): { assignments: Assignment[]; cashSplits: CashSplitAssignment[] } {
  const proposedByCat = new Map<string, number>();
  const cur = (cat: string) => currentByCat.get(`${mk}|${cat}`) ?? 0;
  const add = (cat: string, n: number) =>
    proposedByCat.set(cat, (proposedByCat.get(cat) ?? 0) + n);
  const remainingGap = (cat: string) =>
    Math.max(0, (targets[cat] ?? 0) - cur(cat) - (proposedByCat.get(cat) ?? 0));

  const assignments: Assignment[] = [];
  const cashSplits: CashSplitAssignment[] = [];

  type Flexible = { line: UncatLine; via: "wildcard" | "unmatched-default"; preferredOrder?: string[] };
  const flexible: Flexible[] = [];
  const cashSplittable: UncatLine[] = [];
  const subIfMissing: UncatLine[] = [];

  for (const line of lines) {
    const c = classifyMerchant(line.merchant, line.amount_clp);
    if (c.kind === "fixed") {
      assignments.push({
        line,
        cat: c.cat,
        via: up(line.merchant) in MERCHANT_OVERRIDES ? "override" : "keyword",
      });
      add(c.cat, line.amount_clp);
    } else if (c.kind === "cashSplit") {
      cashSplittable.push(line);
    } else if (c.kind === "wildcard") {
      flexible.push({ line, via: "wildcard", preferredOrder: c.preferredOrder });
    } else if (c.kind === "subscription-if-missing") {
      subIfMissing.push(line);
    } else {
      flexible.push({ line, via: "unmatched-default" });
    }
  }

  if (cur("subscriptions") <= 0) {
    for (const line of subIfMissing) {
      assignments.push({ line, cat: "subscriptions", via: "keyword" });
      add("subscriptions", line.amount_clp);
    }
  } else {
    for (const line of subIfMissing) flexible.push({ line, via: "unmatched-default" });
  }

  // Non-cash wildcards + unmatched: preferred-order items first, then largest-gap.
  // "others" is always the lowest-priority gap target so other categories close first.
  flexible.sort((a, b) => {
    const ap = a.preferredOrder ? 1 : 0;
    const bp = b.preferredOrder ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.line.amount_clp - a.line.amount_clp;
  });

  for (const item of flexible) {
    let cat: string | null = null;
    for (const pref of item.preferredOrder ?? []) {
      if (WILDCARD_TARGET_SLUGS.includes(pref as WildcardTargetSlug) && remainingGap(pref) > 0) {
        cat = pref;
        break;
      }
    }
    if (!cat) {
      let bestGap = 0;
      for (const c of WILDCARD_TARGET_SLUGS) {
        if (c === "others") continue; // others only as last resort
        const g = remainingGap(c);
        if (g > bestGap) { bestGap = g; cat = c; }
      }
      if (!cat && remainingGap("others") > 0) cat = "others";
      cat = cat ?? "others";
    }
    assignments.push({ line: item.line, cat, via: item.via });
    add(cat, item.line.amount_clp);
  }

  // Cash-splittable lines: greedy multi-category fill using remaining gaps.
  for (const line of cashSplittable) {
    const portions = allocateCashSplits(line.amount_clp, mk, targets, proposedByCat, cur);
    cashSplits.push({ line, portions });
  }

  return { assignments, cashSplits };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}

function parseArgs(argv: string[]) {
  const monthIdx = argv.indexOf("--month");
  return {
    apply: argv.includes("--apply"),
    revert: argv.includes("--revert"),
    showMerchants: argv.includes("--merchants"),
    month: monthIdx >= 0 ? (argv[monthIdx + 1] as MonthKey | undefined) : undefined,
  };
}

// ─── revert ─────────────────────────────────────────────────────────────────

type ScopedClassifiedLine = {
  statement_line_id: number;
  source: FlowExpenseLineCategorySource;
  merchant: string | null;
  amount_clp: number;
  category_slug: string;
  month: MonthKey;
};

function loadScopedClassifiedLines(): ScopedClassifiedLine[] {
  const payload = buildFlowsCreditCardExpensesPayload();
  const seen = new Map<string, ScopedClassifiedLine>();
  for (const l of payload.lines as any[]) {
    if (l.amount_clp <= 0) continue;
    if (l.category_slug === "unclassified") continue;
    if (l.source === "manual") continue; // synthetic expense_entries — not editable here
    const m = l.expense_month as MonthKey;
    if (!m || ymCompare(m, MAX_MONTH) > 0 || IGNORE_MONTHS.has(m)) continue;
    const dedupeKey = `${l.source}:${l.statement_line_id}`;
    if (!seen.has(dedupeKey)) {
      seen.set(dedupeKey, {
        statement_line_id: l.statement_line_id,
        source: l.source,
        merchant: l.merchant,
        amount_clp: l.amount_clp,
        category_slug: l.category_slug,
        month: m,
      });
    }
  }
  return [...seen.values()];
}

function shouldRevertLine(c: Classification, currentCat: string): boolean {
  switch (c.kind) {
    case "fixed":
      return currentCat === c.cat;
    case "cashSplit":
    case "wildcard":
    case "unmatched":
      return WILDCARD_TARGET_SLUGS.includes(currentCat as WildcardTargetSlug);
    case "subscription-if-missing":
      return currentCat === "subscriptions";
    default:
      return false;
  }
}

function runRevert(apply: boolean, filterMonth?: MonthKey) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`REVERT (${apply ? "apply" : "dry-run"})`);
  console.log("=".repeat(72));

  // Phase 1: splits
  const splitCount = apply ? deleteAllExcelGapSplits() : countExcelGapSplits();
  console.log(`\nPhase 1 — split rows: ${apply ? "deleted" : "would delete"} ${splitCount}`);

  // Phase 2: single-category assignments
  // When applying, splits are already gone so lines show their cc_expense_unique_purchases state.
  // When dry-run, split sub-lines may still appear; we deduplicate by statement_line_id.
  const classified = loadScopedClassifiedLines();

  let willRevert = 0;
  let willKeep = 0;
  for (const line of classified) {
    if (filterMonth && line.month !== filterMonth) continue;
    const c = classifyMerchant(line.merchant, line.amount_clp);
    if (!shouldRevertLine(c, line.category_slug)) {
      willKeep++;
      continue;
    }
    console.log(
      `  ${line.month}  ${String(line.merchant ?? "").padEnd(36).slice(0, 36)}  ${fmt(line.amount_clp).padStart(10)}  ${line.category_slug} → unclassified`
    );
    if (apply) {
      try {
        assignFlowExpenseLineCategory({
          lineId: line.statement_line_id,
          source: line.source,
          unique: true,
          clearCategory: true,
        });
      } catch (e) {
        console.error(`  FAIL ${line.statement_line_id} (${line.merchant}): ${e instanceof Error ? e.message : e}`);
      }
    }
    willRevert++;
  }

  console.log(
    `\nPhase 2 — ${apply ? "cleared" : "would clear"} ${willRevert} assignments; kept ${willKeep}`
  );
  if (!apply) {
    console.log("Dry-run — pass --revert --apply to execute.");
  }
}

// ─── propose + apply ─────────────────────────────────────────────────────────

function main() {
  const { apply, revert, showMerchants, month } = parseArgs(process.argv.slice(2));
  const csvPath = path.join(resolveCfraserCsvDir(), CSV_BASENAME);

  if (revert) {
    runRevert(apply, month);
    console.log("\nDone.");
    return;
  }

  const targetsByMonth = parseExcelTargets(csvPath);
  const uncatByMonth = loadUncatLines();
  const currentByCat = loadCurrentClassified();

  const months = [...uncatByMonth.keys()]
    .filter((m) => (month ? m === month : true))
    .sort((a, b) => ymCompare(a, b));

  const allAssignments: Assignment[] = [];
  const allCashSplits: CashSplitAssignment[] = [];

  const SPEND_CATS = [
    "supermarket", "food", "transportation", "healthcare",
    "clothes", "fun", "trees", "others", "bills",
  ];

  for (const mk of months) {
    const lines = uncatByMonth.get(mk) ?? [];
    const targets = targetsByMonth.get(mk) ?? {};
    const { assignments, cashSplits } = proposeForMonth(mk, lines, targets, currentByCat);
    allAssignments.push(...assignments);
    allCashSplits.push(...cashSplits);

    const totalLines = lines.length;
    const totalClp = lines.reduce((s, l) => s + l.amount_clp, 0);
    console.log(
      `\n${"=".repeat(78)}\n${mk}  (${totalLines} uncategorized lines, ${fmt(totalClp)} CLP)`
    );
    console.log(
      `${"category".padEnd(16)}${"excel".padStart(12)}${"current".padStart(12)}${"+proposed".padStart(12)}${"=result".padStart(12)}`
    );
    for (const cat of SPEND_CATS) {
      const target = targets[cat] ?? 0;
      const current = currentByCat.get(`${mk}|${cat}`) ?? 0;
      const singleProp = assignments.filter((a) => a.cat === cat).reduce((s, a) => s + a.line.amount_clp, 0);
      const splitProp = allCashSplits
        .filter((cs) => cs.line.month === mk)
        .flatMap((cs) => cs.portions)
        .filter((p) => p.cat === cat)
        .reduce((s, p) => s + p.amount, 0);
      const proposed = singleProp + splitProp;
      if (target === 0 && current === 0 && proposed === 0) continue;
      console.log(
        `${cat.padEnd(16)}${fmt(target).padStart(12)}${fmt(current).padStart(12)}${fmt(proposed).padStart(12)}${fmt(current + proposed).padStart(12)}`
      );
    }

    if (cashSplits.length > 0) {
      console.log(`\n  Cash splits (${cashSplits.length} lines):`);
      for (const cs of cashSplits) {
        console.log(
          `  ${String(cs.line.merchant ?? "").slice(0, 36).padEnd(36)} ${fmt(cs.line.amount_clp).padStart(10)}`
        );
        for (const p of cs.portions) {
          console.log(`    → ${p.cat.padEnd(16)} ${fmt(p.amount).padStart(10)}`);
        }
      }
    }
  }

  if (showMerchants) {
    console.log(`\n${"=".repeat(78)}\nMERCHANT → CATEGORY\n${"=".repeat(78)}`);
    const byMerchantCat = new Map<string, { merchant: string; cat: string; via: string; n: number; sum: number }>();
    for (const a of allAssignments) {
      const key = `${up(a.line.merchant)}||${a.cat}`;
      const e = byMerchantCat.get(key) ?? { merchant: up(a.line.merchant), cat: a.cat, via: a.via, n: 0, sum: 0 };
      e.n += 1; e.sum += a.line.amount_clp;
      byMerchantCat.set(key, e);
    }
    for (const [, e] of [...byMerchantCat.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(
        `${e.cat.padEnd(15)} ${e.via.padEnd(18)} ${fmt(e.sum).padStart(10)} ${String(e.n).padStart(3)}  ${e.merchant}`
      );
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(
    `Single-category: ${allAssignments.length} assignments | CLP ${fmt(allAssignments.reduce((s, a) => s + a.line.amount_clp, 0))}`
  );
  console.log(
    `Cash splits: ${allCashSplits.length} lines | CLP ${fmt(allCashSplits.reduce((s, cs) => s + cs.line.amount_clp, 0))}`
  );

  if (apply) {
    let ok = 0;
    let fail = 0;
    for (const a of allAssignments) {
      try {
        assignFlowExpenseLineCategory({
          lineId: a.line.statement_line_id,
          source: a.line.source,
          unique: true,
          categorySlug: a.cat,
        });
        ok++;
      } catch (e) {
        fail++;
        console.error(`  FAIL ${a.line.statement_line_id} (${a.line.merchant}): ${e instanceof Error ? e.message : e}`);
      }
    }

    let splitOk = 0;
    let splitFail = 0;
    for (const cs of allCashSplits) {
      if (cs.portions.length === 0) continue;
      try {
        insertLineSplits({
          source: cs.line.source === "checking" ? "checking" : "cc",
          lineId: cs.line.statement_line_id,
          splits: cs.portions.map((p) => ({
            categorySlug: p.cat,
            amountClp: p.amount,
            note: `${EXCEL_GAP_SPLIT_NOTE_PREFIX}${cs.line.month}|${p.cat}`,
          })),
          lineAmountClp: cs.line.amount_clp,
        });
        splitOk++;
      } catch (e) {
        splitFail++;
        console.error(`  FAIL split ${cs.line.statement_line_id} (${cs.line.merchant}): ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log(`\nApplied: ${ok} single-cat assigned, ${splitOk} cash lines split, ${fail + splitFail} failed.`);
  } else {
    console.log(
      `\nDry run — no DB changes. Pass --apply to write, --merchants for merchant map, --revert [--apply] to revert.`
    );
  }
}

main();
