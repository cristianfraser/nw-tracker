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

if (problems.length > 0) {
  console.error(`check-conventions: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-conventions: ok");
