/**
 * Form 1040 as filed (`us_f1040_returns` + `us_f1040_filed_lines`, migration 301; lines stored as
 * roles in the 2024 numbering, `f1040RoleOfPrintedLine` turns a form's printed numbers into them) and how it was
 * settled (`us_f1040_settlements`): the IRS refund credited to, or the payment debited from, a
 * dollar account, by its movement. The writers are what the demo generator's April loop calls
 * (`recordFiledF1040`, `linkF1040Settlement`); the 1040 page reads `filedF1040` and
 * `f1040Settlement`.
 */
import { db } from "../db.js";
import { assertF1040Identities, isF1040Line, type F1040Lines } from "./identities.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "../movementTransfer.js";
import { US_FILING_STATUSES, type UsFilingStatus } from "../usLegalParameters.js";

export type FiledF1040 = {
  taxYear: number;
  filingStatus: UsFilingStatus;
  filedOn: string;
  sourceFile: string;
  lines: F1040Lines;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function sameReturn(a: FiledF1040, b: FiledF1040): boolean {
  if (a.filingStatus !== b.filingStatus || a.filedOn !== b.filedOn || a.sourceFile !== b.sourceFile) return false;
  const keys = new Set([...Object.keys(a.lines), ...Object.keys(b.lines)]);
  return [...keys].every((k) => (a.lines as Record<string, number>)[k] === (b.lines as Record<string, number>)[k]);
}

/**
 * Stores a filed return. Its lines must be whole dollars and satisfy the form's arithmetic
 * (`assertF1040Identities`); a line at 0 may be left out. Write-once: the same return again is a
 * no-op, a different one for a year already stored throws (an amended return is not modelled).
 */
export function recordFiledF1040(r: FiledF1040): void {
  if (!Number.isInteger(r.taxYear)) throw new Error(`1040: tax year ${r.taxYear}`);
  if (!US_FILING_STATUSES.includes(r.filingStatus)) throw new Error(`1040 ${r.taxYear}: filing status ${r.filingStatus}`);
  if (!ISO_DAY.test(r.filedOn)) throw new Error(`1040 ${r.taxYear}: filed on «${r.filedOn}» is not YYYY-MM-DD`);
  if (r.filedOn <= `${r.taxYear}-12-31`) throw new Error(`1040 ${r.taxYear}: filed on ${r.filedOn}, before the year ended`);
  for (const k of Object.keys(r.lines)) if (!isF1040Line(k)) throw new Error(`1040 ${r.taxYear}: unknown line ${k}`);
  assertF1040Identities(r.lines, `${r.taxYear} (filed)`, r.taxYear);
  const stored = filedF1040(r.taxYear);
  if (stored) {
    if (sameReturn(stored, r)) return;
    throw new Error(`1040 ${r.taxYear}: a different return is already stored (filed ${stored.filedOn}, ${stored.sourceFile})`);
  }
  const insLine = db.prepare(`INSERT INTO us_f1040_filed_lines (tax_year, line, amount) VALUES (?, ?, ?)`);
  db.transaction(() => {
    db.prepare(`INSERT INTO us_f1040_returns (tax_year, filing_status, filed_on, source_file) VALUES (?, ?, ?, ?)`).run(
      r.taxYear,
      r.filingStatus,
      r.filedOn,
      r.sourceFile
    );
    for (const [line, amount] of Object.entries(r.lines)) insLine.run(r.taxYear, line, amount);
  })();
}

/** The filed return of a tax year, or null when none is stored. */
export function filedF1040(taxYear: number): FiledF1040 | null {
  const head = db
    .prepare(`SELECT tax_year, filing_status, filed_on, source_file FROM us_f1040_returns WHERE tax_year = ?`)
    .get(taxYear) as { tax_year: number; filing_status: UsFilingStatus; filed_on: string; source_file: string } | undefined;
  if (!head) return null;
  const rows = db.prepare(`SELECT line, amount FROM us_f1040_filed_lines WHERE tax_year = ?`).all(taxYear) as {
    line: string;
    amount: number;
  }[];
  const lines: F1040Lines = {};
  for (const r of rows) {
    if (!isF1040Line(r.line)) throw new Error(`1040 ${taxYear}: stored line ${r.line} is not a known line`);
    lines[r.line] = r.amount;
  }
  return { taxYear, filingStatus: head.filing_status, filedOn: head.filed_on, sourceFile: head.source_file, lines };
}

export function filedF1040TaxYears(): number[] {
  return (db.prepare(`SELECT tax_year FROM us_f1040_returns ORDER BY tax_year`).all() as { tax_year: number }[]).map((r) => r.tax_year);
}

/** What a filed return asks for: the refund (line 35a) or the payment (line 37); null at zero. */
export function f1040ExpectedSettlement(lines: F1040Lines): { kind: "refund" | "payment"; amount: number } | null {
  const refund = lines["35a"] ?? 0;
  const owed = lines["37"] ?? 0;
  if (refund > 0 && owed > 0) throw new Error(`1040: both a refund (${refund}) and an amount owed (${owed})`);
  if (refund > 0) return { kind: "refund", amount: refund };
  if (owed > 0) return { kind: "payment", amount: owed };
  return null;
}

/**
 * Links the movement that settled a filed return: a single-leg dollar credit (the refund) or debit
 * (the payment) on the account it landed on. The kind follows the movement's direction and must be
 * what the return asks for; the amount is the movement's (an IRS refund paid late carries
 * interest, so it may exceed line 35a). Linking the same movement again is a no-op.
 */
export function linkF1040Settlement(input: { taxYear: number; movementId: number; description: string }): void {
  const filed = filedF1040(input.taxYear);
  if (!filed) throw new Error(`1040 ${input.taxYear}: no filed return to settle`);
  const expected = f1040ExpectedSettlement(filed.lines);
  if (!expected) throw new Error(`1040 ${input.taxYear}: the filed return settles at zero`);
  const m = db.prepare(`SELECT * FROM movements WHERE id = ?`).get(input.movementId) as MovementTransferRow | undefined;
  if (!m) throw new Error(`1040 ${input.taxYear}: no movement ${input.movementId}`);
  if (m.account_id == null || m.from_account_id != null || m.to_account_id != null) {
    throw new Error(`1040 ${input.taxYear}: movement ${input.movementId} is not a single-leg movement`);
  }
  if (m.currency !== "usd") throw new Error(`1040 ${input.taxYear}: movement ${input.movementId} is in ${m.currency}, not dollars`);
  const signed = signedNativeDeltaForAccountMovement(m, m.account_id, "usd");
  if (signed === 0) throw new Error(`1040 ${input.taxYear}: movement ${input.movementId} moves no dollars`);
  const kind = signed > 0 ? "refund" : "payment";
  if (kind !== expected.kind) {
    throw new Error(`1040 ${input.taxYear}: movement ${input.movementId} is a ${kind}, the filed return asks for a ${expected.kind}`);
  }
  const existing = db.prepare(`SELECT tax_year FROM us_f1040_settlements WHERE movement_id = ?`).get(input.movementId) as
    | { tax_year: number }
    | undefined;
  if (existing) {
    if (existing.tax_year !== input.taxYear) {
      throw new Error(`1040 ${input.taxYear}: movement ${input.movementId} already settles ${existing.tax_year}`);
    }
    return;
  }
  db.prepare(
    `INSERT INTO us_f1040_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.taxYear, kind, m.account_id, input.movementId, m.occurred_on, Math.abs(signed), input.description);
}

export type F1040SettlementLink = {
  kind: "refund" | "payment";
  account_id: number;
  account_name: string;
  movement_id: number;
  occurred_on: string;
  amount: number;
  description: string;
};

export type F1040Settlement = {
  expected: { kind: "refund" | "payment"; amount: number } | null;
  links: F1040SettlementLink[];
  settled: number;
  /** settled − expected (a late refund's interest); null with nothing linked. */
  difference: number | null;
};

/** How a filed return was settled; null without a filed return. */
export function f1040Settlement(taxYear: number): F1040Settlement | null {
  const filed = filedF1040(taxYear);
  if (!filed) return null;
  const expected = f1040ExpectedSettlement(filed.lines);
  const links = db
    .prepare(
      `SELECT s.kind, s.account_id, a.name AS account_name, s.movement_id, s.occurred_on, s.amount, s.description
         FROM us_f1040_settlements s JOIN accounts a ON a.id = s.account_id
        WHERE s.tax_year = ? ORDER BY s.occurred_on, s.id`
    )
    .all(taxYear) as F1040SettlementLink[];
  const settled = Math.round(links.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return {
    expected,
    links,
    settled,
    difference: expected && links.length ? Math.round((settled - expected.amount) * 100) / 100 : null,
  };
}
