/**
 * The Fintual certificado's transactions (`fund_account.transactions`, read from the CSV by
 * ingest) → one aggregate per row with a net flow, for the cert-account reconcile
 * (`fintualCertImport.ts`) and the valor-cuota backfill (`fintualFundUnitDaily.ts`).
 */
import type { FundTransaction } from "nw-tracker-contracts";
import { type DepositFlowKind, depositFlowKindFromFintualMedio } from "./depositFlowKind.js";

export type GoalToImportNote = (goalId: string, investmentName: string) => string | null;

type Agg = {
  ymd: string;
  goalId: string;
  name: string;
  flowKind: DepositFlowKind;
  clpNet: number;
  cuotasNet: number;
  medios: Set<string>;
  valorCuotaHint: number | null;
};

export type FintualCertificadoAggregateScan = {
  sortedAggregates: Agg[];
};

/**
 * One aggregate per transaction with a net flow (no same-day merge), in `maxMonth` or before,
 * on a goal `matchGoal` knows. Does not touch the database.
 */
export function aggregateFintualCertificado(
  transactions: readonly FundTransaction[],
  maxMonth: string,
  matchGoal: GoalToImportNote
): FintualCertificadoAggregateScan {
  const sortedAggregates: Agg[] = [];
  for (const t of transactions) {
    if (t.date.slice(0, 7) > maxMonth) continue;
    const goalId = t.investment.id.trim();
    const nombre = t.investment.name.trim();
    if (!goalId || !matchGoal(goalId, nombre)) continue;
    const clpNet = t.clp_in - t.clp_out;
    const cuotasNet = t.units_in - t.units_out;
    if (clpNet === 0 && cuotasNet === 0) continue;
    const medio = t.medio?.trim() ?? "";
    const medios = new Set<string>();
    if (medio) medios.add(medio);
    sortedAggregates.push({
      ymd: t.date,
      goalId,
      name: nombre,
      flowKind: depositFlowKindFromFintualMedio(medio),
      clpNet,
      cuotasNet,
      medios,
      valorCuotaHint: t.unit_value != null && t.unit_value > 0 ? t.unit_value : null,
    });
  }
  sortedAggregates.sort((x, y) => {
    const c = x.ymd.localeCompare(y.ymd);
    return c !== 0 ? c : x.goalId.localeCompare(y.goalId);
  });
  return { sortedAggregates };
}
