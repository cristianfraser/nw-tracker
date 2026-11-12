import { isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { loadCheckingExpenseRefunds } from "./checkingExpenseRefunds.js";
import { db } from "./db.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import {
  checkingCreditMatchesAfpRetiroReturn,
  checkingCreditMatchesInternalWithdrawal,
  checkingCreditMatchesLedgerNetWorthCapitalReturn,
  checkingCreditMatchesNetWorthCapitalReturn,
  checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn,
  createSplittableInternalTransferPool,
  buildFintualIncomingWireBatches,
  creditIsReversingMercadoCapitalesCargo,
  type FintualIncomingWireBatch,
} from "./flowsCheckingGastos.js";
import {
  loadAfpRetiroOutflowCandidates,
  listCheckingMovements,
  loadAllCheckingWithdrawals,
  loadCheckingWithdrawals,
  listForeignCheckingAccountIds,
  listForeignCheckingMovements,
  loadDepositMatchCandidates,
  loadNetWorthCapitalReturnLedgerOutflows,
} from "./checkingCartolaLoaders.js";
import {
  cartolaDescriptionFromNote,
  isExcludedCheckingInflow,
} from "./checkingDescriptionPredicates.js";
import { checkingCreditMatchesBudaRetiro, loadBudaBufferAccountId } from "./budaWallet.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import { convertFlow } from "./rates.js";
import { flowLegsInUnit, type FlowLegs } from "./flowLegs.js";
import { monthEndUtcYmd } from "./calendarMonth.js";
import {
  mergedIncomeKindByMovementIdRecord,
  loadExcludedCheckingIncomeMovementIds,
  loadExcludedCheckingIncomeLines,
  loadForceIncludedCheckingIncomeMovementIds,
  type CheckingIncomeKind,
  type FlowExcludedCheckingIncomeLine,
} from "./flowsCheckingIncomeOverrides.js";
import { loadF22RefundMovements } from "./f22Settlements.js";
import {
  loadPayrollWorkEarnings,
  payrollPeriodByMovementIdRecord,
  type FlowWorkEarningRow,
} from "./flowsPayrollWorkEarnings.js";

export type FlowCheckingIncomeLine = {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  /** A dollar account's credit: its dollars at the day's `fx_daily` rate. */
  amount_clp: number;
  /**
   * The credit's own dollars (a dollar account's credit); null for a peso credit, whose dollars are
   * its pesos at the day's buy rate, read only when a unit asks ({@link incomeLineUsdLeg}).
   */
  amount_usd: number | null;
  /** A credit on a checking account in a currency other than pesos and dollars: its own amount (internal; the wire carries `amount`). */
  native?: { currency: string; amount: number };
  description: string;
  source: "checking";
};

export type FlowManualIncomeLine = {
  id: number;
  /** The entry's amount (`income_entries.amount` in its `currency`, migration 316) in pesos, as a flow of its day. */
  amount_clp: number;
  received_on: string;
  /** The entry's amount in dollars, as a flow of its day (its own dollars for a dollar entry). */
  amount_usd: number | null;
  source: string | null;
  note: string | null;
  origin: "manual";
};

export type IncomeAutoFilterReason =
  | "excluded_description"
  | "mercado_capitales_reversal"
  | "internal_withdrawal"
  | "afp_retiro_return"
  | "net_worth_capital_return";

export type FlowFilteredCheckingIncomeLine = {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  /**
   * The credit's own dollars (a dollar account's credit); null for a peso credit, whose dollars are
   * its pesos at the day's buy rate, read only when a unit asks ({@link incomeLineUsdLeg}).
   */
  amount_usd: number | null;
  description: string;
  filter_reason: IncomeAutoFilterReason;
};

