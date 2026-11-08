import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Provenance is read from columns and keys from the key module (docs/untangle-plan.md F9 steps 1–2).
 * This fails when runtime code goes back to testing a statement source prefix, parsing the deposit
 * matcher's note, testing a movement's note for its document kind (F9 step 4), or spelling a
 * purchase key by hand. The owners of each spelling are allowed.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));

const RULES: { name: string; pattern: RegExp; allowedIn: readonly string[] }[] = [
  {
    name: "statement source prefix (read cc_statements.source_kind)",
    pattern: /startsWith\(\s*["'`]import:(web-paste|santander-json)|LIKE\s+'import:(web-paste|santander-json)/,
    allowedIn: ["ccStatementSourceKind.ts"],
  },
  {
    name: "deposit-match note parsed (read the line's deposit_match)",
    pattern: /LIKE\s+'%?auto:deposit-match|parseAutoDepositMatchNote/,
    allowedIn: [],
  },
  {
    name: "purchase key spelled by hand (use expenseKeys.ts)",
    pattern:
      /(startsWith|endsWith)\(\s*["'`](installment-h|installment-pr|installment|line-pr|line|line-fallback|checking-mv|checking-cartola|manual|payslip|synthetic-checking-gap-mirror):|[`"']#split:|`(installment-h|installment-pr|line-pr|line-fallback|checking-mv|checking-cartola|payslip|synthetic-checking-gap-mirror):\$\{/,
    allowedIn: ["expenseKeys.ts", "expenseKeyLegacyRewrite273.ts"],
  },
  {
    name: "a movement's document kind tested by note prefix (read flow_evidence.source_kind, flows/flowEvidence.ts)",
    pattern: /LIKE\s+'import:cartola(\|anchor|\|opening|-partial)?\|%'/,
    allowedIn: ["flowTables279.ts"],
  },
];

function runtimeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") out.push(...runtimeFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("provenance and keys are read, not re-parsed", () => {
  for (const rule of RULES) {
    it(rule.name, () => {
      const hits: string[] = [];
      for (const file of runtimeFiles(SRC)) {
        if (rule.allowedIn.includes(path.basename(file))) continue;
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return;
            if (rule.pattern.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
          });
      }
      expect(hits).toEqual([]);
    });
  }
});
