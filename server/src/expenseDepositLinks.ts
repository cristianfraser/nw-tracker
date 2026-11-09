import { dayWithinWindow } from "nw-tracker-contracts";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { lenderMerchantPatterns } from "./accountRoles.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import {
  type ParsedDepositMatchSegment,
} from "./ccExpenseDepositMatchNotes.js";
import {
  BILLS_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { withoutChurn } from "./rederivation.js";
import { EXPENSE_KEY_PREFIXES } from "./expenseKeys.js";
import {
  loadDepositMatchCandidates,
  type DepositMatchCandidate,
} from "./checkingCartolaLoaders.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  MOVEMENT_CLP_LEG_SQL,
  movementClpLegOrZero,
  type MovementAmountFields,
} from "./movementAmounts.js";
import {
  assertDeptoLoanPaymentCurrencies,
  loanPaymentRowForMovementId,
  isDeptoPieCuota,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { movementFlowId } from "./flows/flowIdentity.js";
import { keyTarget, TARGET_WHERE, targetParams } from "./flows/flowKeyedAssignments.js";
import { EXPENSE_DEPOSIT_LINKS_SQL } from "./flows/flowLinks.js";

export { BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG };

/** Max days between CC purchase_on and depto sheet occurred_on for mortgage cuota match. */
export const MORTGAGE_CC_PURCHASE_DAY_GAP = MATCH_WINDOWS.mortgage_cuota_stored_link.daysAfter;

/** Priority for conflict resolution when the same (purchase_key, deposit_movement_id) pair is
 *  written by more than one path: manual (user-curated) > auto (real checking/CC match) >
 *  synthetic (the retired fabricated mirrors, migration 294: nothing writes it any more). */
export type ExpenseDepositLinkSource = "auto" | "manual" | "synthetic";

export type ExpenseDepositLinkRow = {
  account_id: number;
  purchase_key: string;
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: ExpenseDepositLinkSource;
  /** The linked mortgage payment's parts (`EXPENSE_DEPOSIT_LINKS_SQL`); null or absent on any other deposit. */
  parts_amortization_clp?: number | null;
  parts_carrying_clp?: number | null;
};

export type ExpenseDepositLinkDto = {
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  carrying_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: ExpenseDepositLinkSource;
};

export type GastosLineForExpenseDepositLink = Pick<
  FlowCcExpenseLineRow,
  | "source"
  | "account_id"
  | "purchase_key"
  | "category_slug"
  | "amount_clp"
  | "purchase_notes"
  | "merchant"
  | "purchase_on"
  | "occurred_on"
  | "deposit_match"
>;

export function carryingClpForExpenseDepositLink(link: {
  payment_clp: number;
  amortization_clp: number;
}): number {
  const carrying = Math.round(link.payment_clp) - Math.round(link.amortization_clp);
  if (carrying < 0) {
    throw new Error(
      `expense deposit link carrying < 0: payment ${link.payment_clp} amort ${link.amortization_clp}`
    );
  }
  return carrying;
}

/**
 * A link to a mortgage payment splits the card line by the payment's PARTS — amortization =
 * principal + extra principal, carrying = interest + insurances (F20 «Parts»; the ledger's statement
 * of the dividendo, the same figures the real-estate page shows). Whatever the card paid above the
 * parts (the lender re-processed a cuota; its own row short of its total) is neither: it stays
 * out of both and is a declared difference (`accepted_differences`), never silently absorbed. Any
 * other deposit's carrying is the payment less the amortization, as before.
 */
export function expenseDepositLinkDto(row: ExpenseDepositLinkRow): ExpenseDepositLinkDto {
  const carrying =
    row.parts_carrying_clp != null ? row.parts_carrying_clp : carryingClpForExpenseDepositLink(row);
  return {
    deposit_movement_id: row.deposit_movement_id,
    payment_clp: row.payment_clp,
    amortization_clp: row.parts_amortization_clp ?? row.amortization_clp,
    carrying_clp: carrying,
    depto_cuota: row.depto_cuota,
    depto_occurred_on: row.depto_occurred_on,
    link_source: row.link_source,
  };
}

export function hasSplittableMortgageExpenseDepositLink(
  link: ExpenseDepositLinkDto | undefined
): link is ExpenseDepositLinkDto {
  return (
    link != null &&
    link.amortization_clp > 0 &&
    link.carrying_clp > 0 &&
    link.carrying_clp < link.payment_clp
  );
}

/**
 * A card merchant that pays the depto mortgage: one of the loan's lender patterns
 * (`lender_pattern` role, `accountRoles.ts`) — every word of a pattern in the merchant.
 */
export function isMortgageCcExpenseMerchant(merchant: string | null | undefined): boolean {
  const key = normalizeCcExpenseMerchantKey(merchant ?? "");
  if (!key) return false;
  return lenderMerchantPatterns().some((words) => words.every((w) => key.includes(w)));
}

/**
 * A SQL prefilter (`UPPER(<column>) LIKE …` alternatives) that is a superset of
 * {@link isMortgageCcExpenseMerchant}: each pattern's first word. Never matches when no loan has a
 * lender pattern.
 */
export function mortgageLenderMerchantSqlPrefilter(column: string): { sql: string; params: string[] } {
  const firsts = [...new Set(lenderMerchantPatterns().map((w) => w[0]!).filter(Boolean))];
  if (firsts.length === 0) return { sql: "0", params: [] };
  return { sql: `(${firsts.map(() => `UPPER(${column}) LIKE ?`).join(" OR ")})`, params: firsts.map((w) => `%${w}%`) };
}

export function isRegularMortgageCuotaSheetRow(row: DeptoMortgageSheetRow): boolean {
  const cuota = String(row.cuota).trim();
  if (!cuota || /^prepago\b/i.test(cuota) || /^pie\b/i.test(cuota)) return false;
  const amort =
    Math.round(row.amortizacion_clp ?? 0) + Math.round(row.amortizacion_ext_clp ?? 0);
  return amort > 0 && Math.round(row.pago_clp) > 0;
}

export function amortizationClpFromSheetRow(row: DeptoMortgageSheetRow): number {
  const amort =
    Math.round(row.amortizacion_clp ?? 0) + Math.round(row.amortizacion_ext_clp ?? 0);
  if (amort <= 0) {
    throw new Error(`depto sheet cuota ${row.cuota} has no amortization`);
  }
  return amort;
}

function purchaseDateForGastosLine(line: GastosLineForExpenseDepositLink): string {
  return String(line.purchase_on ?? line.occurred_on ?? "").trim();
}

function listRealEstatePropertyAccountIds(): number[] {
  const rows = db
    .prepare(
      `SELECT a.id, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE COALESCE(a.exclude_from_group_totals, 0) = 0`
    )
    .all() as { id: number; bucket_slug: string }[];
  return rows
    .filter((r) => {
      if (dashboardBucketForAssetGroupSlug(r.bucket_slug) !== "real_estate") return false;
      return accountBucketKindSlug(r.bucket_slug) === "property";
    })
    .map((r) => r.id);
}

function depositAccountDashboardGroup(accountId: number): string | null {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row) return null;
  return dashboardBucketForAssetGroupSlug(row.bucket_slug);
}