export type FlowsCheckingIncomePayload = {
  lines: FlowCheckingIncomeLine[];
  manual: FlowManualIncomeLine[];
  work_earnings: FlowWorkEarningRow[];
  income_kind_by_movement_id: Record<number, CheckingIncomeKind>;
  payroll_period_by_movement_id: Record<number, string>;
  excluded_lines: FlowExcludedCheckingIncomeLine[];
  filtered_lines: FlowFilteredCheckingIncomeLine[];
  /**
   * Credits marked as refunds of spending (`checkingExpenseRefunds.ts`): never income, so they are
   * never in `lines`; each is a negative gastos line in its category. Newest first.
   */
  refund_lines: (FlowCheckingIncomeLine & { category_slug: string })[];
};

type CheckingCreditWithId = {
  movement_id: number;
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

function loadCheckingCreditsWithId(accountId: number): CheckingCreditWithId[] {
  return listCheckingMovements(accountId, "in").map((m) => ({
    movement_id: m.id,
    account_id: accountId,
    occurred_on: m.occurred_on,
    amount_clp: m.amount_clp,
    note: m.note,
  }));
}

function loadAccountLabels(accountIds: readonly number[]): Map<number, string> {
  if (accountIds.length === 0) return new Map();
  const placeholders = accountIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, name FROM accounts WHERE id IN (${placeholders})`)
    .all(...accountIds) as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function loadManualIncomeEntries(): FlowManualIncomeLine[] {
  const rows = db
    .prepare(
      `SELECT id, amount, currency, received_on, source, note
       FROM income_entries
       WHERE note IS NULL OR note NOT LIKE 'import:excel%'
       ORDER BY received_on DESC, id DESC`
    )
    .all() as { id: number; amount: number; currency: string; received_on: string; source: string | null; note: string | null }[];
  // An entry is income in its own currency; its pesos and dollars are flows of its day (convertFlow).
  return rows.map(({ amount, currency, ...row }) => ({
    ...row,
    amount_clp: Math.round(convertFlow(amount, currency, "clp", row.received_on)),
    amount_usd: convertFlow(amount, currency, "usd", row.received_on),
    origin: "manual" as const,
  }));
}

/** An income line's legs for {@link flowLegsInUnit}: its pesos, its dollars and, in a third currency, its own amount. */
export function incomeLineLegs(line: {
  amount_clp: number;
  amount_usd: number | null;
  received_on: string;
  native?: { currency: string; amount: number };
}): FlowLegs {
  const legs: FlowLegs = { clp: Math.round(line.amount_clp), usd: incomeLineUsdLeg(line) };
  if (line.native != null) {
    legs.native = line.native.currency;
    legs.native_amount = line.native.amount;
  }
  return legs;
}

/**
 * An income line's dollar leg for {@link flowLegsInUnit}: its own dollars, else its pesos at the
 * day's buy rate (read only when the unit is dollars).
 */
export function incomeLineUsdLeg(line: { amount_clp: number; amount_usd: number | null; received_on: string }) {
  return line.amount_usd ?? (() => clpToUsdAtDate(Math.round(line.amount_clp), line.received_on));
}

type IncomeFilterContext = {
  accountWithdrawalsByAccountId: Map<number, ReturnType<typeof loadCheckingWithdrawals>>;
  allWithdrawals: ReturnType<typeof loadAllCheckingWithdrawals>;
  deposits: ReturnType<typeof loadDepositMatchCandidates>;
  splittablePool: Map<string, number>;
  afpOutflows: ReturnType<typeof loadAfpRetiroOutflowCandidates>;
  ledgerCapitalOutflows: ReturnType<typeof loadNetWorthCapitalReturnLedgerOutflows>;
  budaBufferAccountId: number | null;
  fintualWireBatchByMovementId: Map<number, FintualIncomingWireBatch>;
  matchedFintualWireBatchKeys: Set<string>;
  consumedCapitalReturnWithdrawalKeys: Set<string>;
  consumedCapitalReturnLedgerOutflowKeys: Set<string>;
};

function classifyCheckingCreditForIncome(
  credit: CheckingCreditWithId,
  ctx: IncomeFilterContext
): IncomeAutoFilterReason | null {
  if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) {
    throw new Error(`anchor cartola credit ${credit.movement_id} must not reach income classifier`);
  }

  const description = cartolaDescriptionFromNote(credit.note);

  // Buda buffer retiros arrive under Buda's commercial name ("BUDA COM SPA" / "SURBTC SPA"), which
  // isExcludedCheckingInflow drops as a generic transfer. Match them first so the retiro outflow key
  // is consumed (excluding it from income *and* marking the redemption linked) — otherwise the
  // exclusion below swallows the credit and the retiro stays unlinked.
  if (
    ctx.budaBufferAccountId != null &&
    checkingCreditMatchesBudaRetiro(credit, ctx.ledgerCapitalOutflows, {
      budaAccountId: ctx.budaBufferAccountId,
      consumedLedgerOutflowKeys: ctx.consumedCapitalReturnLedgerOutflowKeys,
    })
  ) {
    return "net_worth_capital_return";
  }

  if (isExcludedCheckingInflow(description)) {
    // A Fintual-named incoming wire ("… Transf. Fintual AGF") is dropped here as a generic transfer,
    // yet it returns capital when it matches a same-amount reserva/brokerage retiro. Recognize and
    // consume that retiro before dropping the credit so the redemption links. Only excluded credits
    // take this path, so the bare-"Transf." wire-batch flow below is untouched. Income is unaffected
    // either way (capital returns are filtered from income like the exclusion is).
    if (
      checkingCreditMatchesLedgerNetWorthCapitalReturn(credit, ctx.ledgerCapitalOutflows, {
        consumedLedgerOutflowKeys: ctx.consumedCapitalReturnLedgerOutflowKeys,
      })
    ) {
      return "net_worth_capital_return";
    }
    return "excluded_description";
  }

  const accountWithdrawals =
    ctx.accountWithdrawalsByAccountId.get(credit.account_id) ??
    loadCheckingWithdrawals(credit.account_id);

  if (creditIsReversingMercadoCapitalesCargo(credit, accountWithdrawals)) {
    return "mercado_capitales_reversal";
  }
  if (
    checkingCreditMatchesInternalWithdrawal(
      credit,
      credit.account_id,
      ctx.allWithdrawals,
      ctx.deposits,
      ctx.splittablePool
    )
  ) {
    return "internal_withdrawal";
  }
  if (checkingCreditMatchesAfpRetiroReturn(credit, ctx.afpOutflows)) {
    return "afp_retiro_return";
  }
  const batch = ctx.fintualWireBatchByMovementId.get(credit.movement_id);
  if (batch != null) {
    if (ctx.matchedFintualWireBatchKeys.has(batch.key)) {
      return "net_worth_capital_return";
    }
    if (
      checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn(
        batch,
        ctx.ledgerCapitalOutflows,
        { consumedLedgerOutflowKeys: ctx.consumedCapitalReturnLedgerOutflowKeys }
      )
    ) {
      ctx.matchedFintualWireBatchKeys.add(batch.key);
      return "net_worth_capital_return";
    }
  }
  if (
    checkingCreditMatchesNetWorthCapitalReturn(credit, ctx.allWithdrawals, {
      consumedWithdrawalKeys: ctx.consumedCapitalReturnWithdrawalKeys,
      ledgerOutflows: ctx.ledgerCapitalOutflows,
      consumedLedgerOutflowKeys: ctx.consumedCapitalReturnLedgerOutflowKeys,
    })
  ) {
    return "net_worth_capital_return";
  }
  return null;
}

function toCheckingIncomeLine(
  credit: CheckingCreditWithId,
  accountLabels: Map<number, string>
): FlowCheckingIncomeLine {
  const amount_clp = Math.round(credit.amount_clp);
  return {
    movement_id: credit.movement_id,
    account_id: credit.account_id,
    account_label: accountLabels.get(credit.account_id) ?? String(credit.account_id),
    received_on: credit.occurred_on,
    amount_clp,
    amount_usd: null,
    description: cartolaDescriptionFromNote(credit.note),
    source: "checking",
  };
}

type CheckingIncomeComputation = {
  payload: FlowsCheckingIncomePayload;
  /** Net-worth ledger-outflow keys (netWorthCapitalLedgerOutflowPairKey) consumed as capital returns
   *  — i.e. net-worth redemptions that this income build matched to (and excluded from) a checking
   *  inflow. Reused by the deposits reconciliation to mark those redemptions as linked. */
  consumedLedgerOutflowKeys: Set<string>;
};

export function buildFlowsCheckingIncomePayload(): FlowsCheckingIncomePayload {
  return computeCheckingIncome().payload;
}

/** Net-worth capital-return outflow keys the income filter matched to checking inflows. */
export function loadConsumedNetWorthCapitalReturnOutflowKeys(): Set<string> {
  return computeCheckingIncome().consumedLedgerOutflowKeys;
}

function computeCheckingIncome(): CheckingIncomeComputation {
  const accountIds = listMovementBalanceCashAccountIds();
  const accountLabels = loadAccountLabels(accountIds);
  const deposits = loadDepositMatchCandidates();
  const splittablePool = createSplittableInternalTransferPool(deposits);
  const allWithdrawals = loadAllCheckingWithdrawals();
  const afpOutflows = loadAfpRetiroOutflowCandidates();
  const ledgerCapitalOutflows = loadNetWorthCapitalReturnLedgerOutflows();
  const budaBufferAccountId = loadBudaBufferAccountId();

  const excludedMovementIds = loadExcludedCheckingIncomeMovementIds();
  const refundCategoryByMovementId = new Map(loadCheckingExpenseRefunds().map((r) => [r.movement_id, r.category_slug]));
  const forceIncludedMovementIds = loadForceIncludedCheckingIncomeMovementIds();

  const accountWithdrawalsByAccountId = new Map(
    accountIds.map((accountId) => [accountId, loadCheckingWithdrawals(accountId)])
  );

  const creditsForBatching: CheckingCreditWithId[] = [];
  for (const accountId of accountIds) {
    for (const credit of loadCheckingCreditsWithId(accountId)) {
      if (excludedMovementIds.has(credit.movement_id)) continue;
      if (refundCategoryByMovementId.has(credit.movement_id)) continue;
      if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) continue;
      creditsForBatching.push(credit);
    }
  }
  const { batchByMovementId: fintualWireBatchByMovementId } =
    buildFintualIncomingWireBatches(creditsForBatching);

  const filterCtx: IncomeFilterContext = {
    accountWithdrawalsByAccountId,
    allWithdrawals,
    deposits,
    splittablePool,
    afpOutflows,
    ledgerCapitalOutflows,
    budaBufferAccountId,
    fintualWireBatchByMovementId,
    matchedFintualWireBatchKeys: new Set(),
    consumedCapitalReturnWithdrawalKeys: new Set(),
    consumedCapitalReturnLedgerOutflowKeys: new Set(),
  };

  const lines: FlowCheckingIncomeLine[] = [];
  const filtered_lines: FlowFilteredCheckingIncomeLine[] = [];
  const refund_lines: (FlowCheckingIncomeLine & { category_slug: string })[] = [];

  for (const accountId of accountIds) {
    for (const credit of loadCheckingCreditsWithId(accountId)) {
      if (excludedMovementIds.has(credit.movement_id)) continue;
      if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) continue;
      // The user's classification wins over the auto filters: a refund is neither income nor a
      // capital return, and must not consume a redemption another credit should claim.
      const refundCategory = refundCategoryByMovementId.get(credit.movement_id);
      if (refundCategory != null) {
        refund_lines.push({ ...toCheckingIncomeLine(credit, accountLabels), category_slug: refundCategory });
        continue;
      }

      const forceInclude = forceIncludedMovementIds.has(credit.movement_id);
      const filterReason = forceInclude
        ? null
        : classifyCheckingCreditForIncome(credit, filterCtx);

      if (filterReason != null) {
        const amount_clp = Math.round(credit.amount_clp);
        filtered_lines.push({
          movement_id: credit.movement_id,
          account_id: credit.account_id,
          account_label: accountLabels.get(credit.account_id) ?? String(credit.account_id),
          received_on: credit.occurred_on,
          amount_clp,
          amount_usd: null,
          description: cartolaDescriptionFromNote(credit.note),
          filter_reason: filterReason,
        });
        continue;
      }

      lines.push(toCheckingIncomeLine(credit, accountLabels));
    }
  }

  // A foreign checking account's bank-listed credits (a US salary) are income in its currency,
  // priced in pesos and dollars at the day's rate; one the user marked a refund of spending is
  // listed apart, like a peso refund. None of the peso matchers applies: a transfer between own
  // accounts is a transfer row there, never a listed credit.
  const dollarAccountIds = listForeignCheckingAccountIds();
  const dollarLabels = loadAccountLabels(dollarAccountIds);
  for (const accountId of dollarAccountIds) {
    for (const m of listForeignCheckingMovements(accountId, "in")) {
      if (excludedMovementIds.has(m.id)) continue;
      const base = {
        movement_id: m.id,
        account_id: accountId,
        account_label: dollarLabels.get(accountId) ?? String(accountId),
        received_on: m.occurred_on,
        amount_clp: m.amount_clp,
        amount_usd: m.amount_usd,
        ...(m.currency === "usd" ? {} : { native: { currency: m.currency, amount: m.amount_native } }), // convention-ok: a dollar credit is the own-dollars slot (amount_usd)
        description: cartolaDescriptionFromNote(m.note),
      };
      const refundCategory = refundCategoryByMovementId.get(m.id);
      if (refundCategory != null) {
        refund_lines.push({ ...base, source: "checking", category_slug: refundCategory });
        continue;
      }
      if (!forceIncludedMovementIds.has(m.id) && isExcludedCheckingInflow(base.description)) {
        filtered_lines.push({ ...base, filter_reason: "excluded_description" });
        continue;
      }
      lines.push({ ...base, source: "checking" });
    }
  }

  // A tax refund the Tesorería paid outside checking (e.g. cashed at BancoEstado and deposited into
  // the savings account) is income too; one paid into checking is already a credit above.
  const checkingAccountIds = new Set(accountIds);
  const outsideRefunds = loadF22RefundMovements().filter((r) => !checkingAccountIds.has(r.account_id));
  const refundAccountLabels = loadAccountLabels([...new Set(outsideRefunds.map((r) => r.account_id))]);
  for (const r of outsideRefunds) {
    const amount_clp = Math.round(r.amount);
    lines.push({
      movement_id: r.movement_id,
      account_id: r.account_id,
      account_label: refundAccountLabels.get(r.account_id) ?? String(r.account_id),
      received_on: r.occurred_on,
      amount_clp,
      amount_usd: null,
      description: `F22 AT${r.tax_year}`,
      source: "checking",
    });
  }

  // Income-excluded credits are still real money returning to checking — e.g. a cuenta_ahorro
  // withdrawal booked as "Depósito en Efectivo" / "con Vales Vista", which the user excludes from
  // income. They must not count as income, but they DO consume the matching net-worth redemption so
  // those outflows link (per the rule: cuenta de ahorro outflows pair with checking inflows). Run them
  // through the same matcher purely for its key-consumption side effect, after the income pass so an
  // excluded credit never pre-empts a redemption that a real income inflow should claim.
  for (const accountId of accountIds) {
    for (const credit of loadCheckingCreditsWithId(accountId)) {
      if (!excludedMovementIds.has(credit.movement_id)) continue;
      if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) continue;
      classifyCheckingCreditForIncome(credit, filterCtx);
    }
  }

  lines.sort((a, b) => {
    const byDate = b.received_on.localeCompare(a.received_on);
    if (byDate !== 0) return byDate;
    return b.movement_id - a.movement_id;
  });

  filtered_lines.sort((a, b) => {
    const byDate = b.received_on.localeCompare(a.received_on);
    if (byDate !== 0) return byDate;
    return b.movement_id - a.movement_id;
  });

  refund_lines.sort((a, b) => {
    const byDate = b.received_on.localeCompare(a.received_on);
    if (byDate !== 0) return byDate;
    return b.movement_id - a.movement_id;
  });

  return {
    payload: {
      lines,
      manual: loadManualIncomeEntries(),
      work_earnings: loadPayrollWorkEarnings(),
      income_kind_by_movement_id: mergedIncomeKindByMovementIdRecord(),
      payroll_period_by_movement_id: payrollPeriodByMovementIdRecord(),
      excluded_lines: loadExcludedCheckingIncomeLines(),
      filtered_lines,
      refund_lines,
    },
    consumedLedgerOutflowKeys: filterCtx.consumedCapitalReturnLedgerOutflowKeys,
  };
}

// --- one display unit (`GET /api/income?unit=`) -----------------------------------------------

type InUnit<R> = Omit<R, "amount_clp" | "amount_usd"> & { amount: number | null };

/** A work earning with its net pay (and the deposit that paid it) in the display unit beside the payslip's own figures. */
export type FlowWorkEarningUnitRow = FlowWorkEarningRow & { liquido: number | null; linked_amount: number | null };

/** The income lists in one display unit: each line's `amount` its legs in the unit (`flowLegsInUnit`; pesos rounded). */
export type FlowsCheckingIncomeUnitLists = {
  lines: InUnit<FlowCheckingIncomeLine>[];
  manual: InUnit<FlowManualIncomeLine>[];
  work_earnings: FlowWorkEarningUnitRow[];
  excluded_lines: InUnit<FlowExcludedCheckingIncomeLine>[];
  filtered_lines: InUnit<FlowFilteredCheckingIncomeLine>[];
  refund_lines: InUnit<FlowCheckingIncomeLine & { category_slug: string }>[];
};

function incomeLineInUnit<
  R extends { amount_clp: number; amount_usd: number | null; received_on: string; native?: { currency: string; amount: number } },
>(r: R, unit: string): InUnit<R> {
  const { amount_clp: _clp, amount_usd: _usd, native: _native, ...rest } = r;
  return {
    ...rest,
    amount: flowLegsInUnit(incomeLineLegs(r), r.received_on, unit),
  } as InUnit<R>;
}

/** The day a work earning's pay reached the account: its deposit, its wire, else its month's end. */
function workEarningPayDay(row: FlowWorkEarningRow): string {
  return (row.linked_received_on ?? row.wire_received_on ?? monthEndUtcYmd(row.period_month)).slice(0, 10);
}

function workEarningInUnit(row: FlowWorkEarningRow, unit: string): FlowWorkEarningUnitRow {
  const day = workEarningPayDay(row);
  const clp = Math.round(row.liquido_clp);
  // A dollar contract's net pay is its own dollars (any other unit converts them, never their pesos).
  const liquido = flowLegsInUnit(
    { clp, usd: row.liquido_usd ?? clpToUsdAtDate(clp, day), native: row.liquido_usd != null ? "usd" : "clp" },
    day,
    unit
  );
  const linked_amount =
    row.linked_amount_clp == null
      ? null
      : flowLegsInUnit(
          { clp: row.linked_amount_clp, usd: clpToUsdAtDate(row.linked_amount_clp, day) },
          day,
          unit
        );
  return { ...row, liquido, linked_amount };
}

export function flowsCheckingIncomeListsInUnit(
  p: Pick<FlowsCheckingIncomePayload, "lines" | "manual" | "work_earnings" | "excluded_lines" | "filtered_lines" | "refund_lines">,
  unit: string
): FlowsCheckingIncomeUnitLists {
  return {
    lines: p.lines.map((l) => incomeLineInUnit(l, unit)),
    manual: p.manual.map((l) => incomeLineInUnit(l, unit)),
    work_earnings: p.work_earnings.map((r) => workEarningInUnit(r, unit)),
    excluded_lines: p.excluded_lines.map((l) => incomeLineInUnit(l, unit)),
    filtered_lines: p.filtered_lines.map((l) => incomeLineInUnit(l, unit)),
    refund_lines: p.refund_lines.map((l) => incomeLineInUnit(l, unit)),
  };
}
