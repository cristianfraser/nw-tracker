import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import type { AccountCcInstallmentsResponse } from "../../types";
import { formatYmEs } from "../../pages/accountDetail/shared";
import styles from "../../pages/AccountDetailPage.module.css";

export function CreditCardSummaryCards({ ccLedger }: { ccLedger: AccountCcInstallmentsResponse }) {
  const { t } = useTranslation();
  const detalle = ccLedger.billing_detail_by_month ?? [];
  const latestClosed = detalle.find((r) => r.as_of_kind === "statement");
  const latestRow = detalle[0];
  const facturaciones = ccLedger.facturaciones ?? [];
  const latestFact = facturaciones[0];

  return (
    <div className={cn("cards", styles.cardsBelow)}>
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
        <div className="label">{t("accountDetail.creditCard.cupoUtilizado")}</div>
        <div className="value mono">
          {formatClp(latestRow?.cupo_en_cuotas_clp ?? ccLedger.totals.total_remaining_principal_clp)}
        </div>
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.saldoTotal")}</div>
        <div className="value mono">
          {latestRow != null ? formatClp(latestRow.balance_total_clp) : "—"}
        </div>
      </div>
    </div>
  );
}
