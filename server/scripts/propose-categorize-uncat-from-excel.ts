/**
 * Propose plausible categories for EXISTING uncategorized CC expense lines (≤ 2021-10),
 * guided by the personal spreadsheet's monthly category totals.
 *
 * Unlike propose-synthetic-gastos (which inserts synthetic rows), this assigns a category
 * to each real uncategorized line so per-category monthly totals approximate the spreadsheet.
 *
 *   npm run propose:categorize-uncat -w nw-tracker-server            # dry run (no writes)
 *   npm run propose:categorize-uncat -w nw-tracker-server -- --apply # write assignments
 *   ... -- --month 2020-09                                           # limit to one month
 *   ... -- --merchants                                               # print merchant→category map
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
import { assignFlowExpenseLineCategory, type FlowExpenseLineCategorySource } from "../src/assignFlowExpenseLineCategory.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";

const CSV_BASENAME = "flujos-Gasto mensual.csv";
const MAX_MONTH: MonthKey = "2021-10";

/** Spreadsheet column indices (semicolon CSV) — mirrors propose-synthetic-gastos. */
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

/** Categories wildcards may fill (plausible for ad-hoc CC spend). Bills/subscriptions excluded. */
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
        pos(numCsv(row[COL.transport])) + pos(numCsv(row[COL.cabify])) + pos(numCsv(row[COL.scooters])),
    });
  }
  return out;
}

/** Months left untouched (already over target / noisy one-offs — user: ignore). */
const IGNORE_MONTHS = new Set<MonthKey>(["2021-08", "2021-09"]);

/** Explicit per-merchant overrides (exact, case-insensitive, normalized) from the user. */
const MERCHANT_OVERRIDES: Record<string, string> = {
  "LA FETE CHOCOLAT": "others",
  "PAN MOSTACHO": "supermarket",
};

/** Substring → fixed category, checked BEFORE wildcard patterns (forces a real category). */
const FIXED_SUBSTRING_RULES: Array<{ cat: string; kw: string[] }> = [
  // AGUSTINAS transfer to a person → personal "others" spend, not a wildcard gap-fill.
  { cat: "others", kw: ["CORRADI DELGADO"] },
];

/** Wildcard merchants that prefer specific categories first (while those still have a gap). */
const WILDCARD_PREFERRED: Array<{ match: string; order: string[] }> = [
  { match: "AGUSTINAS GIRO EN CAJERO", order: ["trees"] },
];

/** Merchants tagged `subscriptions` only when the month has no subscription expense yet. */
const SUBSCRIPTION_IF_MISSING = ["ITUNES.COM/BILL", "ITUNES.COM"];

/** Keyword → category. First match wins (ordered most-specific first). */
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

/** Wildcards: free to allocate to any spending category to approximate the spreadsheet. */
const WILDCARD_PATTERNS = [
  "GIRO EN CAJERO",
  "TRANSF A ",
  "TRANSF. A ",
  "MACH ONE CLICK",
  "MACH WEBPAY",
  "PAGO EN LINEA PROM. CMR FALABELLA",
  "RED BCO ESTADO",
  "COMPRA ", // "COMPRA <person/place>" generic POS
  "REDELCOM",
  "SUMUP",
  "MERCADO PAGO",
  "GETITJO",
  "COMPRA FLASH",
  "COMPRA YIN JO",
  "COMPRA SILVANO",
];

/**
 * Wildcard patterns split by amount threshold: small → prefer low_cat first, large → prefer high_cat first.
 * Falls through to gap-fill if the preferred category is already at target.
 */
const WILDCARD_AMOUNT_SPLIT: Array<{ match: string; threshold: number; low_cat: string; high_cat: string }> = [
  // Bank internet transfers: small = friend bill-splitting (fun), large = misc spending (others).
  { match: "TRANSF. INTERNET", threshold: 30_000, low_cat: "fun", high_cat: "others" },
  { match: "TRANSF INTERNET",  threshold: 30_000, low_cat: "fun", high_cat: "others" },
];

