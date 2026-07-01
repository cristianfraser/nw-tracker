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
import { syncCuentaAhorroDepositSplitMirrors } from "./cuentaAhorroDepositSplits.js";
import { syncBudaAbonoDepositMirrors } from "./budaWallet.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

export { BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG };

/** Max days between CC purchase_on and depto sheet occurred_on for mortgage cuota match. */
export const MORTGAGE_CC_PURCHASE_DAY_GAP = 14;

/** Priority for conflict resolution when the same (purchase_key, deposit_movement_id) pair is
 *  written by more than one path: manual (user-curated) > auto (real checking/CC match) >
 *  synthetic (fabricated mirror for a confirmed cuenta_corriente cartola gap). */
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

export function loadExpenseDepositLinksMap(): Map<string, ExpenseDepositLinkRow[]> {
  const rows = db
    .prepare(
      `SELECT account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp,
              depto_cuota, depto_occurred_on, link_source
       FROM expense_deposit_links`
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

/** Movement ids that already have a durable expense_deposit_links row (any source). */
export function loadLinkedMovementIds(): Set<number> {
  const rows = db
    .prepare(`SELECT deposit_movement_id FROM expense_deposit_links`)
    .all() as { deposit_movement_id: number }[];
  return new Set(rows.map((r) => r.deposit_movement_id));
}

const LINK_SOURCE_PRIORITY: Record<ExpenseDepositLinkSource, number> = {
  manual: 3,
  auto: 2,
  synthetic: 1,
};

/** Best (highest-priority) link source per deposit movement id — manual > auto > synthetic. */
export function loadBestLinkSourceByMovementId(): Map<number, ExpenseDepositLinkSource> {
  const rows = db
    .prepare(`SELECT deposit_movement_id, link_source FROM expense_deposit_links`)
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

function upsertExpenseDepositLink(row: ExpenseDepositLinkRow): void {
  const existing = db
    .prepare(
      `SELECT link_source FROM expense_deposit_links WHERE purchase_key = ? AND deposit_movement_id = ?`
    )
    .get(row.purchase_key, row.deposit_movement_id) as
    | { link_source: ExpenseDepositLinkSource }
    | undefined;
  if (existing && LINK_SOURCE_PRIORITY[existing.link_source] > LINK_SOURCE_PRIORITY[row.link_source]) {
    return;
  }

  db.prepare(
    `INSERT INTO expense_deposit_links (
       account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp,
       depto_cuota, depto_occurred_on, link_source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(purchase_key, deposit_movement_id) DO UPDATE SET
       account_id = excluded.account_id,
       payment_clp = excluded.payment_clp,
       amortization_clp = excluded.amortization_clp,
       depto_cuota = excluded.depto_cuota,
       depto_occurred_on = excluded.depto_occurred_on,
       link_source = excluded.link_source`
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

function clearSyntheticExpenseDepositLinks(): void {
  db.prepare(`DELETE FROM expense_deposit_links WHERE link_source = 'synthetic'`).run();
}

/** Direct 1:1 link from a checking_gap_deposit_mirrors row to its target deposit movement —
 *  no fuzzy date/amount search, the movement id is already known. */
function syncCheckingGapDepositMirrorLinks(): void {
  clearSyntheticExpenseDepositLinks();
  const rows = db
    .prepare(
      `SELECT id, account_id, deposit_movement_id, amount_clp FROM checking_gap_deposit_mirrors`
    )
    .all() as { id: number; account_id: number; deposit_movement_id: number; amount_clp: number }[];
  for (const row of rows) {
    const amt = Math.round(row.amount_clp);
    upsertExpenseDepositLink({
      account_id: row.account_id,
      purchase_key: checkingGapDepositMirrorPurchaseKey(row.id),
      deposit_movement_id: row.deposit_movement_id,
      payment_clp: amt,
      amortization_clp: amt,
      depto_cuota: null,
      depto_occurred_on: null,
      link_source: "synthetic",
    });
  }
}

/** Must match the `source: "checking"`, negative-`statement_line_id` branch in
 *  ccExpensePurchaseKey.ts's resolvePurchaseKeyForGastosLine exactly — that's the purchase_key
 *  the gastos line actually resolves to once enrichFlowLinesWithPurchaseNotes runs on it. */
export function checkingGapDepositMirrorPurchaseKey(mirrorId: number): string {
  return `synthetic-checking-gap-mirror:${mirrorId}`;
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
}): ExpenseDepositLinkRow[] {
  if (line.category_slug !== DEPOSITS_CC_EXPENSE_SLUG) return [];
  if (line.amount_clp <= 0) return [];

  const segments = parseAutoDepositMatchNote(line.purchase_notes);
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
      movement = findDepositMovement(seg.account_id, seg.occurred_on, seg.amount_clp);
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
     FROM expense_deposit_links edl
     JOIN cc_statement_lines csl ON csl.parser_row_id = substr(edl.purchase_key, 9)
     JOIN cc_expense_categories cat ON cat.slug = ?
     WHERE edl.purchase_key LIKE 'line-pr:%'
       AND edl.depto_cuota IS NOT NULL`
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
  // Materialize cuenta_ahorro self-funded split portions and Buda buffer abonos into
  // checking_gap_deposit_mirrors first, so syncCheckingGapDepositMirrorLinks picks them up alongside
  // the propose-script mirrors.
  syncCuentaAhorroDepositSplitMirrors();
  syncBudaAbonoDepositMirrors();
  syncCheckingGapDepositMirrorLinks();
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

export function isRealEstateMortgageDepositChartSlug(slug: string): boolean {
  return slug === REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG;
}

/** Chart stack only: principal renders below the x-axis as a negative bar segment. */
export function expenseDepositAmortizationChartAmount(amortizationClp: number): number {
  const amt = Math.round(amortizationClp);
  if (amt <= 0) return 0;
  return -amt;
}
