import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { db } from "./db.js";
import { movementFlowId } from "./flows/flowIdentity.js";
import { isCheckingCredit } from "./checkingCartolaLoaders.js";
import {
  cartolaDescriptionFromNote,
} from "./checkingDescriptionPredicates.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import { incomeKindByMovementId } from "./flowsPayrollWorkEarnings.js";


/**
 * The user's income classification by movement: it hangs off the credit's flow
 * (`flow_income_overrides`, migration 281), so it follows the flow when the cartola row takes over a
 * daily row's.
 */
const INCOME_OVERRIDES_BY_MOVEMENT = `(SELECT m.id AS movement_id, o.is_excluded, o.force_include, o.income_kind, o.note, o.rent_place_id, o.updated_at
  FROM flow_income_overrides o JOIN movements m ON m.flow_id = o.flow_id)`;

export const CHECKING_INCOME_KINDS = [
  "salary",
  "severance",
  "other",
  "parent_gift",
  /** Rent of a tracked place (`expense_accounts`): the override names the place (`rent_place_id`). */
  "rent",
] as const;

/**
 * Money that pays back spending (a shared expense, an additional cardholder's charges) is not an
 * income kind: it is a refund (`checkingExpenseRefunds.ts`), out of income and netted in gastos.
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
  rent_place_id: number | null;
};

export function loadForceIncludedCheckingIncomeMovementIds(): Set<number> {
  const rows = db
    .prepare(
      `SELECT movement_id FROM ${INCOME_OVERRIDES_BY_MOVEMENT}
       WHERE force_include = 1 AND is_excluded = 0`
    )
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function loadExcludedCheckingIncomeMovementIds(): Set<number> {
  const rows = db
    .prepare(
      `SELECT movement_id FROM ${INCOME_OVERRIDES_BY_MOVEMENT} WHERE is_excluded = 1`
    )
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function loadCheckingIncomeKindOverrides(): Map<number, CheckingIncomeKind> {
  const rows = db
    .prepare(
      `SELECT movement_id, income_kind
       FROM ${INCOME_OVERRIDES_BY_MOVEMENT}
       WHERE is_excluded = 0 AND income_kind IS NOT NULL`
    )
    .all() as { movement_id: number; income_kind: CheckingIncomeKind }[];
  const out = new Map<number, CheckingIncomeKind>();
  for (const row of rows) {
    out.set(row.movement_id, row.income_kind);
  }
  return out;
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
    /** The place a `rent` credit is the rent of (required with `rent`, refused with any other kind). */
    rent_place_slug?: string;
    note?: string | null;
  }
): OverrideRow {
  assertCheckingCreditMovement(movementId);
  if (patch.rent_place_slug !== undefined && patch.income_kind !== "rent") {
    throw new Error("rent_place_slug is only set with income_kind rent");
  }

  const existing = db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note, rent_place_id
       FROM ${INCOME_OVERRIDES_BY_MOVEMENT} WHERE movement_id = ?`
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
  // A rent names its place; another kind names none (the table's CHECK holds the same).
  const rent_place_id =
    income_kind !== "rent"
      ? null
      : patch.rent_place_slug !== undefined
        ? rentPlaceIdForSlug(patch.rent_place_slug)
        : (existing?.rent_place_id ?? null);
  if (income_kind === "rent" && rent_place_id == null) {
    throw new Error("a rent names the place it is the rent of (rent_place_slug)");
  }

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
    `INSERT INTO flow_income_overrides (flow_id, is_excluded, force_include, income_kind, note, rent_place_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(flow_id) DO UPDATE SET
       is_excluded = excluded.is_excluded,
       force_include = excluded.force_include,
       income_kind = excluded.income_kind,
       note = excluded.note,
       rent_place_id = excluded.rent_place_id,
       updated_at = datetime('now')`
  ).run(movementFlowId(movementId), is_excluded, force_include, income_kind, note, rent_place_id);

  return db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note, rent_place_id
       FROM ${INCOME_OVERRIDES_BY_MOVEMENT} WHERE movement_id = ?`
    )
    .get(movementId) as OverrideRow;
}

