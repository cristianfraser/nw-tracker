import type { Database as DatabaseType } from "better-sqlite3";
import { normalizeMerchantText, parseDdMmYyToIso } from "nw-tracker-contracts";
import { buildExpenseKey, parseExpenseKey, type CheckingPortion, type ExpenseKey } from "../expenseKeys.js";

/**
 * Which rows an expense key names (docs/untangle-flow-identity.md, F9 step 3): the inverse of the
 * key builders, by family. A key is the identity a flow was born from (`flows.legacy_key`); the rows
 * it names are the flow's evidence. Takes the database handle (the migration 279 hook runs before
 * the module graph has a `db`), and imports only leaf modules.
 *
 * A key names no row when the row it was built from is gone, or when its row now carries another
 * key (a cartola row is keyed by its cartola identity, so `checking-mv:<id>` of that row is read by
 * nothing; a cuota line is keyed by its plan, so `line-pr:` of it is read by nothing).
 */

export type FlowSourceTable =
  | "movements"
  | "cc_statement_lines"
  | "cc_installment_purchases"
  | "expense_entries";

export type FlowSourceRow = { table: FlowSourceTable; id: number };

export type ResolvedExpenseKey = {
  /** The key of the flow: the gastos portion, without a piece suffix. */
  flowKey: string;
  portion: CheckingPortion;
  /** The piece of the flow (its piece mark's sequence), or null. */
  pieceSeq: number | null;
  rows: FlowSourceRow[];
};

/** The flow key, portion and piece of a stored key; null when the text is not a key. */
export function expenseKeyParts(text: string): { flowKey: string; portion: CheckingPortion; pieceSeq: number | null } | null {
  const parsed = parseExpenseKey(text);
  if (!parsed) return null;
  const base = parsed.kind === "split" ? parsed.base : parsed;
  const pieceSeq = parsed.kind === "split" ? parsed.seq : null;
  const portion: CheckingPortion =
    base.kind === "checking_cartola" || base.kind === "checking_mv" ? base.portion : "gastos";
  const gastos: ExpenseKey =
    base.kind === "checking_cartola" || base.kind === "checking_mv" ? { ...base, portion: "gastos" } : base;
  return { flowKey: buildExpenseKey(gastos), portion, pieceSeq };
}

/** `dd/mm/yy` or `dd/mm/yyyy` → ISO; null otherwise. */
function isoFromDdMm(raw: string | null | undefined): string | null {
  return raw ? parseDdMmYyToIso(raw) : null;
}

function cartolaNoteFields(note: string | null): { period: string; on: string; amt: string; idx: string } | null {
  const n = String(note ?? "").trim();
  if (!n.startsWith("import:cartola|")) return null;
  const period = n.split("|")[1]?.trim();
  const on = n.match(/\|on:([^|]+)/)?.[1]?.trim();
  const amt = n.match(/\|amt:([^|]+)/)?.[1]?.trim();
  const idx = n.match(/\|idx:(\d+)/)?.[1]?.trim();
  if (!period || !on || amt == null || idx == null) return null;
  return { period, on, amt, idx };
}

function linesWhere(dbi: DatabaseType, where: string, ...args: unknown[]) {
  return dbi
    .prepare(
      `SELECT l.id, s.account_id, l.installment_flag, l.merchant, l.transaction_date, l.posting_date,
              l.nro_cuota_total, l.valor_cuota_mensual_clp, l.parser_row_id
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE ${where}`
    )
    .all(...args) as {
    id: number;
    account_id: number;
    installment_flag: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    nro_cuota_total: number | null;
    valor_cuota_mensual_clp: number | null;
    parser_row_id: string | null;
  }[];
}

function lineIso(l: { transaction_date: string | null; posting_date: string | null }): string | null {
  return isoFromDdMm(l.transaction_date) ?? isoFromDdMm(l.posting_date);
}

function hasRealParserRow(prid: string | null): boolean {
  const p = String(prid ?? "").trim();
  return p !== "" && !p.startsWith("synthetic:");
}

