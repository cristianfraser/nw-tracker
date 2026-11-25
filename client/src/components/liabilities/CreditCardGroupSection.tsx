import { useTranslation } from "../../i18n";
import type { AccountCcInstallmentsResponse, CcGroupLanesResponse } from "../../types";
import { loadableClass } from "../ui/Loadable";
import { PageGridTile } from "../layout/PageGridTile";
import { CcUpcomingPaymentsList } from "./CcUpcomingPaymentsList";
import { CreditCardGroupLanes } from "./CreditCardGroupLanes";
import {
  CreditCardDetalleSurface,
  CreditCardHistorialSurface,
  type CcSurfaceScope,
} from "./CreditCardLedgerSurfaces";

/** The lanes' frame while the first payload loads: the head and an empty total row, dimmed. */
const EMPTY_LANES: CcGroupLanesResponse = {
  billing_currency: "clp", // convention-ok: placeholder frame only; every figure is zero and dimmed
  today_iso: "",
  axis: { start_iso: "", end_iso: "", days: 1, today_share: 0, ticks: [] },
  total: { owed: [], owed_total: 0, cuotas_ahead: 0, cupo: null, next_payment: null },
  cards: [],
  upcoming_months: [],
};

/**
 * The credit-card group page (`/liabilities/credit-card`), shaped like a card's own page instead of
 * the asset-group layout: the cards' lanes (server `ccGroupLanes.ts`), «Upcoming payments»
 * beside the summed «History» (the card page's chart over the merged ledger), then the monthly
 * detail. The Pasivos root keeps its own credit-card section (`LiabilitiesCreditCardGroupSection`).
 */
export function CreditCardGroupSection({
  portfolioGroup,
  lanes,
  lanesLoading,
  lanesError,
  ccLedger,
  ccLedgerLoading,
}: {
  portfolioGroup: string;
  lanes: CcGroupLanesResponse | undefined;
  lanesLoading: boolean;
  /** The lanes request failed with no data to show: its message replaces the lanes and the list. */
  lanesError: string | null;
  ccLedger: AccountCcInstallmentsResponse;
  ccLedgerLoading: boolean;
}) {
  const { t } = useTranslation();
  const ccScope: CcSurfaceScope = { variant: "group", portfolioGroup };
  const lanesData = lanes ?? EMPTY_LANES;
  const lanesDim = lanesError == null && (lanesLoading || lanes == null);
  return (
    <>
      <PageGridTile id="cc-lanes" className={loadableClass(lanesDim)} aria-busy={lanesDim || undefined}>
        {lanesError != null ? <p className="error">{lanesError}</p> : <CreditCardGroupLanes data={lanesData} loading={lanesDim} />}
      </PageGridTile>

      <PageGridTile id="cc-charts" className="chart-grid">
        <div className={loadableClass(lanesDim, "chart-grid__col")}>
          <div className="chart-panel-title-row">
            <h3 className="chart-panel-title">{t("groupPage.creditCardLanes.upcomingTitle")}</h3>
          </div>
          {lanesError != null ? <p className="error">{lanesError}</p> : <CcUpcomingPaymentsList data={lanesData} loading={lanesDim} />}
        </div>
        <CreditCardHistorialSurface
          ccLedger={ccLedger}
          scope={ccScope}
          loading={ccLedgerLoading}
          className="chart-grid__col"
        />
      </PageGridTile>

      <CreditCardDetalleSurface ccLedger={ccLedger} scope={ccScope} loading={ccLedgerLoading} />
    </>
  );
}
