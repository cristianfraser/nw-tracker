import { accountBucketKindSlug } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import {
  parseAutoDepositMatchNote,
  type ParsedDepositMatchSegment,
} from "./ccExpenseDepositMatchNotes.js";
import {
  BILLS_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import {
  noteIsDeptoPiePayment,
  parseDeptoDividendosMovementNote,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { loadDeptoDividendosSheetRowsRawFromDb } from "./deptoSheetDb.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

export { BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG };

/** Max days between CC purchase_on and depto sheet occurred_on for mortgage cuota match. */
export const MORTGAGE_CC_PURCHASE_DAY_GAP = 14;

export type ExpenseDepositLinkRow = {
  account_id: number;
  purchase_key: string;
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: "auto" | "manual";
};

export type ExpenseDepositLinkDto = {
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  carrying_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: "auto" | "manual";
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

export function expenseDepositLinkDto(row: ExpenseDepositLinkRow): ExpenseDepositLinkDto {
  return {
    deposit_movement_id: row.deposit_movement_id,
    payment_clp: row.payment_clp,
    amortization_clp: row.amortization_clp,
    carrying_clp: carryingClpForExpenseDepositLink(row),
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

/** Known credit-card merchants for Suecia mortgage cuota payments. */
export function isMortgageCcExpenseMerchant(merchant: string | null | undefined): boolean {
  const key = normalizeCcExpenseMerchantKey(merchant ?? "");
  if (!key) return false;
  if (/METLIFE/.test(key)) return true;
  if (/MUTUARIA/.test(key)) return true;
  if (/TOKU/.test(key) && /METLIFE|HIPOTE/.test(key)) return true;
  return false;
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

function signedDaysFromTo(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 999;
  return Math.round((to - from) / 86_400_000);
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

function findDepositMovement(
  accountId: number,
  occurredOn: string,
  amountClp: number
): { id: number; note: string | null; amount_clp: number; occurred_on: string } | null {
  const want = Math.round(amountClp);
  const rows = db
    .prepare(
      `SELECT id, note, amount_clp, occurred_on
       FROM movements
       WHERE account_id = ? AND occurred_on = ? AND amount_clp > 0
       ORDER BY id`
    )
    .all(accountId, occurredOn) as {
    id: number;
    note: string | null;
    amount_clp: number;
    occurred_on: string;
  }[];

  const exact = rows.filter((r) => Math.round(r.amount_clp) === want);
  if (exact.length === 0) return null;
  if (exact.length === 1) return exact[0]!;

  const deptoRows = exact.filter((r) => parseDeptoDividendosMovementNote(r.note) != null);
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

function findPropertyDepositForSheetRow(
  sheet: DeptoMortgageSheetRow
): { id: number; note: string | null; amount_clp: number; occurred_on: string; account_id: number } | null {
  const sheetPago = Math.round(sheet.pago_clp);
  let match: {
    id: number;
    note: string | null;
    amount_clp: number;
    occurred_on: string;
    account_id: number;
  } | null = null;

  for (const accountId of listRealEstatePropertyAccountIds()) {
    const movement = findDepositMovement(accountId, sheet.occurred_on, sheetPago);
    if (movement == null) continue;
    const parsed = parseDeptoDividendosMovementNote(movement.note);
    if (parsed?.cuota != null && parsed.cuota !== sheet.cuota) continue;
    if (noteIsDeptoPiePayment(movement.note)) continue;

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
    return (
      Math.abs(signedDaysFromTo(purchaseDate, sheet.occurred_on)) <= MORTGAGE_CC_PURCHASE_DAY_GAP
    );
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
  movement: { id: number; note: string | null; amount_clp: number; occurred_on: string },
  sheetRow?: DeptoMortgageSheetRow
): { amortization_clp: number; depto_cuota: string | null; depto_occurred_on: string } | null {
  if (noteIsDeptoPiePayment(movement.note)) return null;

  if (sheetRow != null) {
    const amort = amortizationClpFromSheetRow(sheetRow);
    const paymentRef = Math.max(Math.round(movement.amount_clp), Math.round(sheetRow.pago_clp));
    if (amort > paymentRef && sheetRow.cuota !== "9") {
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

  const parsed = parseDeptoDividendosMovementNote(movement.note);
  if (parsed?.cuota != null) {
    const fromNote =
      Math.round(parsed.amortizacion_clp ?? 0) + Math.round(parsed.amortizacion_ext_clp ?? 0);
    if (fromNote > 0) {
      const paymentRef = Math.round(movement.amount_clp);
      if (fromNote > paymentRef) {
        throw new Error(
          `depto movement ${movement.id} amortization ${fromNote} exceeds payment ${paymentRef}`
        );
      }
      return {
        amortization_clp: fromNote,
        depto_cuota: parsed.cuota,
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
  const movement = findDepositMovement(segment.account_id, segment.occurred_on, segment.amount_clp);
  if (movement == null) return null;
  const amort = resolveAmortizationForDepositMovement(movement);
  if (amort == null) return null;

  return {
    ...amort,
    movement_id: movement.id,
  };
}

export function loadExpenseDepositLinksMap(): Map<string, ExpenseDepositLinkRow> {
  const rows = db
    .prepare(
      `SELECT account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp,
              depto_cuota, depto_occurred_on, link_source
       FROM expense_deposit_links`
    )
    .all() as ExpenseDepositLinkRow[];
  const out = new Map<string, ExpenseDepositLinkRow>();
  for (const row of rows) {
    out.set(row.purchase_key, row);
  }
  return out;
}

function upsertExpenseDepositLink(
  row: Omit<ExpenseDepositLinkRow, "link_source"> & { link_source: "auto" | "manual" }
): void {
  const existing = db
    .prepare(`SELECT link_source FROM expense_deposit_links WHERE purchase_key = ?`)
    .get(row.purchase_key) as { link_source: "auto" | "manual" } | undefined;
  if (existing?.link_source === "manual" && row.link_source === "auto") return;

  db.prepare(
    `INSERT INTO expense_deposit_links (
       account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp,
       depto_cuota, depto_occurred_on, link_source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(purchase_key) DO UPDATE SET
       account_id = excluded.account_id,
       deposit_movement_id = excluded.deposit_movement_id,
       payment_clp = excluded.payment_clp,
       amortization_clp = excluded.amortization_clp,
       depto_cuota = excluded.depto_cuota,
       depto_occurred_on = excluded.depto_occurred_on,
       link_source = CASE
         WHEN expense_deposit_links.link_source = 'manual' THEN expense_deposit_links.link_source
         ELSE excluded.link_source
       END`
  ).run(
    row.account_id,
    row.purchase_key,
    row.deposit_movement_id,
    row.payment_clp,
    row.amortization_clp,
    row.depto_cuota,
    row.depto_occurred_on,
    row.link_source
  );
}

function clearAutoExpenseDepositLinks(): void {
  db.prepare(`DELETE FROM expense_deposit_links WHERE link_source = 'auto'`).run();
}

export function syncMortgageExpenseDepositLinksFromSheet(
  lines: readonly GastosLineForExpenseDepositLink[]
): ExpenseDepositLinkRow[] {
  const manualKeys = new Set(
    (
      db
        .prepare(`SELECT purchase_key FROM expense_deposit_links WHERE link_source = 'manual'`)
        .all() as { purchase_key: string }[]
    ).map((r) => r.purchase_key)
  );
  const usedPurchaseKeys = new Set(manualKeys);
  const created: ExpenseDepositLinkRow[] = [];

  for (const sheet of loadDeptoDividendosSheetRowsRawFromDb()) {
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
  purchase_notes: string;
}): ExpenseDepositLinkRow | null {
  if (line.category_slug !== DEPOSITS_CC_EXPENSE_SLUG) return null;
  if (line.amount_clp <= 0) return null;

  const segments = parseAutoDepositMatchNote(line.purchase_notes);
  if (segments.length === 0) return null;

  const paymentClp = Math.round(line.amount_clp);
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
  if (realEstateSegment == null) return null;

  const resolved = resolveAmortizationForSegment(realEstateSegment, paymentClp);
  if (resolved == null) return null;

  const carrying = carryingClpForExpenseDepositLink({
    payment_clp: paymentClp,
    amortization_clp: resolved.amortization_clp,
  });
  if (carrying === paymentClp) return null;

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
  return link;
}

function assignBillsCategoryToMortgageLinkedLines(): void {
  db.prepare(
    `INSERT OR IGNORE INTO cc_expense_line_categories (statement_line_id, category_id)
     SELECT csl.id, cat.id
     FROM expense_deposit_links edl
     JOIN cc_statement_lines csl ON csl.parser_row_id = substr(edl.purchase_key, 9)
     JOIN cc_expense_categories cat ON cat.slug = ?
     WHERE edl.purchase_key LIKE 'line-pr:%'`
  ).run(BILLS_CC_EXPENSE_SLUG);
}

export function syncExpenseDepositLinksFromGastosLines(
  lines: readonly GastosLineForExpenseDepositLink[]
): void {
  clearAutoExpenseDepositLinks();
  syncMortgageExpenseDepositLinksFromSheet(lines);
  for (const line of lines) {
    tryAutoLinkExpenseDepositLine(line);
  }
  assignBillsCategoryToMortgageLinkedLines();
}

export function enrichFlowLinesWithExpenseDepositLinks<
  T extends Pick<FlowCcExpenseLineRow, "purchase_key">
>(lines: readonly T[]): (T & { expense_deposit_link?: ExpenseDepositLinkDto })[] {
  const links = loadExpenseDepositLinksMap();
  return lines.map((line) => {
    const row = links.get(line.purchase_key);
    if (!row) return line;
    return { ...line, expense_deposit_link: expenseDepositLinkDto(row) };
  });
}

export function chartCategorySlugsForFlowsExpenses(
  categorySlugs: readonly string[]
): string[] {
  const out = new Set(categorySlugs);
  out.add(REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG);
  return [...out];
}

export function isRealEstateMortgageDepositChartSlug(slug: string): boolean {
  return slug === REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG;
}

/** Chart stack only: principal renders below the x-axis as a negative bar segment. */
export function expenseDepositAmortizationChartAmount(amortizationClp: number): number {
  const amt = Math.round(amortizationClp);
  if (amt <= 0) return 0;
  return -amt;
}
