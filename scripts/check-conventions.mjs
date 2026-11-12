/**
 * Conventions guard (AGENTS.md "Language and i18n" + number formatting):
 *
 * 1. No hardcoded Spanish UI copy in client source — string literals / JSX text with
 *    Spanish-only characters (á é í ó ú ñ ¿ ¡) belong in client/src/i18n/locales/es.json.
 *    Comments are stripped before scanning (Spanish domain terms in comments are fine).
 * 2. No `Intl.NumberFormat` outside client/src/format.ts — all number formatting goes
 *    through the format.ts helpers so the decimal-separator preference applies.
 * 3. No `toLocaleString("<locale>")` for numbers. Calls with date options
 *    (dateStyle/timeStyle/weekday/…) near the call are exempt — but prefer the
 *    date conventions in AGENTS.md: ISO numerics + formatDateLabel.ts month names.
 * 4. No month-name tables outside client/src/formatDateLabel.ts — a private
 *    «ene … dic» table ignores the UI language; month labels go through its helpers.
 *    Detected by the table's January entry ("ene", "enero", "Jan", "January").
 *
 * 5. Migration SQL safety (server/migrations/*.sql): the runner splits statements naively
 *    on every `;` and strips `--` comments without lexing string literals (db.ts
 *    splitMigrationStatements). Files must not contain CREATE TRIGGER, `;` or `--` inside
 *    single-quoted literals, or unterminated literals — use a POST_MIGRATION_HOOKS entry
 *    in db.ts for those data transforms.
 *
 * 6. No `isFetching` / `isRefetching` in client/src/components or client/src/pages — a view
 *    dims on `queryShowsLoading(q)` (queries/pageShapeReady.ts: `isPending || isPlaceholderData`),
 *    never on a background refetch (the live-quotes stamp refetches every query on each tick).
 *
 * 7. No ticker-suffix parsing outside server/src/priceProviders/ (server/src, client/src,
 *    ingest/src): an instrument's market, currency and display symbol are registered facts
 *    (market_symbols, requireMarketSymbol), never read from `.SN` / `.L` / `-USD`. Flags
 *    `.endsWith(".XX")` / `.endsWith("-USD")`, `lastIndexOf(".")` on a ticker or symbol, a
 *    `\.SN$`-style regex, and `LIKE '%.SN'` / `'%.L'` / `'%-USD'` in SQL strings.
 *
 * 8–13. Currency hardcoding — see the block above the currency rules below; 8–12 ratchet against
 *    scripts/check-currency.baseline.json (`--write-baseline [--force]` rewrites it).
 *
 * Escape hatch: append `// convention-ok: <reason>` to a line to exempt it.
 * Run: `npm run check:conventions` (root) — part of `npm run typecheck`.
 */
import fs from "node:fs";
import path from "node:path";

