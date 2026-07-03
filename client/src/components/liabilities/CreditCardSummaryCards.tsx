import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import type { AccountCcInstallmentsResponse } from "../../types";
import { formatYmEs } from "../../pages/accountDetail/shared";
import styles from "../../pages/AccountDetailPage.module.css";

export function CreditCardSummaryCards({
  ccLedger,
  stripSlots = false,
}: {
  ccLedger: AccountCcInstallmentsResponse;
  /** Render bare cards for a `PortfolioEntityCardsStrip` row instead of a standalone `.cards` grid. */
  stripSlots?: boolean;
}) {
  const { t } = useTranslation();
  const detalle = ccLedger.billing_detail_by_month ?? [];
  const latestClosed = detalle.find((r) => r.as_of_kind === "statement");
  // Detalle is sorted descending and includes projected future months (installments amortized
  // toward 0), so detalle[0] is a far-future row with cupo/saldo = 0. "Cupo utilizado" and
  // "Saldo total" are point-in-time "now" values → use the open/current billing month, falling
  // back to the latest closed statement when there is no open row.
  const openBm = ccLedger.open_billing_month ?? null;
  const currentRow =
    (openBm ? detalle.find((r) => r.billing_month === openBm) : undefined) ?? latestClosed;
  const facturaciones = ccLedger.facturaciones ?? [];
  const latestFact = facturaciones[0];

  const cards = (
    <>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.lastFacturado")}</div>
        <div className="value mono">
          {latestClosed?.total_facturado_clp != null
            ? formatClp(latestClosed.total_facturado_clp)
            : latestFact?.facturado_total_clp != null
              ? formatClp(latestFact.facturado_total_clp)
              : "—"}
        </div>
        {latestClosed ? (
          <div className="muted mono">
            {latestClosed.billing_month} ({formatYmEs(latestClosed.billing_month)})
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.nextPayment")}</div>
        <div className={cn("value", "mono", styles.cardValueSecondary)}>
          {ccLedger.totals.next_calendar_month
            ? `${formatYmEs(ccLedger.totals.next_calendar_month)} · ${formatClp(ccLedger.totals.next_calendar_month_total_clp ?? 0)}`
            : latestFact?.cuota_a_pagar_clp != null
              ? formatClp(latestFact.cuota_a_pagar_clp)
              : "—"}
        </div>
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.deudaEnCuotas")}</div>
        <div className="value mono">
          {formatClp(currentRow?.cupo_en_cuotas_clp ?? ccLedger.totals.total_remaining_principal_clp)}
        </div>
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.cupoUtilizado")}</div>
        <div className="value mono">
          {currentRow != null ? formatClp(currentRow.balance_total_clp) : "—"}
        </div>
      </div>
    </>
  );

  if (stripSlots) return cards;
  return <div className="cards">{cards}</div>;
}
