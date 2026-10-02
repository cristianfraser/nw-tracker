import { isChileanNumber, parseChileanNumber } from "./chileanNumber.js";

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

/** Identity key for optional duplicate removal when saldo checkpoints fail. */
export function cartolaMovementDedupeKey(mv: {
  occurred_on: string;
  amount_clp: number;
  description: string;
  document_no?: string;
}): string {
  const doc = String(mv.document_no ?? "").trim();
  return `${mv.occurred_on}\t${mv.amount_clp}\t${mv.description}\t${doc}`;
}

export type MovementNoteOpts = {
  occurredOn: string;
  amountClp: number;
  /** Stable position in the parsed cartola (disambiguates identical rows). */
  cartolaIndex: number;
};

/** Strip trailing `|doc:…`, `|on:…`, `|amt:…`, `|idx:…` tags from a description fragment. */
export function stripTrailingCartolaNoteTags(desc: string): string {
  let d = desc.trim();
  for (;;) {
    const m = /\|(doc:[^|]*|on:\d{4}-\d{2}-\d{2}|amt:-?\d+|idx:\d+)$/.exec(d);
    if (!m) break;
    d = d.slice(0, m.index).trim();
  }
  return d;
}

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

/** Stable expense category key from cartola movement note (survives movement id changes on re-import). */
export function checkingCartolaStablePurchaseKey(
  accountId: number,
  note: string | null | undefined,
  portion: "gastos" | "deposit" = "gastos"
): string | null {
  const n = String(note ?? "").trim();
  if (!n.startsWith("import:cartola|")) return null;
  const periodMonth = n.split("|")[1]?.trim();
  const occurredOn = n.match(/\|on:([^|]+)/)?.[1]?.trim();
  const amountClp = n.match(/\|amt:([^|]+)/)?.[1]?.trim();
  const cartolaIndex = n.match(/\|idx:(\d+)/)?.[1]?.trim();
  if (!periodMonth || !occurredOn || amountClp == null || cartolaIndex == null) return null;
  const base = `checking-cartola:${accountId}:${periodMonth}:${occurredOn}:${amountClp}:${cartolaIndex}`;
  return portion === "deposit" ? `${base}:deposit` : base;
}

/** Description + document parsed back out of an `import:cartola|…` movement note. */
export function cartolaNoteContent(
  note: string
): { description: string; document_no: string } | null {
  if (!note.startsWith("import:cartola|")) return null;
  return {
    description: stripTrailingCartolaNoteTags(cartolaDescriptionFragmentFromNote(note)),
    document_no: cartolaDocumentFragmentFromNote(note) ?? "",
  };
}

export function cartolaMovementMatchesImportedRow(
  mv: ParsedCheckingMovement,
  note: string
): boolean {
  if (!note.startsWith("import:cartola|")) return false;
  const desc = stripTrailingCartolaNoteTags(
    cartolaDescriptionFragmentFromNote(note)
  );
  if (desc !== mv.description.trim()) return false;
  const doc = cartolaDocumentFragmentFromNote(note) ?? "";
  return doc === String(mv.document_no ?? "").trim();
}

/** Description segment only (after period and branch), including trailing meta tags. */
function cartolaDescriptionFragmentFromNote(note: string): string {
  const rest = note.slice("import:cartola|".length);
  const firstBar = rest.indexOf("|");
  if (firstBar < 0) return rest.trim();
  const afterPeriod = rest.slice(firstBar + 1);
  const secondBar = afterPeriod.indexOf("|");
  if (secondBar < 0) return afterPeriod.trim();
  return afterPeriod.slice(secondBar + 1).trim();
}

function cartolaDocumentFragmentFromNote(note: string): string | null {
  const desc = cartolaDescriptionFragmentFromNote(note);
  const docInDesc = desc.match(/\|doc:([^|]+)$/);
  if (docInDesc) return docInDesc[1]!.trim() || null;
  const idx = note.lastIndexOf("|doc:");
  if (idx < 0) return null;
  const tail = note.slice(idx + "|doc:".length);
  const end = tail.search(/\|(on:|amt:|idx:)/);
  const doc = (end >= 0 ? tail.slice(0, end) : tail).trim();
  return doc.length > 0 ? doc : null;
}