const CLIENT_SRC = path.join(process.cwd(), "client", "src");
const MIGRATIONS_DIR = path.join(process.cwd(), "server", "migrations");
const FORMAT_TS = path.join(CLIENT_SRC, "format.ts");
const FORMAT_DATE_LABEL_TS = path.join(CLIENT_SRC, "formatDateLabel.ts");
const SPANISH_CHARS = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
/** The January entry of a month-name table, Spanish or English, short or full. */
const MONTH_TABLE_ENTRY = /["'`](ene|enero|jan|january)["'`]/i;
const VIEW_DIRS = [path.join(CLIENT_SRC, "components"), path.join(CLIENT_SRC, "pages")];
const DATE_OPTION_HINT = /dateStyle|timeStyle|weekday|year|month|day|hour|minute|second/;

/** Blank out comments while preserving line structure (naive; good enough for a guard). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + " ".repeat(m.length - pre.length));
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "locales" || entry.name === "node_modules") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      yield p;
    }
  }
}

const problems = [];

for (const file of walk(CLIENT_SRC)) {
  const rel = path.relative(process.cwd(), file);
  const raw = fs.readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const lines = stripComments(raw).split("\n");

  lines.forEach((line, i) => {
    if (/\/\/ convention-ok/.test(rawLines[i] ?? "")) return;
    const loc = `${rel}:${i + 1}`;

    if (SPANISH_CHARS.test(line)) {
      problems.push(`${loc}: hardcoded Spanish copy — move it to es.json and use t()/Trans\n    ${line.trim().slice(0, 100)}`);
    }

    if (file !== FORMAT_TS && /Intl\.NumberFormat/.test(line)) {
      problems.push(`${loc}: Intl.NumberFormat outside format.ts — use the format.ts helpers`);
    }

    if (file !== FORMAT_DATE_LABEL_TS && MONTH_TABLE_ENTRY.test(line)) {
      problems.push(`${loc}: month-name table outside formatDateLabel.ts — use its helpers so the label follows the UI language`);
    }

    if (VIEW_DIRS.some((d) => file.startsWith(d + path.sep)) && /\bis(Re)?[Ff]etching\b/.test(line)) {
      problems.push(`${loc}: isFetching in a view — dim on queryShowsLoading(q) (isPending || isPlaceholderData), never on a background refetch`);
    }

    if (file !== FORMAT_TS && /toLocaleString\(\s*["']/.test(line)) {
      const context = lines.slice(i, i + 4).join(" ");
      if (!DATE_OPTION_HINT.test(context)) {
        problems.push(`${loc}: toLocaleString with a hardcoded locale for numbers — use the format.ts helpers (dates with es-CL are fine)`);
      }
    }
  });
}

/** Ticker-suffix parsing (rule 7); the provider adapters are the one place that knows a symbol's shape. */
const TICKER_SUFFIX_ROOTS = ["server", "client", "ingest"].map((d) => path.join(process.cwd(), d, "src"));
const PRICE_PROVIDERS_DIR = path.join(process.cwd(), "server", "src", "priceProviders");
const TICKER_SUFFIX_PATTERNS = [
  [/\.endsWith\(\s*["'`]\.[A-Z]{1,4}["'`]/, "endsWith on an exchange suffix"],
  [/\.endsWith\(\s*["'`]-USD["'`]/, "endsWith on -USD"],
  [/\b\w*(ticker|symbol|sym)\w*\.lastIndexOf\(\s*["']\.["']/i, "lastIndexOf(\".\") on a ticker"],
  [/\/[^/\n]*\\\.(SN|L|NYB)\$\//, "regex on an exchange suffix"],
  [/LIKE\s+'%(\.(SN|L|NYB)|-USD)'/i, "SQL LIKE on a ticker suffix"],
];
for (const root of TICKER_SUFFIX_ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    if (file.startsWith(PRICE_PROVIDERS_DIR + path.sep)) continue;
    const rel = path.relative(process.cwd(), file);
    const raw = fs.readFileSync(file, "utf8");
    const rawLines = raw.split("\n");
    stripComments(raw).split("\n").forEach((line, i) => {
      if (/\/\/ convention-ok/.test(rawLines[i] ?? "")) return;
      for (const [re, what] of TICKER_SUFFIX_PATTERNS) {
        if (re.test(line)) {
          problems.push(`${rel}:${i + 1}: ${what} — an instrument's market and currency come from the registry (requireMarketSymbol), not its spelling\n    ${line.trim().slice(0, 100)}`);
        }
      }
    });
  }
}

/**
 * Migration SQL safety: mirror db.ts splitMigrationStatements' blind spots. Walks the file
 * character-by-character tracking single-quoted literals ('' = escaped quote); outside
 * literals `--` comments are skipped. Flags `;` / `--` inside literals, CREATE TRIGGER,
 * and unterminated literals — all of which the naive `;` splitter would corrupt.
 */
function checkMigrationSql(rel, sql) {
  if (/create\s+trigger/i.test(sql.replace(/--[^\n]*/g, ""))) {
    problems.push(
      `${rel}: CREATE TRIGGER in migration SQL — the naive ; splitter breaks BEGIN…END bodies; use a POST_MIGRATION_HOOKS entry in db.ts`
    );
  }
  let line = 1;
  let inLiteral = false;
  let literalStartLine = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "\n") line++;
    if (inLiteral) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i++; // escaped quote
        } else {
          inLiteral = false;
        }
      } else if (ch === ";") {
        problems.push(
          `${rel}:${line}: \`;\` inside a string literal — the migration runner splits on every ; (use a POST_MIGRATION_HOOKS entry in db.ts)`
        );
      } else if (ch === "-" && sql[i + 1] === "-") {
        problems.push(
          `${rel}:${line}: \`--\` inside a string literal — the migration runner strips it as a comment (use a POST_MIGRATION_HOOKS entry in db.ts)`
        );
        i++;
      }
    } else if (ch === "'") {
      inLiteral = true;
      literalStartLine = line;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      line++;
    }
  }
  if (inLiteral) {
    problems.push(`${rel}:${literalStartLine}: unterminated string literal in migration SQL`);
  }
}

if (fs.existsSync(MIGRATIONS_DIR)) {
  for (const entry of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    if (!entry.endsWith(".sql")) continue;
    const file = path.join(MIGRATIONS_DIR, entry);
    checkMigrationSql(path.relative(process.cwd(), file), fs.readFileSync(file, "utf8"));
  }
}

/**
 * Currency hardcoding (rules 8–13, docs/any-currency-plan.md «Guard, landing with A1»). A display
 * unit is any currency of `currencies`; code must not name a fixed set of them. Scans server/src,
 * client/src, server/contracts/src and ingest/src (tests and server/src/test excluded). Rules 8–12
 * are a ratchet like check-deps: `scripts/check-currency.baseline.json` lists the counts per file
 * and rule that exist today, and the check fails only when a file has more than its baseline
 * allows. `--write-baseline` rewrites it — refused when any count grew, unless `--force`.
 *
 *  8. currency-formatter: formatClp / formatClpUfDay / formatUsd / formatUsdFine in
 *     client/src/components or client/src/pages — format through the unit (formatCurrency,
 *     formatMoney), never a formatter named after one currency.
 *  9. unit-literal-compare: `unit === "clp"`, `currency !== "usd"` (an identifier containing
 *     unit/currency against a currency literal), outside rates.ts / valueConvert.ts / displayUnits.ts.
 * 10. currency-list-literal: an array literal of two or more currency codes (`["clp", "usd"]`),
 *     outside the same three files.
 * 11. dto-currency-key: a `_clp` / `_usd` / `_eur` property key in server/contracts/src/dto.
 * 12. currency-type-union: a union of currency literals (`"clp" | "usd"`), outside the same three files.
 * 13. migration-currency-check (hard fail, no baseline): a migration numbered above
 *     CURRENCY_CHECK_FROM_MIGRATION with `CHECK (… IN ('clp' …))` — reference currencies(code).
 */
const CURRENCY_BASELINE = path.join(process.cwd(), "scripts", "check-currency.baseline.json");
const CURRENCY_ROOTS = ["server/src", "client/src", "server/contracts/src", "ingest/src"].map((d) =>
  path.join(process.cwd(), d)
);
const SERVER_TEST_DIR = path.join(process.cwd(), "server", "src", "test");
const DTO_DIR = path.join(process.cwd(), "server", "contracts", "src", "dto");
const CURRENCY_NATIVE_FILES = new Set(
  ["rates.ts", "valueConvert.ts", "displayUnits.ts"].map((f) => path.join(process.cwd(), "server", "src", f))
);
/** Migrations up to this number predate the rule; a newer one must reference currencies(code). */
const CURRENCY_CHECK_FROM_MIGRATION = 312;
const CODE = `(?:clp|usd|eur|uf)`;
const CODE_LIT = `["'\`]${CODE}["'\`]`;
const CURRENCY_RULES = [
  {
    id: "currency-formatter",
    applies: (file) => VIEW_DIRS.some((d) => file.startsWith(d + path.sep)),
    re: /\b(formatClp|formatClpUfDay|formatUsd|formatUsdFine)\s*\(/g,
    why: "a formatter named after one currency in a view — format through the unit (formatCurrency / formatMoney)",
  },
  {
    id: "unit-literal-compare",
    applies: (file) => !CURRENCY_NATIVE_FILES.has(file),
    re: new RegExp(
      `[\\w.]*(?:unit|currency)[\\w.]*\\s*[!=]==?\\s*${CODE_LIT}|${CODE_LIT}\\s*[!=]==?\\s*[\\w.]*(?:unit|currency)`,
      "gi"
    ),
    why: "a unit or currency compared with a literal code — read it from the currencies table (rates.ts / displayUnits.ts)",
  },
  {
    id: "currency-list-literal",
    applies: (file) => !CURRENCY_NATIVE_FILES.has(file),
    re: new RegExp(`\\[\\s*(?:${CODE_LIT}\\s*,\\s*)+${CODE_LIT}\\s*,?\\s*\\]`, "gi"),
    why: "a fixed list of currency codes — the currencies table lists them (displayUnits.ts)",
  },
  {
    id: "dto-currency-key",
    applies: (file) => file.startsWith(DTO_DIR + path.sep),
    re: /(?:^|[\s{,(])["']?\w+_(?:clp|usd|eur)["']?\s*\??\s*:/g,
    why: "a property key named after one currency in a DTO — carry {value, currency} or one value in the requested unit",
  },
  {
    id: "currency-type-union",
    applies: (file) => !CURRENCY_NATIVE_FILES.has(file),
    re: new RegExp(`${CODE_LIT}\\s*\\|\\s*${CODE_LIT}`, "gi"),
    why: "a union of currency literals — a currency is a string code from the currencies table",
  },
];

/** counts[rel][rule] and the matching lines, for the ratchet. */
const currencyCounts = {};
const currencyHits = [];
for (const root of CURRENCY_ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    if (file.startsWith(SERVER_TEST_DIR + path.sep)) continue;
    const rules = CURRENCY_RULES.filter((r) => r.applies(file));
    if (rules.length === 0) continue;
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    const raw = fs.readFileSync(file, "utf8");
    const rawLines = raw.split("\n");
    stripComments(raw).split("\n").forEach((line, i) => {
      if (/\/\/ convention-ok/.test(rawLines[i] ?? "")) return;
      for (const rule of rules) {
        const n = [...line.matchAll(rule.re)].length;
        if (n === 0) continue;
        currencyCounts[rel] ??= {};
        currencyCounts[rel][rule.id] = (currencyCounts[rel][rule.id] ?? 0) + n;
        currencyHits.push({ rel, line: i + 1, rule, text: line.trim().slice(0, 100) });
      }
    });
  }
}

const currencyBaseline = fs.existsSync(CURRENCY_BASELINE)
  ? JSON.parse(fs.readFileSync(CURRENCY_BASELINE, "utf8")).violations
  : null;
const grown = [];
let currencyShrunk = false;
for (const [f, byRule] of Object.entries(currencyCounts)) {
  for (const [r, n] of Object.entries(byRule)) {
    const allowed = currencyBaseline?.[f]?.[r] ?? 0;
    if (n > allowed) grown.push({ f, r, n, allowed });
  }
}
if (currencyBaseline) {
  for (const [f, byRule] of Object.entries(currencyBaseline)) {
    for (const [r, n] of Object.entries(byRule)) if ((currencyCounts[f]?.[r] ?? 0) < n) currencyShrunk = true;
  }
}

if (process.argv.includes("--write-baseline")) {
  if (currencyBaseline && grown.length > 0 && !process.argv.includes("--force")) {
    console.error("check-conventions: currency counts grew; refusing to write the baseline (pass --force to accept them)");
    for (const g of grown) console.error(`  ${g.f}: ${g.r} ${g.n} (baseline ${g.allowed})`);
    process.exit(1);
  }
  const totals = {};
  const violations = {};
  for (const f of Object.keys(currencyCounts).sort()) {
    violations[f] = {};
    for (const r of Object.keys(currencyCounts[f]).sort()) {
      violations[f][r] = currencyCounts[f][r];
      totals[r] = (totals[r] ?? 0) + currencyCounts[f][r];
    }
  }
  fs.writeFileSync(
    CURRENCY_BASELINE,
    JSON.stringify(
      {
        note: "Written by `node scripts/check-conventions.mjs --write-baseline`. Counts per file and rule may only shrink.",
        totals: Object.fromEntries(Object.keys(totals).sort().map((r) => [r, totals[r]])),
        violations,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`check-conventions: currency baseline written ${JSON.stringify(totals)}`);
} else if (!currencyBaseline) {
  problems.push("scripts/check-currency.baseline.json missing — run `node scripts/check-conventions.mjs --write-baseline`");
} else {
  const grownKeys = new Set(grown.map((g) => `${g.f}|${g.r}`));
  for (const g of grown) {
    problems.push(`${g.f}: ${g.r} ${g.n} > baseline ${g.allowed} — ${CURRENCY_RULES.find((r) => r.id === g.r).why}`);
  }
  for (const h of currencyHits) {
    if (grownKeys.has(`${h.rel}|${h.rule.id}`)) problems.push(`  ${h.rel}:${h.line}: ${h.rule.id}\n      ${h.text}`);
  }
  if (currencyShrunk && grown.length === 0) {
    console.log("check-conventions: currency violations shrank below the baseline: run with --write-baseline to lock it in");
  }
}

/** Rule 13: a new migration's currency columns reference currencies(code), never a CHECK list. */
if (fs.existsSync(MIGRATIONS_DIR)) {
  for (const entry of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    const m = /^(\d+)_.*\.sql$/.exec(entry);
    if (!m || Number(m[1]) <= CURRENCY_CHECK_FROM_MIGRATION) continue;
    const rel = path.relative(process.cwd(), path.join(MIGRATIONS_DIR, entry));
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, entry), "utf8").replace(/--[^\n]*/g, (c) => " ".repeat(c.length));
    const re = new RegExp(`CHECK\\s*\\([^;]*?\\bIN\\s*\\(\\s*'${CODE}'`, "gi");
    for (const hit of sql.matchAll(re)) {
      const line = sql.slice(0, hit.index + hit[0].length).split("\n").length;
      problems.push(`${rel}:${line}: migration-currency-check — a currency column must reference currencies(code), not CHECK (… IN ('clp' …))`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-conventions: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-conventions: ok");
