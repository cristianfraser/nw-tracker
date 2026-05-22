/**
 * Build checking cartola CSV from screenshot-derived data (not PDF parsing).
 *
 *   npm run export:checking-cartola-screenshots-csv -w nw-tracker-server
 *
 * Source: server/scripts/checking-cartola-screenshot-data.json
 * Output: cfraser/checking-cartolas-from-screenshots.csv
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA_PATH = path.join(__dirname, "checking-cartola-screenshot-data.json");
const OUT_PATH = path.join(REPO_ROOT, "cfraser", "checking-cartolas-from-screenshots.csv");

type MovementRow = {
  occurred_on: string;
  branch: string;
  description: string;
  document_no?: string;
  debit_clp?: number;
  credit_clp?: number;
  balance_clp?: number;
};

type Cartola = {
  source_image: string;
  cartola_no: string;
  period_from: string;
  period_to: string;
  period_month: string;
  saldo_inicial_clp: number;
  saldo_final_clp: number;
  movements: MovementRow[];
};

const CSV_FIELDS = [
  "source_image",
  "period_month",
  "period_from",
  "period_to",
  "cartola_no",
  "saldo_inicial_clp",
  "saldo_final_clp",
  "occurred_on",
  "branch",
  "description",
  "document_no",
  "debit_clp",
  "credit_clp",
  "amount_clp",
  "balance_clp",
] as const;

function escapeCsv(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function main() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  const data = JSON.parse(raw) as { cartolas: Cartola[] };
  const lines: string[] = [CSV_FIELDS.join(",")];

  for (const cartola of data.cartolas) {
    const base = {
      source_image: cartola.source_image,
      period_month: cartola.period_month,
      period_from: cartola.period_from,
      period_to: cartola.period_to,
      cartola_no: cartola.cartola_no,
      saldo_inicial_clp: cartola.saldo_inicial_clp,
      saldo_final_clp: cartola.saldo_final_clp,
    };
    for (const mv of cartola.movements) {
      const debit = mv.debit_clp ?? "";
      const credit = mv.credit_clp ?? "";
      const amount =
        mv.credit_clp != null
          ? mv.credit_clp
          : mv.debit_clp != null
            ? -mv.debit_clp
            : "";
      const row = [
        base.source_image,
        base.period_month,
        base.period_from,
        base.period_to,
        base.cartola_no,
        base.saldo_inicial_clp,
        base.saldo_final_clp,
        mv.occurred_on,
        mv.branch,
        mv.description,
        mv.document_no ?? "",
        debit,
        credit,
        amount,
        mv.balance_clp ?? "",
      ].map(escapeCsv);
      lines.push(row.join(","));
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
  const rows = lines.length - 1;
  console.log(`Wrote ${OUT_PATH} (${rows} movement rows from ${data.cartolas.length} cartolas).`);
}

main();
