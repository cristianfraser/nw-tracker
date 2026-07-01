import { monthKeyFromYmd } from "./calendarMonth.js";
import { isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { db } from "./db.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import {
  cartolaDescriptionFromNote,
  checkingCreditMatchesAfpRetiroReturn,
  checkingCreditMatchesInternalWithdrawal,
  checkingCreditMatchesNetWorthCapitalReturn,
  checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn,
  createSplittableInternalTransferPool,
  buildFintualIncomingWireBatches,
  loadNetWorthCapitalReturnLedgerOutflows,
  creditIsReversingMercadoCapitalesCargo,
  isExcludedCheckingInflow,
  loadAfpRetiroOutflowCandidates,
  loadAllCheckingCartolaWithdrawals,
  loadCheckingCartolaWithdrawals,
  loadDepositMatchCandidates,
  type FintualIncomingWireBatch,
} from "./flowsCheckingGastos.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import {
  mergedIncomeKindByMovementIdRecord,
  loadExcludedCheckingIncomeMovementIds,
  loadExcludedCheckingIncomeLines,
  loadForceIncludedCheckingIncomeMovementIds,
  type CheckingIncomeKind,
  type FlowExcludedCheckingIncomeLine,
} from "./flowsCheckingIncomeOverrides.js";
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
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  source: "checking";
};

export type FlowManualIncomeLine = {
  id: number;
  amount_clp: number;
  received_on: string;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
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
  amount_usd: number | null;
  description: string;
  filter_reason: IncomeAutoFilterReason;
};

export type FlowsCheckingIncomePayload = {
  lines: FlowCheckingIncomeLine[];
  manual: FlowManualIncomeLine[];
  monthly_totals: Record<string, number>;
  work_earnings: FlowWorkEarningRow[];
  income_kind_by_movement_id: Record<number, CheckingIncomeKind>;
  payroll_period_by_movement_id: Record<number, string>;
  excluded_lines: FlowExcludedCheckingIncomeLine[];
  filtered_lines: FlowFilteredCheckingIncomeLine[];
};

type CheckingCartolaCreditWithId = {
  movement_id: number;
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

function loadCheckingCartolaCreditsWithId(accountId: number): CheckingCartolaCreditWithId[] {
  return db
    .prepare(
      `SELECT id AS movement_id, account_id, occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp > 0
         AND note LIKE 'import:cartola|%'
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on, id`
    )
    .all(accountId) as CheckingCartolaCreditWithId[];
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
  return db
    .prepare(
      `SELECT id, amount_clp, received_on, source, note
       FROM income_entries
       WHERE note IS NULL OR note NOT LIKE 'import:excel%'
       ORDER BY received_on DESC, id DESC`
    )
    .all()
    .map((row) => ({
      ...(row as Omit<FlowManualIncomeLine, "origin" | "amount_usd">),
      amount_usd: clpToUsdAtDate(
        Math.round((row as { amount_clp: number }).amount_clp),
        (row as { received_on: string }).received_on
      ),
      origin: "manual" as const,
    }));
}

type IncomeFilterContext = {
  accountWithdrawalsByAccountId: Map<number, ReturnType<typeof loadCheckingCartolaWithdrawals>>;
  allWithdrawals: ReturnType<typeof loadAllCheckingCartolaWithdrawals>;
  deposits: ReturnType<typeof loadDepositMatchCandidates>;
  splittablePool: Map<string, number>;
  afpOutflows: ReturnType<typeof loadAfpRetiroOutflowCandidates>;
  ledgerCapitalOutflows: ReturnType<typeof loadNetWorthCapitalReturnLedgerOutflows>;
  fintualWireBatchByMovementId: Map<number, FintualIncomingWireBatch>;
  matchedFintualWireBatchKeys: Set<string>;
  consumedCapitalReturnWithdrawalKeys: Set<string>;
  consumedCapitalReturnLedgerOutflowKeys: Set<string>;
};

function classifyCheckingCreditForIncome(
  credit: CheckingCartolaCreditWithId,
  ctx: IncomeFilterContext
): IncomeAutoFilterReason | null {
  if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) {
    throw new Error(`anchor cartola credit ${credit.movement_id} must not reach income classifier`);
  }

  const description = cartolaDescriptionFromNote(credit.note);
  if (isExcludedCheckingInflow(description)) return "excluded_description";

  const accountWithdrawals =
    ctx.accountWithdrawalsByAccountId.get(credit.account_id) ??
    loadCheckingCartolaWithdrawals(credit.account_id);

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
  credit: CheckingCartolaCreditWithId,
  accountLabels: Map<number, string>
): FlowCheckingIncomeLine {
  const amount_clp = Math.round(credit.amount_clp);
  return {
    movement_id: credit.movement_id,
    account_id: credit.account_id,
    account_label: accountLabels.get(credit.account_id) ?? String(credit.account_id),
    received_on: credit.occurred_on,
    amount_clp,
    amount_usd: clpToUsdAtDate(amount_clp, credit.occurred_on),
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
  const allWithdrawals = loadAllCheckingCartolaWithdrawals();
  const afpOutflows = loadAfpRetiroOutflowCandidates();
  const ledgerCapitalOutflows = loadNetWorthCapitalReturnLedgerOutflows();

  const excludedMovementIds = loadExcludedCheckingIncomeMovementIds();
  const forceIncludedMovementIds = loadForceIncludedCheckingIncomeMovementIds();

  const accountWithdrawalsByAccountId = new Map(
    accountIds.map((accountId) => [accountId, loadCheckingCartolaWithdrawals(accountId)])
  );

  const creditsForBatching: CheckingCartolaCreditWithId[] = [];
  for (const accountId of accountIds) {
    for (const credit of loadCheckingCartolaCreditsWithId(accountId)) {
      if (excludedMovementIds.has(credit.movement_id)) continue;
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
    fintualWireBatchByMovementId,
    matchedFintualWireBatchKeys: new Set(),
    consumedCapitalReturnWithdrawalKeys: new Set(),
    consumedCapitalReturnLedgerOutflowKeys: new Set(),
  };

  const lines: FlowCheckingIncomeLine[] = [];
  const filtered_lines: FlowFilteredCheckingIncomeLine[] = [];

  for (const accountId of accountIds) {
    for (const credit of loadCheckingCartolaCreditsWithId(accountId)) {
      if (excludedMovementIds.has(credit.movement_id)) continue;
      if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) continue;

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
          amount_usd: clpToUsdAtDate(amount_clp, credit.occurred_on),
          description: cartolaDescriptionFromNote(credit.note),
          filter_reason: filterReason,
        });
        continue;
      }

      lines.push(toCheckingIncomeLine(credit, accountLabels));
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

  const monthly_totals: Record<string, number> = {};
  for (const line of lines) {
    const month = monthKeyFromYmd(line.received_on);
    if (!month) continue;
    monthly_totals[month] = (monthly_totals[month] ?? 0) + line.amount_clp;
  }

  return {
    payload: {
      lines,
      manual: loadManualIncomeEntries(),
      monthly_totals,
      work_earnings: loadPayrollWorkEarnings(),
      income_kind_by_movement_id: mergedIncomeKindByMovementIdRecord(),
      payroll_period_by_movement_id: payrollPeriodByMovementIdRecord(),
      excluded_lines: loadExcludedCheckingIncomeLines(),
      filtered_lines,
    },
    consumedLedgerOutflowKeys: filterCtx.consumedCapitalReturnLedgerOutflowKeys,
  };
}