type DepositMovementRow = MovementAmountFields & {
  id: number;
  note: string | null;
  occurred_on: string;
};

function findDepositMovement(
  accountId: number,
  occurredOn: string,
  amountClp: number
): DepositMovementRow | null {
  const want = Math.round(amountClp);
  const rows = db
    .prepare(
      `SELECT id, note, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, occurred_on
       FROM movements
       WHERE account_id = ? AND occurred_on = ? AND ${MOVEMENT_CLP_LEG_SQL} > 0
       ORDER BY id`
    )
    .all(accountId, occurredOn) as DepositMovementRow[];

  const exact = rows.filter((r) => Math.round(movementClpLegOrZero(r)) === want);
  if (exact.length === 0) return null;
  if (exact.length === 1) return exact[0]!;

  const deptoRows = exact.filter((r) => loanPaymentRowForMovementId(r.id) != null);
  if (deptoRows.length === 1) return deptoRows[0]!;
  if (deptoRows.length > 1) {
    throw new Error(
      `ambiguous depto deposit movements for account ${accountId} ${occurredOn} ${want}`
    );
  }
  throw new Error(
    `ambiguous deposit movements for expense deposit link: account ${accountId} ${occurredOn} ${want}`
  );
}

/**
 * The deposit movement an auto-match segment names. A segment carrying the movement id (the
 * matcher claims each deposit movement on its own, so twin deposits — same account, day and pesos —
 * go to different outflows) resolves to that row; it must still be a deposit of the segment's
 * account, day and pesos, or the segment names nothing (a note saved with a since-changed row).
 * Notes written before the id was carried resolve by account, day and pesos, as they always did.
 */
