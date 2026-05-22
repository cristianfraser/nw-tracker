import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CartolaSkippedRow,
  ParsedCheckingCartola,
  ParsedCheckingMovement,
} from "./checkingCartolaParse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type ScreenshotMovementRow = {
  occurred_on: string;
  branch: string;
  description: string;
  document_no?: string;
  debit_clp?: number;
  credit_clp?: number;
  balance_clp?: number;
};

export type ScreenshotCartolaRow = {
  source_image: string;
  cartola_no: string;
  period_from: string;
  period_to: string;
  period_month: string;
  saldo_inicial_clp: number;
  saldo_final_clp: number;
  movements: ScreenshotMovementRow[];
};

export type ScreenshotCartolaData = {
  source: string;
  cartolas: ScreenshotCartolaRow[];
};

export function resolveCheckingCartolaScreenshotDataPath(): string {
  return path.join(REPO_ROOT, "server", "scripts", "checking-cartola-screenshot-data.json");
}

export function loadCheckingCartolaScreenshotData(
  jsonPath = resolveCheckingCartolaScreenshotDataPath()
): ScreenshotCartolaData {
  const raw = fs.readFileSync(jsonPath, "utf8");
  return JSON.parse(raw) as ScreenshotCartolaData;
}

function movementFromScreenshotRow(row: ScreenshotMovementRow): ParsedCheckingMovement | null {
  let amount_clp: number | null = null;
  if (row.credit_clp != null && row.credit_clp > 0) {
    amount_clp = row.credit_clp;
  } else if (row.debit_clp != null && row.debit_clp > 0) {
    amount_clp = -row.debit_clp;
  }
  if (amount_clp == null) return null;

  return {
    occurred_on: row.occurred_on,
    amount_clp,
    branch: row.branch,
    description: row.description,
    document_no: row.document_no ?? "",
  };
}

export function screenshotCartolaToParsed(entry: ScreenshotCartolaRow): ParsedCheckingCartola {
  const movements: ParsedCheckingMovement[] = [];
  const skipped: CartolaSkippedRow[] = [];

  for (let i = 0; i < entry.movements.length; i++) {
    const row = entry.movements[i]!;
    const mv = movementFromScreenshotRow(row);
    if (!mv) {
      skipped.push({
        sheet_row: i + 1,
        fecha: row.occurred_on,
        branch: row.branch,
        description: row.description,
        document_no: row.document_no,
        reason: "no_amount",
        detail: "no debit_clp or credit_clp on screenshot row",
      });
      continue;
    }
    movements.push(mv);
  }

  return {
    source_file: `screenshot:${entry.source_image}`,
    period_month: entry.period_month,
    period_from: entry.period_from,
    period_to: entry.period_to,
    saldo_inicial_clp: entry.saldo_inicial_clp,
    saldo_final_clp: entry.saldo_final_clp,
    movements,
    skipped,
    notes: [],
  };
}

export function loadParsedCheckingCartolasFromScreenshots(
  jsonPath = resolveCheckingCartolaScreenshotDataPath()
): ParsedCheckingCartola[] {
  const data = loadCheckingCartolaScreenshotData(jsonPath);
  return data.cartolas.map(screenshotCartolaToParsed);
}