/** The id of a tracked place (an `expense_accounts` row under the real_estate group), by slug. */
function rentPlaceIdForSlug(slug: string): number {
  const r = db
    .prepare(
      `SELECT a.id FROM expense_accounts a JOIN expense_groups g ON g.id = a.group_id
        WHERE g.slug = 'real_estate' AND a.slug = ?`
    )
    .get(slug) as { id: number } | undefined;
  if (!r) throw new Error(`unknown place '${slug}'`);
  return r.id;
}

/** The place slug each rent credit names, by movement (excluded credits left out). */
export function loadRentPlaceSlugByMovementId(): Record<number, string> {
  const rows = db
    .prepare(
      `SELECT o.movement_id, a.slug
         FROM ${INCOME_OVERRIDES_BY_MOVEMENT} o
         JOIN expense_accounts a ON a.id = o.rent_place_id
        WHERE o.income_kind = 'rent' AND o.is_excluded = 0`
    )
    .all() as { movement_id: number; slug: string }[];
  return Object.fromEntries(rows.map((r) => [r.movement_id, r.slug]));
}

/** One rent credit: the place it is the rent of, its day and its pesos. */
export type RentCredit = { movementId: number; placeId: number; receivedOn: string; amountClp: number };

/**
 * The rent credits received in a year, from the user's classification (`income_kind = 'rent'`):
 * a credit excluded from income is left out. A rent must be a peso credit (a dollar one throws: the
 * F22 has no rule for it here), and a flow carries one movement.
 */
export function loadRentCreditsForYear(year: number): RentCredit[] {
  const rows = db
    .prepare(
      `SELECT o.movement_id, o.rent_place_id, m.occurred_on, m.flow_id, ${MOVEMENT_CLP_LEG_SQL} AS amount_clp
         FROM ${INCOME_OVERRIDES_BY_MOVEMENT} o
         JOIN movements m ON m.id = o.movement_id
        WHERE o.income_kind = 'rent' AND o.is_excluded = 0 AND m.occurred_on LIKE ?
        ORDER BY m.occurred_on, m.id`
    )
    .all(`${year}-%`) as { movement_id: number; rent_place_id: number; occurred_on: string; flow_id: number; amount_clp: number }[];
  const flows = new Set<number>();
  return rows.map((r) => {
    if (flows.has(r.flow_id)) throw new Error(`rent flow ${r.flow_id} carries more than one movement`);
    flows.add(r.flow_id);
    if (!(r.amount_clp > 0)) throw new Error(`rent movement ${r.movement_id} is not a peso credit`);
    return { movementId: r.movement_id, placeId: r.rent_place_id, receivedOn: r.occurred_on, amountClp: r.amount_clp };
  });
}

export function deleteCheckingIncomeMovementOverride(movementId: number): void {
  db.prepare(`DELETE FROM flow_income_overrides WHERE flow_id = ?`).run(movementFlowId(movementId));
}

export function restoreCheckingIncomeMovement(movementId: number): void {
  const existing = db
    .prepare(
      `SELECT movement_id, is_excluded, force_include, income_kind, note, rent_place_id
       FROM ${INCOME_OVERRIDES_BY_MOVEMENT} WHERE movement_id = ?`
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
      `SELECT movement_id, is_excluded, force_include, income_kind, note, rent_place_id
       FROM ${INCOME_OVERRIDES_BY_MOVEMENT} WHERE movement_id = ?`
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
         ${MOVEMENT_CLP_LEG_SQL} AS amount_clp,
         m.note AS cartola_note,
         o.note AS override_note,
         a.name AS account_label
       FROM ${INCOME_OVERRIDES_BY_MOVEMENT} o
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
