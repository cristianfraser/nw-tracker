import { monthKeyFromYmd } from "./calendarMonth.js";
import { isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { db } from "./db.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import {
  cartolaDescriptionFromNote,
  checkingCreditMatchesAfpRetiroReturn,
  checkingCreditMatchesInternalWithdrawal,
  checkingCreditMatchesNetWorthCapitalReturn,
  createSplittableInternalTransferPool,
  creditIsReversingMercadoCapitalesCargo,
  isExcludedCheckingInflow,
  loadAfpRetiroOutflowCandidates,
  loadAllCheckingCartolaWithdrawals,
  loadCheckingCartolaWithdrawals,
  loadDepositMatchCandidates,
  loadNetWorthCapitalOutflowCandidates,
} from "./flowsCheckingGastos.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";

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

export type FlowsCheckingIncomePayload = {
  lines: FlowCheckingIncomeLine[];
  manual: FlowManualIncomeLine[];
  monthly_totals: Record<string, number>;
};

type CheckingCartolaCreditWithId = {
  movement_id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

function loadCheckingCartolaCreditsWithId(accountId: number): CheckingCartolaCreditWithId[] {
  return db
    .prepare(
      `SELECT id AS movement_id, occurred_on, amount_clp, note
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

export function buildFlowsCheckingIncomePayload(): FlowsCheckingIncomePayload {
  const accountIds = listMovementBalanceCashAccountIds();
  const accountLabels = loadAccountLabels(accountIds);
  const deposits = loadDepositMatchCandidates();
  const splittablePool = createSplittableInternalTransferPool(deposits);
  const allWithdrawals = loadAllCheckingCartolaWithdrawals();
  const investmentOutflows = loadNetWorthCapitalOutflowCandidates();
  const afpOutflows = loadAfpRetiroOutflowCandidates();

  const lines: FlowCheckingIncomeLine[] = [];

  for (const accountId of accountIds) {
    const accountWithdrawals = loadCheckingCartolaWithdrawals(accountId);
    for (const credit of loadCheckingCartolaCreditsWithId(accountId)) {
      if (credit.note != null && isCheckingLedgerAnchorNote(credit.note)) continue;

      const description = cartolaDescriptionFromNote(credit.note);
      if (isExcludedCheckingInflow(description)) continue;
      if (creditIsReversingMercadoCapitalesCargo(credit, accountWithdrawals)) continue;
      if (
        checkingCreditMatchesInternalWithdrawal(
          credit,
          accountId,
          allWithdrawals,
          deposits,
          splittablePool
        )
      ) {
        continue;
      }
      if (checkingCreditMatchesAfpRetiroReturn(credit, afpOutflows)) continue;
      if (checkingCreditMatchesNetWorthCapitalReturn(credit, investmentOutflows)) continue;

      lines.push({
        movement_id: credit.movement_id,
        account_id: accountId,
        account_label: accountLabels.get(accountId) ?? String(accountId),
        received_on: credit.occurred_on,
        amount_clp: Math.round(credit.amount_clp),
        amount_usd: clpToUsdAtDate(Math.round(credit.amount_clp), credit.occurred_on),
        description,
        source: "checking",
      });
    }
  }

  lines.sort((a, b) => {
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
    lines,
    manual: loadManualIncomeEntries(),
    monthly_totals,
  };
}
