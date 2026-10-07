import { db } from "./db.js";
import { isCheckingCredit } from "./checkingCartolaLoaders.js";
import {
  cartolaDescriptionFromNote,
} from "./checkingDescriptionPredicates.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { incomeKindByMovementId } from "./flowsPayrollWorkEarnings.js";

export const CHECKING_INCOME_KINDS = [
  "salary",
  "severance",
  "other",
  "parent_gift",
  "card_reimbursement",
] as const;

/**
 * `card_reimbursement` is not income: an additional cardholder paying back the charges his
 * plastics made on the user's card (auto-tagged `no_cuenta`, out of the user's gastos). The income
 * payload lists those credits apart (`card_reimbursement_lines`) and the expenses payload sets them
 * against the charges (`additionalCardReimbursements.ts`).
 */
export type CheckingIncomeKind = (typeof CHECKING_INCOME_KINDS)[number];

export function isCheckingIncomeKind(value: unknown): value is CheckingIncomeKind {
  return typeof value === "string" && (CHECKING_INCOME_KINDS as readonly string[]).includes(value);
}

type OverrideRow = {
  movement_id: number;
  is_excluded: number;
  force_include: number;
  income_kind: CheckingIncomeKind | null;
  note: string | null;
};

export function loadForceIncludedCheckingIncomeMovementIds(): Set<number> {
  const rows = db
    .prepare(
      `SELECT movement_id FROM checking_income_movement_overrides
       WHERE force_include = 1 AND is_excluded = 0`
    )
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function loadExcludedCheckingIncomeMovementIds(): Set<number> {
  const rows = db
    .prepare(
      `SELECT movement_id FROM checking_income_movement_overrides WHERE is_excluded = 1`
    )
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function loadCheckingIncomeKindOverrides(): Map<number, CheckingIncomeKind> {
  const rows = db
    .prepare(
      `SELECT movement_id, income_kind
       FROM checking_income_movement_overrides
       WHERE is_excluded = 0 AND income_kind IS NOT NULL`
    )
    .all() as { movement_id: number; income_kind: CheckingIncomeKind }[];
  const out = new Map<number, CheckingIncomeKind>();
  for (const row of rows) {
    out.set(row.movement_id, row.income_kind);
  }
  return out;
}

/** Checking credits classified as additional-card reimbursements (never income). */
export function loadCardReimbursementMovementIds(): Set<number> {
  const rows = db
    .prepare(
      `SELECT movement_id FROM checking_income_movement_overrides
       WHERE is_excluded = 0 AND income_kind = 'card_reimbursement'`
    )
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export type CardReimbursementCredit = {
  movement_id: number;
  received_on: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
};

/** The reimbursement credits with their CLP leg, oldest first. */
export function loadCardReimbursementCredits(): CardReimbursementCredit[] {
  const rows = db
    .prepare(
      `SELECT m.id AS movement_id, m.occurred_on AS received_on, ${MOVEMENT_CLP_LEG_SQL} AS amount_clp
       FROM checking_income_movement_overrides o
       JOIN movements m ON m.id = o.movement_id
       WHERE o.is_excluded = 0 AND o.income_kind = 'card_reimbursement'
       ORDER BY m.occurred_on, m.id`
    )
    .all() as { movement_id: number; received_on: string; amount_clp: number }[];
  return rows.map((row) => {
    if (!(row.amount_clp > 0)) {
      throw new Error(
        `card reimbursement movement ${row.movement_id} has no positive CLP leg (${row.amount_clp})`
      );
    }
    const amount_clp = Math.round(row.amount_clp);
    return {
      movement_id: row.movement_id,
      received_on: row.received_on,
      amount_clp,
      amount_usd: clpToUsdAtDate(amount_clp, row.received_on),
    };
  });
}

export function mergedIncomeKindByMovementIdRecord(): Record<number, CheckingIncomeKind> {
  const payrollKinds = incomeKindByMovementId();
  const overrides = loadCheckingIncomeKindOverrides();
  const out: Record<number, CheckingIncomeKind> = {};

  for (const [movementId, kind] of payrollKinds) {
    out[movementId] = overrides.get(movementId) ?? kind;
  }
  for (const [movementId, kind] of overrides) {
    if (!(movementId in out)) {
      out[movementId] = kind;
    }
  }
  return out;
}

export function assertCheckingCreditMovement(movementId: number): void {
  if (!isCheckingCredit(movementId)) {
    throw new Error(`movement ${movementId} is not a checking credit`);
  }
}

export function upsertCheckingIncomeMovementOverride(
  movementId: number,
  patch: {
    excluded?: boolean;
    force_include?: boolean;
    income_kind?: CheckingIncomeKind;
    note?: string | null;
  }
): OverrideRow {
  assertCheckingCreditMovement(movementId);

  const existing = db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note
       FROM checking_income_movement_overrides WHERE movement_id = ?`
    )
    .get(movementId) as OverrideRow | undefined;

  const is_excluded =
    patch.excluded !== undefined ? (patch.excluded ? 1 : 0) : (existing?.is_excluded ?? 0);
  const force_include =
    patch.force_include !== undefined
      ? patch.force_include
        ? 1
        : 0
      : (existing?.force_include ?? 0);
  const income_kind =
    patch.income_kind !== undefined ? patch.income_kind : (existing?.income_kind ?? null);
  const note = patch.note !== undefined ? patch.note : (existing?.note ?? null);

  if (
    is_excluded === 0 &&
    force_include === 0 &&
    income_kind == null &&
    note == null &&
    !existing
  ) {
    throw new Error("income_kind, excluded, force_include, or note required");
  }

  if (is_excluded === 1 && force_include === 1) {
    throw new Error("movement cannot be both excluded and force-included");
  }

  db.prepare(
    `INSERT INTO checking_income_movement_overrides (movement_id, is_excluded, force_include, income_kind, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(movement_id) DO UPDATE SET
       is_excluded = excluded.is_excluded,
       force_include = excluded.force_include,
       income_kind = excluded.income_kind,
       note = excluded.note,
       updated_at = datetime('now')`
  ).run(movementId, is_excluded, force_include, income_kind, note);

  return db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note
       FROM checking_income_movement_overrides WHERE movement_id = ?`
    )
    .get(movementId) as OverrideRow;
}

export function deleteCheckingIncomeMovementOverride(movementId: number): void {
  db.prepare(`DELETE FROM checking_income_movement_overrides WHERE movement_id = ?`).run(
    movementId
  );
}

export function restoreCheckingIncomeMovement(movementId: number): void {
  const existing = db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note
       FROM checking_income_movement_overrides WHERE movement_id = ?`
    )
    .get(movementId) as OverrideRow | undefined;
  if (!existing || existing.is_excluded !== 1) {
    throw new Error(`movement ${movementId} is not excluded from income`);
  }
  if (existing.force_include === 1) {
    throw new Error(`movement ${movementId} is force-included; clear force_include first`);
  }
  if (existing.income_kind == null && existing.note == null) {
    deleteCheckingIncomeMovementOverride(movementId);
    return;
  }
  upsertCheckingIncomeMovementOverride(movementId, { excluded: false });
}

export function clearCheckingIncomeForceInclude(movementId: number): void {
  const existing = db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note
       FROM checking_income_movement_overrides WHERE movement_id = ?`
    )
    .get(movementId) as OverrideRow | undefined;
  if (!existing || existing.force_include !== 1) {
    throw new Error(`movement ${movementId} is not force-included`);
  }
  if (existing.is_excluded === 1) {
    throw new Error(`movement ${movementId} is excluded`);
  }
  if (existing.income_kind == null && existing.note == null) {
    deleteCheckingIncomeMovementOverride(movementId);
    return;
  }
  upsertCheckingIncomeMovementOverride(movementId, { force_include: false });
}

export type FlowExcludedCheckingIncomeLine = {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  amount_usd: number | null;
  description: string;
  note: string | null;
};

export function loadExcludedCheckingIncomeLines(): FlowExcludedCheckingIncomeLine[] {
  const rows = db
    .prepare(
      `SELECT
         m.id AS movement_id,
         m.account_id,
         m.occurred_on AS received_on,
         (CASE WHEN m.currency = 'clp' THEN m.amount WHEN m.counter_currency = 'clp' THEN m.counter_amount ELSE 0 END) AS amount_clp,
         m.note AS cartola_note,
         o.note AS override_note,
         a.name AS account_label
       FROM checking_income_movement_overrides o
       JOIN movements m ON m.id = o.movement_id
       JOIN accounts a ON a.id = m.account_id
       WHERE o.is_excluded = 1
       ORDER BY m.occurred_on DESC, m.id DESC`
    )
    .all() as {
    movement_id: number;
    account_id: number;
    received_on: string;
    amount_clp: number;
    cartola_note: string | null;
    override_note: string | null;
    account_label: string;
  }[];

  return rows.map((row) => {
    const amount_clp = Math.round(row.amount_clp);
    return {
      movement_id: row.movement_id,
      account_id: row.account_id,
      account_label: row.account_label,
      received_on: row.received_on,
      amount_clp,
      amount_usd: clpToUsdAtDate(amount_clp, row.received_on),
      description: cartolaDescriptionFromNote(row.cartola_note),
      note: row.override_note,
    };
  });
}
