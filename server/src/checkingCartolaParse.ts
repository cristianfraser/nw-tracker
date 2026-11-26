import { isChileanNumber, parseChileanNumber } from "nw-tracker-contracts";
import { buildExpenseKey } from "./expenseKeys.js";

/**
 * A Santander cartola as the cartola import reads it, and the ledger's own keys for its movements
 * (the movement note, the stable purchase key). The documents are read by ingest
 * (`ingest/src/santander/checkingCartolaXlsx.ts`, the cartola PDF parsers in `ingest/python/`)
 * and arrive as `bank_account.statements`.
 */

export type ParsedCheckingMovement = {
  occurred_on: string;
  amount_clp: number;
  branch: string;
  description: string;
  document_no: string;
};

export type CartolaSkipReason =
  | "not_movement_row"
  | "no_amount"
  | "duplicate_in_cartola"
  | "end_of_table"
  | "balance_mismatch";

export type CartolaSkippedRow = {
  sheet_row?: number;
  fecha?: string;
  branch?: string;
  description?: string;
  document_no?: string;
  amount_clp?: number;
  reason: CartolaSkipReason;
  detail?: string;
};

export type CartolaParseNote = {
  sheet_row: number;
  message: string;
};

export type ParsedCheckingCartola = {
  source_file: string;
  period_month: string;
  period_from: string | null;
  period_to: string | null;
  saldo_inicial_clp: number | null;
  saldo_final_clp: number | null;
  /** Per calendar month end reference from Saldo Dia (multi-month vista PDFs). */
  month_saldo_final_clp?: Record<string, number>;
  movements: ParsedCheckingMovement[];
  skipped: CartolaSkippedRow[];
  notes: CartolaParseNote[];
};

/**
 * Chilean bank amounts, rounded to the peso: $1.xxx.xxx, 1.234,56, 1234,56 or plain digits.
 * Null when the cell holds no number (empty, or text in a column probed for an amount).
 */
export function parseCartolaAmount(raw: string): number | null {
  const t = String(raw ?? "").replace(/\$/g, "");
  if (!isChileanNumber(t)) return null;
  return Math.round(parseChileanNumber(t));
}

export type MovementNoteOpts = {
  occurredOn: string;
  amountClp: number;
  /** Stable position in the parsed cartola (disambiguates identical rows). */
  cartolaIndex: number;
};

export function movementNote(
  periodMonth: string,
  branch: string,
  description: string,
  documentNo: string,
  opts: MovementNoteOpts
): string {
  const parts = [
    `import:cartola|${periodMonth}`,
    branch || "—",
    description.slice(0, 180),
  ];
  if (documentNo) parts.push(`doc:${documentNo}`);
  parts.push(`on:${opts.occurredOn}`);
  parts.push(`amt:${opts.amountClp}`);
  parts.push(`idx:${opts.cartolaIndex}`);
  return parts.join("|");
}

/** A cartola row's purchase key from its parts (the cartola month, its bank day, pesos and position). */
export function checkingCartolaPurchaseKeyOf(
  accountId: number,
  parts: { periodMonth: string; occurredOn: string; amountClp: number | string; cartolaIndex: number },
  portion: "gastos" | "deposit" = "gastos"
): string {
  return buildExpenseKey({
    kind: "checking_cartola",
    accountId,
    periodMonth: parts.periodMonth,
    occurredOn: parts.occurredOn,
    amountClp: String(parts.amountClp),
    cartolaIndex: parts.cartolaIndex,
    portion,
  });
}