function up(s: string | null | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

type Classification =
  | { kind: "fixed"; cat: string }
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

type UncatLine = { statement_line_id: number; source: FlowExpenseLineCategorySource; merchant: string | null; amount_clp: number; month: string };

function loadUncatLines(): Map<MonthKey, UncatLine[]> {
  const payload = buildFlowsCreditCardExpensesPayload();
  const byMonth = new Map<MonthKey, UncatLine[]>();
  for (const l of payload.lines as any[]) {
    if (l.amount_clp <= 0 || l.category_slug !== "unclassified") continue;
    const m = l.expense_month as MonthKey;
    if (!m || ymCompare(m, MAX_MONTH) > 0 || IGNORE_MONTHS.has(m)) continue;
    const arr = byMonth.get(m) ?? [];
    arr.push({ statement_line_id: l.statement_line_id, source: l.source, merchant: l.merchant, amount_clp: l.amount_clp, month: m });
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

type Assignment = { line: UncatLine; cat: string; via: "override" | "keyword" | "wildcard" | "unmatched-default" };

function proposeForMonth(
  mk: MonthKey,
  lines: UncatLine[],
  targets: ExcelTargets,
  currentByCat: Map<string, number>
): { assignments: Assignment[]; unmatched: UncatLine[] } {
  const proposedByCat = new Map<string, number>();
  const cur = (cat: string) => currentByCat.get(`${mk}|${cat}`) ?? 0;
  const add = (cat: string, n: number) => proposedByCat.set(cat, (proposedByCat.get(cat) ?? 0) + n);

  const assignments: Assignment[] = [];
  type Flexible = { line: UncatLine; via: "wildcard" | "unmatched-default"; preferredOrder?: string[] };
  const flexible: Flexible[] = [];
  const unmatched: UncatLine[] = [];
  const subIfMissing: UncatLine[] = [];

  for (const line of lines) {
    const c = classifyMerchant(line.merchant, line.amount_clp);
    if (c.kind === "fixed") {
      assignments.push({ line, cat: c.cat, via: up(line.merchant) in MERCHANT_OVERRIDES ? "override" : "keyword" });
      add(c.cat, line.amount_clp);
    } else if (c.kind === "wildcard") {
      flexible.push({ line, via: "wildcard", preferredOrder: c.preferredOrder });
    } else if (c.kind === "subscription-if-missing") {
      subIfMissing.push(line);
    } else {
      unmatched.push(line);
    }
  }

  // iTunes/Apple-style charges → subscriptions only when the month has none yet;
  // otherwise treat as flexible (likely a duplicate of an already-tagged subscription).
  if (cur("subscriptions") <= 0) {
    for (const line of subIfMissing) {
      assignments.push({ line, cat: "subscriptions", via: "keyword" });
      add("subscriptions", line.amount_clp);
    }
  } else {
    for (const line of subIfMissing) flexible.push({ line, via: "unmatched-default" });
  }

  // Unmatched → treated as flexible too (user: merchant-first but fill to approximate).
  for (const line of unmatched) flexible.push({ line, via: "unmatched-default" });
  // Preferred-order items (e.g. AGUSTINAS cash → trees) claim their gap before generic
  // largest-gap fills can consume it; within each bucket, larger amounts first.
  flexible.sort((a, b) => {
    const ap = a.preferredOrder ? 1 : 0;
    const bp = b.preferredOrder ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.line.amount_clp - a.line.amount_clp;
  });
  const remainingGap = (cat: string) => (targets[cat] ?? 0) - (cur(cat) + (proposedByCat.get(cat) ?? 0));

  for (const item of flexible) {
    let cat: string | null = null;

    // Preferred categories (e.g. AGUSTINAS cash → trees) win while they still have a gap.
    for (const pref of item.preferredOrder ?? []) {
      if (WILDCARD_TARGET_SLUGS.includes(pref as any) && remainingGap(pref) > 0) {
        cat = pref;
        break;
      }
    }

    // Otherwise fill whichever category has the largest positive gap vs spreadsheet target.
    // When all gaps are ≤ 0 (targets already met), fall back to "others" to avoid
    // overflow-assigning large wildcards (e.g. ATM withdrawals) to arbitrary categories.
    if (!cat) {
      let bestGap = 0; // require gap > 0
      for (const c of WILDCARD_TARGET_SLUGS) {
        const g = remainingGap(c);
        if (g > bestGap) {
          bestGap = g;
          cat = c;
        }
      }
      cat = cat ?? "others";
    }

    assignments.push({ line: item.line, cat, via: item.via });
    add(cat, item.line.amount_clp);
  }

  return { assignments, unmatched };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}

function parseArgs(argv: string[]) {
  const monthIdx = argv.indexOf("--month");
  return {
    apply: argv.includes("--apply"),
    showMerchants: argv.includes("--merchants"),
    month: monthIdx >= 0 ? (argv[monthIdx + 1] as MonthKey | undefined) : undefined,
  };
}

function main() {
  const { apply, showMerchants, month } = parseArgs(process.argv.slice(2));
  const csvPath = path.join(resolveCfraserCsvDir(), CSV_BASENAME);
  const targetsByMonth = parseExcelTargets(csvPath);
  const uncatByMonth = loadUncatLines();
  const currentByCat = loadCurrentClassified();

  const months = [...uncatByMonth.keys()]
    .filter((m) => (month ? m === month : true))
    .sort((a, b) => ymCompare(a, b));

  const allAssignments: Assignment[] = [];
  const SPEND_CATS = ["supermarket", "food", "transportation", "healthcare", "clothes", "fun", "trees", "others", "bills"];

  for (const mk of months) {
    const lines = uncatByMonth.get(mk) ?? [];
    const targets = targetsByMonth.get(mk) ?? {};
    const { assignments } = proposeForMonth(mk, lines, targets, currentByCat);
    allAssignments.push(...assignments);

    console.log(`\n${"=".repeat(78)}\n${mk}  (${lines.length} uncategorized lines, ${fmt(lines.reduce((s, l) => s + l.amount_clp, 0))} CLP)`);
    console.log(`${"category".padEnd(16)}${"excel".padStart(12)}${"current".padStart(12)}${"+proposed".padStart(12)}${"=result".padStart(12)}`);
    for (const cat of SPEND_CATS) {
      const target = targets[cat] ?? 0;
      const current = currentByCat.get(`${mk}|${cat}`) ?? 0;
      const proposed = assignments.filter((a) => a.cat === cat).reduce((s, a) => s + a.line.amount_clp, 0);
      if (target === 0 && current === 0 && proposed === 0) continue;
      console.log(`${cat.padEnd(16)}${fmt(target).padStart(12)}${fmt(current).padStart(12)}${fmt(proposed).padStart(12)}${fmt(current + proposed).padStart(12)}`);
    }
  }

  if (showMerchants) {
    console.log(`\n${"=".repeat(78)}\nMERCHANT → CATEGORY (proposed assignments)\n${"=".repeat(78)}`);
    const byMerchantCat = new Map<string, { merchant: string; cat: string; via: string; n: number; sum: number }>();
    for (const a of allAssignments) {
      const key = `${up(a.line.merchant)}||${a.cat}`;
      const e = byMerchantCat.get(key) ?? { merchant: up(a.line.merchant), cat: a.cat, via: a.via, n: 0, sum: 0 };
      e.n += 1; e.sum += a.line.amount_clp;
      byMerchantCat.set(key, e);
    }
    for (const [, e] of [...byMerchantCat.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`${e.cat.padEnd(15)} ${e.via.padEnd(18)} ${fmt(e.sum).padStart(10)} ${String(e.n).padStart(3)}  ${e.merchant}`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`Total proposed assignments: ${allAssignments.length} | CLP ${fmt(allAssignments.reduce((s, a) => s + a.line.amount_clp, 0))}`);

  if (apply) {
    let ok = 0;
    let fail = 0;
    for (const a of allAssignments) {
      try {
        assignFlowExpenseLineCategory({ lineId: a.line.statement_line_id, source: a.line.source, unique: true, categorySlug: a.cat });
        ok += 1;
      } catch (e) {
        fail += 1;
        console.error(`  FAIL line ${a.line.statement_line_id} (${a.line.merchant}): ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`\nApplied: ${ok} assigned, ${fail} failed.`);
  } else {
    console.log(`Dry run — no DB changes. Pass --apply to write, --merchants to see the merchant map.`);
  }
}

main();