function rowsForBaseKey(dbi: DatabaseType, key: ExpenseKey): FlowSourceRow[] {
  switch (key.kind) {
    case "line_pr":
      return linesWhere(dbi, `l.parser_row_id = ? AND l.installment_flag = 0`, key.parserRowId).map((l) => ({
        table: "cc_statement_lines",
        id: l.id,
      }));
    case "line":
      return linesWhere(dbi, `l.id = ?`, key.lineId).map((l) => ({ table: "cc_statement_lines", id: l.id }));
    case "line_fallback_missing":
      return [];
    case "line_fallback":
      return linesWhere(dbi, `s.account_id = ?`, key.accountId)
        .filter(
          (l) =>
            !hasRealParserRow(l.parser_row_id) &&
            normalizeMerchantText(l.merchant) === key.merchantKey &&
            (lineIso(l) ?? "") === key.purchaseIso
        )
        .map((l) => ({ table: "cc_statement_lines", id: l.id }));
    case "installment_pr":
      return linesWhere(dbi, `l.parser_row_id = ? AND l.installment_flag = 1`, key.parserRowId).map((l) => ({
        table: "cc_statement_lines",
        id: l.id,
      }));
    case "installment":
      return (dbi.prepare(`SELECT id FROM cc_installment_purchases WHERE id = ?`).all(key.purchaseId) as { id: number }[]).map(
        (p) => ({ table: "cc_installment_purchases", id: p.id })
      );
    case "installment_h":
      return rowsForInstallmentH(dbi, key);
    case "checking_cartola": {
      const rows = dbi
        .prepare(`SELECT id, note FROM movements WHERE account_id = ? AND note LIKE ?`)
        .all(key.accountId, `import:cartola|${key.periodMonth}|%`) as { id: number; note: string | null }[];
      return rows
        .filter((m) => {
          const f = cartolaNoteFields(m.note);
          return f != null && f.on === key.occurredOn && f.amt === key.amountClp && Number(f.idx) === key.cartolaIndex;
        })
        .map((m) => ({ table: "movements", id: m.id }));
    }
    case "checking_mv": {
      const m = dbi.prepare(`SELECT id, account_id, note FROM movements WHERE id = ?`).get(key.movementId) as
        | { id: number; account_id: number | null; note: string | null }
        | undefined;
      // A cartola row is keyed by its cartola identity; its movement-id key is read by nothing.
      if (!m || (m.account_id != null && cartolaNoteFields(m.note) != null)) return [];
      return [{ table: "movements", id: m.id }];
    }
    case "gap_mirror":
      // The synthetic mirrors were retired (migration 294): a mirror key names nothing.
      return [];
    case "manual":
      return (
        dbi.prepare(`SELECT id FROM expense_entries WHERE id = ? AND expense_account_id IS NULL`).all(key.entryId) as { id: number }[]
      ).map((r) => ({ table: "expense_entries", id: r.id }));
    case "payslip":
      // Payslip deduction lines carry no assignment (their category is fixed); no flow in step 3.
      return [];
    case "split":
      return rowsForBaseKey(dbi, key.base);
  }
}

/**
 * A plan identity: the plans that carry it (with the total when the key has one) and the cuota lines
 * paid against them; with no total, the statement cuota lines of that identity (their plan is unknown
 * or ambiguous — the key the line builder falls back to).
 */
function rowsForInstallmentH(dbi: DatabaseType, key: Extract<ExpenseKey, { kind: "installment_h" }>): FlowSourceRow[] {
  const plans = (
    dbi
      .prepare(
        `SELECT id, merchant, total_amount_clp FROM cc_installment_purchases
         WHERE account_id = ? AND date(purchase_date) = date(?) AND cuotas_totales = ? ORDER BY id`
      )
      .all(key.accountId, key.purchaseIso, key.cuotasTotal) as { id: number; merchant: string | null; total_amount_clp: number }[]
  ).filter((p) => normalizeMerchantText(p.merchant) === key.merchantKey);
  if (key.totalClp != null) {
    const matched = plans.filter((p) => Math.round(p.total_amount_clp) === key.totalClp);
    if (matched.length === 0) return [];
    const ids = matched.map((p) => p.id);
    const lines = dbi
      .prepare(
        `SELECT DISTINCT l.id FROM cc_statement_lines l
         JOIN cc_installment_payments pay ON pay.parser_row_id = l.parser_row_id
         WHERE l.installment_flag = 1 AND pay.purchase_id IN (${ids.map(() => "?").join(",")})`
      )
      .all(...ids) as { id: number }[];
    return [
      ...ids.map((id) => ({ table: "cc_installment_purchases" as const, id })),
      ...lines.map((l) => ({ table: "cc_statement_lines" as const, id: l.id })),
    ];
  }
  // The line builder falls back to the identity-only key only when it finds no plan total for the
  // line: no payment row, and the identity's plans carry no single total its printed cuota picks.
  const totals = [...new Set(plans.map((p) => Math.round(p.total_amount_clp)))];
  if (totals.length === 1) return [];
  const paid = dbi.prepare(`SELECT 1 FROM cc_installment_payments WHERE parser_row_id = ? LIMIT 1`);
  return linesWhere(dbi, `s.account_id = ? AND l.installment_flag = 1 AND l.nro_cuota_total = ?`, key.accountId, key.cuotasTotal)
    .filter((l) => lineIso(l) === key.purchaseIso && normalizeMerchantText(l.merchant) === key.merchantKey)
    .filter((l) => !hasRealParserRow(l.parser_row_id) || paid.get(String(l.parser_row_id).trim()) == null)
    .filter((l) => {
      const v = l.valor_cuota_mensual_clp;
      if (totals.length < 2 || v == null || !(v > 0)) return true;
      return totals.filter((t) => Math.abs(t / key.cuotasTotal - v) <= 1).length !== 1;
    })
    .map((l) => ({ table: "cc_statement_lines", id: l.id }));
}

/** The rows a stored key names (see the module comment); null when the text is not a key. */
export function resolveExpenseKey(dbi: DatabaseType, text: string): ResolvedExpenseKey | null {
  const parts = expenseKeyParts(text);
  if (!parts) return null;
  const base = parseExpenseKey(parts.flowKey)!;
  return { ...parts, rows: rowsForBaseKey(dbi, base) };
}