function findDepositMovementForSegment(segment: ParsedDepositMatchSegment): DepositMovementRow | null {
  if (segment.movement_id == null) {
    return findDepositMovement(segment.account_id, segment.occurred_on, segment.amount_clp);
  }
  const row = db
    .prepare(
      `SELECT id, account_id, note, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, occurred_on
       FROM movements WHERE id = ?`
    )
    .get(segment.movement_id) as (DepositMovementRow & { account_id: number | null }) | undefined;
  if (row == null) return null;
  if (row.account_id !== segment.account_id || row.occurred_on !== segment.occurred_on) return null;
  const clp = Math.round(movementClpLegOrZero(row));
  if (clp <= 0 || clp !== Math.round(segment.amount_clp)) return null;
  return row;
}

function findPropertyDepositForSheetRow(
  sheet: DeptoMortgageSheetRow
): (DepositMovementRow & { account_id: number }) | null {
  const sheetPago = Math.round(sheet.pago_clp);
  let match: (DepositMovementRow & { account_id: number }) | null = null;

  for (const accountId of listRealEstatePropertyAccountIds()) {
    const movement = findDepositMovement(accountId, sheet.occurred_on, sheetPago);
    if (movement == null) continue;
    const payment = loanPaymentRowForMovementId(movement.id);
    if (payment != null && payment.cuota !== sheet.cuota) continue;
    if (payment != null && isDeptoPieCuota(payment.cuota)) continue;

    const candidate = { ...movement, account_id: accountId };
    if (match != null) {
      throw new Error(
        `ambiguous property deposit for depto cuota ${sheet.cuota} on ${sheet.occurred_on}`
      );
    }
    match = candidate;
  }
  return match;
}

