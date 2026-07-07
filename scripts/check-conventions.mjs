/**
 * Conventions guard (AGENTS.md "Language and i18n" + number formatting):
 *
 * 1. No hardcoded Spanish UI copy in client source — string literals / JSX text with
 *    Spanish-only characters (á é í ó ú ñ ¿ ¡) belong in client/src/i18n/locales/es.json.
 *    Comments are stripped before scanning (Spanish domain terms in comments are fine).
 * 2. No `Intl.NumberFormat` outside client/src/format.ts — all number formatting goes
 *    through the format.ts helpers so the decimal-separator preference applies.
 * 3. No `toLocaleString("<locale>")` for numbers. Date formatting with an explicit
 *    es-CL locale is allowed (AGENTS.md: "dates stay es-CL") — detected by date options
 *    (dateStyle/timeStyle/weekday/…) near the call.
 *
 * Escape hatch: append `// convention-ok: <reason>` to a line to exempt it.
 * Run: `npm run check:conventions` (root) — part of `npm run typecheck`.
 */
import fs from "node:fs";
import path from "node:path";

const CLIENT_SRC = path.join(process.cwd(), "client", "src");
const FORMAT_TS = path.join(CLIENT_SRC, "format.ts");
const SPANISH_CHARS = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
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

    if (file !== FORMAT_TS && /toLocaleString\(\s*["']/.test(line)) {
      const context = lines.slice(i, i + 4).join(" ");
      if (!DATE_OPTION_HINT.test(context)) {
        problems.push(`${loc}: toLocaleString with a hardcoded locale for numbers — use the format.ts helpers (dates with es-CL are fine)`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`check-conventions: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-conventions: ok");