export function findUniqueCcLineForMortgageSheetRow(
  lines: readonly GastosLineForExpenseDepositLink[],
  sheet: DeptoMortgageSheetRow,
  usedPurchaseKeys: ReadonlySet<string>
): GastosLineForExpenseDepositLink | null {
  const want = Math.round(sheet.pago_clp);
  const candidates = lines.filter((line) => {
    if (line.source !== "cc") return false;
    if (line.amount_clp <= 0) return false;
    if (usedPurchaseKeys.has(line.purchase_key)) return false;
    if (Math.round(line.amount_clp) !== want) return false;
    const purchaseDate = purchaseDateForGastosLine(line);
    if (!purchaseDate) return false;
    return dayWithinWindow(sheet.occurred_on, purchaseDate, MATCH_WINDOWS.mortgage_cuota_stored_link);
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const mortgageOnly = candidates.filter((line) => isMortgageCcExpenseMerchant(line.merchant));
  if (mortgageOnly.length === 1) return mortgageOnly[0]!;

  throw new Error(
    `ambiguous CC expense lines for depto cuota ${sheet.cuota} (${sheet.occurred_on}, ${want} CLP): ${candidates.map((c) => c.purchase_key).join(", ")}`
  );
}

function resolveAmortizationForDepositMovement(
  movement: DepositMovementRow,
  sheetRow?: DeptoMortgageSheetRow
): { amortization_clp: number; depto_cuota: string | null; depto_occurred_on: string } | null {
  const payment = loanPaymentRowForMovementId(movement.id);
  if (payment != null && isDeptoPieCuota(payment.cuota)) return null;

  if (sheetRow != null) {
    const amort = amortizationClpFromSheetRow(sheetRow);
    const paymentRef = Math.max(Math.round(movementClpLegOrZero(movement)), Math.round(sheetRow.pago_clp));
    if (amort > paymentRef) {
      throw new Error(
        `depto cuota ${sheetRow.cuota} amortization ${amort} exceeds payment ${paymentRef}`
      );
    }
    return {
      amortization_clp: amort,
      depto_cuota: sheetRow.cuota,
      depto_occurred_on: sheetRow.occurred_on,
    };
  }

  if (payment != null) {
    assertDeptoLoanPaymentCurrencies(payment);
    const fromRow =
      Math.round(payment.principal ?? 0) + Math.round(payment.extra_principal ?? 0);
    if (fromRow > 0) {
      const paymentRef = Math.round(movementClpLegOrZero(movement));
      if (fromRow > paymentRef) {
        throw new Error(
          `depto movement ${movement.id} amortization ${fromRow} exceeds payment ${paymentRef}`
        );
      }
      return {
        amortization_clp: fromRow,
        depto_cuota: payment.cuota,
        depto_occurred_on: movement.occurred_on,
      };
    }
  }
  return null;
}

function resolveAmortizationForSegment(
  segment: ParsedDepositMatchSegment,
  paymentClp: number
): {
  amortization_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string;
  movement_id: number;
} | null {
  const movement = findDepositMovementForSegment(segment);
  if (movement == null) return null;
  const amort = resolveAmortizationForDepositMovement(movement);
  if (amort == null) return null;

  return {
    ...amort,
    movement_id: movement.id,
  };
}

export function loadExpenseDepositLinksMap(): Map<string, ExpenseDepositLinkRow[]> {
  const rows = db
    .prepare(
      `SELECT account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp,
              depto_cuota, depto_occurred_on, link_source, parts_amortization_clp, parts_carrying_clp
       FROM ${EXPENSE_DEPOSIT_LINKS_SQL} ORDER BY link_order`
    )
    .all() as ExpenseDepositLinkRow[];
  const out = new Map<string, ExpenseDepositLinkRow[]>();
  for (const row of rows) {
    const arr = out.get(row.purchase_key);
    if (arr) arr.push(row);
    else out.set(row.purchase_key, [row]);
  }
  return out;
}

const LINK_SOURCE_PRIORITY: Record<ExpenseDepositLinkSource, number> = {
  manual: 3,
  auto: 2,
  synthetic: 1,
};

/** Best (highest-priority) link source per deposit movement id — manual > auto > synthetic. */
export function loadBestLinkSourceByMovementId(): Map<number, ExpenseDepositLinkSource> {
  const rows = db
    .prepare(`SELECT deposit_movement_id, link_source FROM ${EXPENSE_DEPOSIT_LINKS_SQL} ORDER BY link_order`)
    .all() as { deposit_movement_id: number; link_source: ExpenseDepositLinkSource }[];
  const out = new Map<number, ExpenseDepositLinkSource>();
  for (const row of rows) {
    const prev = out.get(row.deposit_movement_id);
    if (!prev || LINK_SOURCE_PRIORITY[row.link_source] > LINK_SOURCE_PRIORITY[prev]) {
      out.set(row.deposit_movement_id, row.link_source);
    }
  }
  return out;
}

/**
 * A purchase's link to the deposit it funded: a `funded_deposit` link from the purchase's flow to
 * the deposit's flow (migration 285; the claim is the deposit's flow, bug 8). A lower-priority
 * source never replaces a higher one; an equal or higher one rewrites the figures in place.
 */
function upsertExpenseDepositLink(row: ExpenseDepositLinkRow): void {
  const at = keyTarget(row.purchase_key, true);
  const counterpart = movementFlowId(row.deposit_movement_id);
  const existing = db
    .prepare(
      `SELECT rowid AS link_rowid, link_source FROM flow_links
       WHERE kind = 'funded_deposit' AND ${TARGET_WHERE} AND counterpart_flow_id = ?`
    )
    .get(...targetParams(at), counterpart) as { link_rowid: number; link_source: ExpenseDepositLinkSource } | undefined;
  if (existing && LINK_SOURCE_PRIORITY[existing.link_source] > LINK_SOURCE_PRIORITY[row.link_source]) {
    return;
  }
  const figures = [
    row.account_id,
    row.payment_clp,
    row.amortization_clp,
    row.depto_cuota,
    row.depto_occurred_on,
    row.link_source,
  ] as const;
  if (existing) {
    db.prepare(
      `UPDATE flow_links SET account_id = ?, payment_clp = ?, amortization_clp = ?, depto_cuota = ?,
         depto_occurred_on = ?, link_source = ?
       WHERE rowid = ?`
    ).run(...figures, existing.link_rowid);
    return;
  }
  db.prepare(
    `INSERT INTO flow_links (flow_id, portion, piece_seq, kind, counterpart_flow_id, account_id, payment_clp,
       amortization_clp, depto_cuota, depto_occurred_on, link_source)
     VALUES (?, ?, ?, 'funded_deposit', ?, ?, ?, ?, ?, ?, ?)`
  ).run(...targetParams(at), counterpart, ...figures);
}

/**
 * A hand-made `funded_deposit` link from a checking outflow to the deposit it funded (a script's
 * write: the prepago's cash leg). The outflow's deposit portion is what funded the deposit, as the
 * matcher writes it.
 */
export function insertManualFundedDepositLink(opts: {
  outflowMovementId: number;
  depositMovementId: number;
  paymentClp: number;
  deptoCuota?: string | null;
  deptoOccurredOn?: string | null;
}): void {
  const outflow = db.prepare(`SELECT account_id, flow_id FROM movements WHERE id = ?`).get(opts.outflowMovementId) as
    | { account_id: number | null; flow_id: number | null }
    | undefined;
  if (!outflow?.account_id || outflow.flow_id == null) {
    throw new Error(`manual deposit link: movement ${opts.outflowMovementId} is not a single-leg row with a flow`);
  }
  const counterpart = movementFlowId(opts.depositMovementId);
  const existing = db
    .prepare(
      `SELECT link_source FROM flow_links WHERE kind = 'funded_deposit' AND flow_id = ? AND portion = 'deposit' AND piece_seq = -1 AND counterpart_flow_id = ?`
    )
    .get(outflow.flow_id, counterpart) as { link_source: ExpenseDepositLinkSource } | undefined;
  if (existing) {
    throw new Error(`manual deposit link: movement ${opts.outflowMovementId} already links deposit ${opts.depositMovementId} (${existing.link_source})`);
  }
  db.prepare(
    `INSERT INTO flow_links (flow_id, portion, piece_seq, kind, counterpart_flow_id, account_id, payment_clp,
       amortization_clp, depto_cuota, depto_occurred_on, link_source)
     VALUES (?, 'deposit', -1, 'funded_deposit', ?, ?, ?, ?, ?, ?, 'manual')`
  ).run(
    outflow.flow_id,
    counterpart,
    outflow.account_id,
    Math.round(opts.paymentClp),
    Math.round(opts.paymentClp),
    opts.deptoCuota ?? null,
    opts.deptoOccurredOn ?? null
  );
}

/** The `funded_deposit` link from a checking outflow (either portion) to a deposit, if any. */
export function linkedFundedDepositOf(
  outflowMovementId: number,
  depositMovementId: number
): { payment_clp: number; link_source: ExpenseDepositLinkSource } | null {
  const row = db
    .prepare(
      `SELECT l.payment_clp, l.link_source FROM flow_links l
       WHERE l.kind = 'funded_deposit' AND l.flow_id = (SELECT flow_id FROM movements WHERE id = ?)
         AND l.counterpart_flow_id = (SELECT flow_id FROM movements WHERE id = ?)`
    )
    .get(outflowMovementId, depositMovementId) as { payment_clp: number; link_source: ExpenseDepositLinkSource } | undefined;
  return row ?? null;
}

function clearAutoExpenseDepositLinks(): void {
  db.prepare(`DELETE FROM flow_links WHERE kind = 'funded_deposit' AND link_source = 'auto'`).run();
}

export function syncMortgageExpenseDepositLinksFromSheet(
  lines: readonly GastosLineForExpenseDepositLink[]
): ExpenseDepositLinkRow[] {
  const manualKeys = new Set(
    (
      db
        .prepare(`SELECT purchase_key FROM ${EXPENSE_DEPOSIT_LINKS_SQL} WHERE link_source = 'manual' ORDER BY link_order`)
        .all() as { purchase_key: string }[]
    ).map((r) => r.purchase_key)
  );
  const usedPurchaseKeys = new Set(manualKeys);
  const created: ExpenseDepositLinkRow[] = [];

  for (const sheet of loadDeptoLedgerFromMovements()) {
    if (!isRegularMortgageCuotaSheetRow(sheet)) continue;

    const deposit = findPropertyDepositForSheetRow(sheet);
    if (deposit == null) continue;

    const ccLine = findUniqueCcLineForMortgageSheetRow(lines, sheet, usedPurchaseKeys);
    if (ccLine == null) continue;

    const amortization = amortizationClpFromSheetRow(sheet);
    const paymentClp = Math.round(ccLine.amount_clp);
    if (amortization >= paymentClp) continue;

    const carrying = carryingClpForExpenseDepositLink({
      payment_clp: paymentClp,
      amortization_clp: amortization,
    });
    if (carrying <= 0) continue;

    const link: ExpenseDepositLinkRow = {
      account_id: ccLine.account_id,
      purchase_key: ccLine.purchase_key,
      deposit_movement_id: deposit.id,
      payment_clp: paymentClp,
      amortization_clp: amortization,
      depto_cuota: sheet.cuota,
      depto_occurred_on: sheet.occurred_on,
      link_source: "auto",
    };
    upsertExpenseDepositLink(link);
    usedPurchaseKeys.add(ccLine.purchase_key);
    created.push(link);
  }
  return created;
}

export function tryAutoLinkExpenseDepositLine(line: {
  account_id: number;
  purchase_key: string;
  category_slug: string;
  amount_clp: number;
  deposit_match?: readonly ParsedDepositMatchSegment[];
}): ExpenseDepositLinkRow[] {
  if (line.category_slug !== DEPOSITS_CC_EXPENSE_SLUG) return [];
  if (line.amount_clp <= 0) return [];

  const segments = line.deposit_match ?? [];
  if (segments.length === 0) return [];

  const paymentClp = Math.round(line.amount_clp);
  const created: ExpenseDepositLinkRow[] = [];

  // Real-estate segment: amortization/carrying split (existing mortgage path).
  let realEstateSegment: ParsedDepositMatchSegment | null = null;
  for (const seg of segments) {
    if (depositAccountDashboardGroup(seg.account_id) !== "real_estate") continue;
    if (realEstateSegment != null) {
      throw new Error(
        `expense deposit auto-link: multiple real_estate segments for ${line.purchase_key}`
      );
    }
    realEstateSegment = seg;
  }
  if (realEstateSegment != null) {
    const resolved = resolveAmortizationForSegment(realEstateSegment, paymentClp);
    if (resolved != null) {
      const carrying = carryingClpForExpenseDepositLink({
        payment_clp: paymentClp,
        amortization_clp: resolved.amortization_clp,
      });
      if (carrying < paymentClp) {
        const link: ExpenseDepositLinkRow = {
          account_id: line.account_id,
          purchase_key: line.purchase_key,
          deposit_movement_id: resolved.movement_id,
          payment_clp: paymentClp,
          amortization_clp: resolved.amortization_clp,
          depto_cuota: resolved.depto_cuota,
          depto_occurred_on: resolved.depto_occurred_on,
          link_source: "auto",
        };
        upsertExpenseDepositLink(link);
        created.push(link);
      }
    }
  }

  // Generic non-real_estate segments: full amount is capital (amortization = segment amount).
  // Multiple movements with the same amount on the same day (e.g. splittable pool) → skip;
  // we can't uniquely identify which movement to link.
  for (const seg of segments) {
    if (depositAccountDashboardGroup(seg.account_id) === "real_estate") continue;
    let movement: ReturnType<typeof findDepositMovement>;
    try {
      movement = findDepositMovementForSegment(seg);
    } catch {
      continue;
    }
    if (movement == null) continue;
    const segAmt = Math.round(seg.amount_clp);
    const link: ExpenseDepositLinkRow = {
      account_id: line.account_id,
      purchase_key: line.purchase_key,
      deposit_movement_id: movement.id,
      payment_clp: segAmt,
      amortization_clp: segAmt,
      depto_cuota: null,
      depto_occurred_on: null,
      link_source: "auto",
    };
    upsertExpenseDepositLink(link);
    created.push(link);
  }

  return created;
}

function assignBillsCategoryToMortgageLinkedLines(): void {
  db.prepare(
    `INSERT OR IGNORE INTO cc_expense_line_categories (statement_line_id, category_id)
     SELECT csl.id, cat.id
     FROM ${EXPENSE_DEPOSIT_LINKS_SQL} edl
     JOIN cc_statement_lines csl ON csl.parser_row_id = substr(edl.purchase_key, length(@prefix) + 1)
     JOIN cc_expense_categories cat ON cat.slug = @slug
     WHERE substr(edl.purchase_key, 1, length(@prefix)) = @prefix
       AND edl.depto_cuota IS NOT NULL`
  ).run({ prefix: EXPENSE_KEY_PREFIXES.line_pr, slug: BILLS_CC_EXPENSE_SLUG });
}

/**
 * A manually-marked `deposits` outflow is an assertion that a matching deposit exists — the user
 * categorized it because it funds *something*, even though the auto-matcher (exact amount within
 * 3 days + description gate) couldn't pair it. The assertion pass re-searches with the same exact
 * rounded-amount tolerance but a wider date window, restricted ONLY to those asserted lines.
 */
export const MANUAL_DEPOSIT_ASSERTION_MAX_DAY_GAP = MATCH_WINDOWS.manual_deposit_assertion.daysAfter;

export type ManualDepositAssertion = {
  /** Checking account the outflow lives on. */
  account_id: number;
  purchase_key: string;
  occurred_on: string;
  merchant: string | null;
  amount_clp: number;
  /** Linked deposit movement when exactly one candidate exists (or a link already does). */
  deposit_movement_id: number | null;
  deposit_account_id: number | null;
  /** Distinct eligible deposit movements found under the relaxed constraints. */
  candidate_count: number;
};

function lineIsManualDepositAssertion(line: GastosLineForExpenseDepositLink): boolean {
  if (line.source !== "checking") return false;
  if (line.category_slug !== DEPOSITS_CC_EXPENSE_SLUG) return false;
  if (line.amount_clp <= 0) return false;
  // Auto-matched lines carry the matcher's `deposit_match` and are handled by
  // tryAutoLinkExpenseDepositLine — only unmatched (user-asserted) lines take this pass.
  return (line.deposit_match?.length ?? 0) === 0;
}

/** Positive movement rows on `accountId`/`occurredOn` whose rounded amount matches `amountClp`. */
function listDepositMovementIdsAt(
  accountId: number,
  occurredOn: string,
  amountClp: number
): number[] {
  const want = Math.round(amountClp);
  const rows = db
    .prepare(
      `SELECT id, ${MOVEMENT_AMOUNT_COLUMNS_SQL} FROM movements
       WHERE account_id = ? AND occurred_on = ? AND ${MOVEMENT_CLP_LEG_SQL} > 0
       ORDER BY id`
    )
    .all(accountId, occurredOn) as ({ id: number } & MovementAmountFields)[];
  return rows.filter((r) => Math.round(movementClpLegOrZero(r)) === want).map((r) => r.id);
}

/**
 * Classify every manually-asserted `deposits` checking outflow against the matcher's own deposit
 * candidate pool. Exactly one eligible deposit movement (same rounded amount, within
 * {@link MANUAL_DEPOSIT_ASSERTION_MAX_DAY_GAP} days, not linked elsewhere) → that movement is the
 * link target. Zero or several candidates → no guess; the row is surfaced as asserted-unmatched.
 * Deterministic given the DB state: lines are processed oldest-first so re-runs (sync vs.
 * reconciliation read) resolve identically.
 */
export function computeManualDepositAssertions(
  lines: readonly GastosLineForExpenseDepositLink[],
  depositCandidates?: readonly DepositMatchCandidate[]
): ManualDepositAssertion[] {
  const asserted = lines
    .filter(lineIsManualDepositAssertion)
    .sort(
      (a, b) =>
        purchaseDateForGastosLine(a).localeCompare(purchaseDateForGastosLine(b)) ||
        a.purchase_key.localeCompare(b.purchase_key)
    );
  if (asserted.length === 0) return [];

  const checkingIds = new Set(listMovementBalanceCashAccountIds());
  // Reuse the matcher's candidate pool. Checking-bucket inflows (corriente↔vista legs) are not
  // deposits, and real_estate targets carry amortization semantics owned by the mortgage sync.
  const pool = (depositCandidates ?? loadDepositMatchCandidates()).filter(
    (d) => !checkingIds.has(d.account_id) && d.group_slug !== "real_estate"
  );

  // Existing durable links (auto from this sync's earlier passes + user-curated manual): a movement
  // linked to some other purchase is not claimable; a link on the asserted line itself resolves it.
  const linkRows = db
    .prepare(
      `SELECT purchase_key, deposit_movement_id, account_id FROM ${EXPENSE_DEPOSIT_LINKS_SQL}
       WHERE link_source IN ('auto', 'manual') ORDER BY link_order`
    )
    .all() as { purchase_key: string; deposit_movement_id: number; account_id: number }[];
  const movementsByPurchaseKey = new Map<string, number[]>();
  const claimedMovementIds = new Set<number>();
  for (const row of linkRows) {
    const arr = movementsByPurchaseKey.get(row.purchase_key);
    if (arr) arr.push(row.deposit_movement_id);
    else movementsByPurchaseKey.set(row.purchase_key, [row.deposit_movement_id]);
    claimedMovementIds.add(row.deposit_movement_id);
  }

  const movementAccountStmt = db.prepare(`SELECT account_id FROM movements WHERE id = ?`);

  const out: ManualDepositAssertion[] = [];
  for (const line of asserted) {
    const base = {
      account_id: line.account_id,
      purchase_key: line.purchase_key,
      occurred_on: purchaseDateForGastosLine(line),
      merchant: line.merchant ?? null,
      amount_clp: Math.round(line.amount_clp),
    };

    const own = movementsByPurchaseKey.get(line.purchase_key);
    if (own && own.length > 0) {
      const movementId = own[0]!;
      const acc = movementAccountStmt.get(movementId) as { account_id: number | null } | undefined;
      out.push({
        ...base,
        deposit_movement_id: movementId,
        deposit_account_id: acc?.account_id ?? null,
        candidate_count: own.length,
      });
      continue;
    }

    const candidateAccountByMovementId = new Map<number, number>();
    for (const d of pool) {
      if (Math.round(d.amount_clp) !== base.amount_clp) continue;
      if (!dayWithinWindow(base.occurred_on, d.occurred_on, MATCH_WINDOWS.manual_deposit_assertion)) continue;
      // Candidate events without a movement row (transfer legs, derived capital flows) are not
      // linkable deposit rows — they never show up in the reconciliation, so skip them here too.
      for (const movementId of listDepositMovementIdsAt(d.account_id, d.occurred_on, d.amount_clp)) {
        if (claimedMovementIds.has(movementId)) continue;
        candidateAccountByMovementId.set(movementId, d.account_id);
      }
    }

    const candidateIds = [...candidateAccountByMovementId.keys()];
    if (candidateIds.length === 1) {
      const movementId = candidateIds[0]!;
      claimedMovementIds.add(movementId);
      out.push({
        ...base,
        deposit_movement_id: movementId,
        deposit_account_id: candidateAccountByMovementId.get(movementId)!,
        candidate_count: 1,
      });
    } else {
      // Ambiguous (or no candidate): do NOT guess — surface as asserted-unmatched instead.
      out.push({
        ...base,
        deposit_movement_id: null,
        deposit_account_id: null,
        candidate_count: candidateIds.length,
      });
    }
  }
  return out;
}

function syncManualDepositAssertionLinks(
  lines: readonly GastosLineForExpenseDepositLink[]
): void {
  for (const assertion of computeManualDepositAssertions(lines)) {
    if (assertion.deposit_movement_id == null) continue;
    upsertExpenseDepositLink({
      account_id: assertion.account_id,
      purchase_key: assertion.purchase_key,
      deposit_movement_id: assertion.deposit_movement_id,
      payment_clp: assertion.amount_clp,
      amortization_clp: assertion.amount_clp,
      depto_cuota: null,
      depto_occurred_on: null,
      link_source: "auto",
    });
  }
}

/**
 * Rebuilt on every read of the expense lines; a rebuild that changes nothing writes nothing
 * (`withoutChurn`), so it reports no change to the caches.
 */
export function syncExpenseDepositLinksFromGastosLines(
  lines: readonly GastosLineForExpenseDepositLink[]
): void {
  withoutChurn(
    ["flow_links", "cc_expense_line_categories"],
    ["created_at"],
    () => syncExpenseDepositLinksFromGastosLinesChurning(lines)
  );
}

function syncExpenseDepositLinksFromGastosLinesChurning(lines: readonly GastosLineForExpenseDepositLink[]): void {
  clearAutoExpenseDepositLinks();
  syncMortgageExpenseDepositLinksFromSheet(lines);
  for (const line of lines) {
    tryAutoLinkExpenseDepositLine(line);
  }
  // After the note-driven pass so an asserted line can never steal a deposit the matcher already
  // paired with its real outflow.
  syncManualDepositAssertionLinks(lines);
  assignBillsCategoryToMortgageLinkedLines();
}

export function enrichFlowLinesWithExpenseDepositLinks<
  T extends Pick<FlowCcExpenseLineRow, "purchase_key">
>(lines: readonly T[]): (T & { expense_deposit_links?: ExpenseDepositLinkDto[] })[] {
  const links = loadExpenseDepositLinksMap();
  return lines.map((line) => {
    const rows = links.get(line.purchase_key);
    if (!rows || rows.length === 0) return line;
    return { ...line, expense_deposit_links: rows.map(expenseDepositLinkDto) };
  });
}

export function chartCategorySlugsForFlowsExpenses(
  categorySlugs: readonly string[]
): string[] {
  const out = new Set(categorySlugs);
  out.add(REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG);
  return [...out];
}

/** Chart stack only: principal renders below the x-axis as a negative bar segment. */
export function expenseDepositAmortizationChartAmount(amortizationClp: number): number {
  const amt = Math.round(amortizationClp);
  if (amt <= 0) return 0;
  return -amt;
}
