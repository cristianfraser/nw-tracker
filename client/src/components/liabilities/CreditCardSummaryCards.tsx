import { useTranslation } from "../../i18n";
import { formatClp, formatUsdFine } from "../../format";
import type { AccountCcInstallmentsResponse, CcBankCupoStatusDto } from "../../types";
import { formatDateTimeLabel, formatYearMonthLabel } from "../../formatDateLabel";
import styles from "./CreditCardSummaryCards.module.css";

type BankCupoCurrency = CcBankCupoStatusDto["currencies"][number];

function formatBankAmount(n: number, currency: BankCupoCurrency["currency"]): string {
  return currency === "clp" ? formatClp(n) : formatUsdFine(n);
}

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
  // toward 0), so detalle[0] is a far-future row with cupo/saldo = 0. "Deuda en cuotas" is a
  // point-in-time "now" value → use the open/current billing month, falling back to the latest
  // closed statement when there is no open row.
  const openBm = ccLedger.open_billing_month ?? null;
  const currentRow =
    (openBm ? detalle.find((r) => r.billing_month === openBm) : undefined) ?? latestClosed;
  const facturaciones = ccLedger.facturaciones ?? [];
  const latestFact = facturaciones[0];
  // The facturación still accumulating charges — its total is what the next statement will bill.
  const openFact = facturaciones.find((f) => f.is_open_month);
  const cupo = ccLedger.cupo;
  const bankCupo = ccLedger.bank_cupo ?? null;
  const bankVerdict = (c: BankCupoCurrency): string => {
    if (c.status === "ok") return t("accountDetail.creditCard.bankCupoOk");
    if (c.status === "indeterminate") return t("accountDetail.creditCard.bankCupoIndeterminate");
    if (c.status === "mismatch" && c.diff != null) {
      const sign = c.diff > 0 ? "+" : "−";
      return t("accountDetail.creditCard.bankCupoMismatch", {
        diff: `${sign}${formatBankAmount(Math.abs(c.diff), c.currency)}`,
      });
    }
    return t("accountDetail.creditCard.bankCupoPending");
  };

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
            {latestClosed.billing_month} ({formatYearMonthLabel(latestClosed.billing_month)})
            {latestClosed.provisional ? (
              <span title={t("accountDetail.creditCard.provisionalCloseHint")}>
                {" "}
                · {t("accountDetail.creditCard.provisionalClose")}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.openFacturacion")}</div>
        <div className="value mono">
          {openFact?.facturado_total_clp != null ? formatClp(openFact.facturado_total_clp) : "—"}
        </div>
        {openFact ? (
          <div className="muted mono">
            {openFact.billing_month} ({formatYearMonthLabel(openFact.billing_month)})
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.deudaEnCuotas")}</div>
        <div className="value mono">
          {formatClp(currentRow?.cupo_en_cuotas_clp ?? ccLedger.totals.total_remaining_principal_clp)}
        </div>
        {/* The slice of that debt the open facturación bills — it leaves on that statement's pay-by. */}
        {openFact?.cuota_a_pagar_clp != null ? (
          <div className="muted mono">
            {formatYearMonthLabel(openFact.billing_month)} · {formatClp(openFact.cuota_a_pagar_clp)}
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.cupo")}</div>
        <div className="value mono">{cupo?.used_clp != null ? formatClp(cupo.used_clp) : "—"}</div>
        {cupo?.available_clp != null && cupo.total_clp != null ? (
          <div className="muted mono">
            {t("accountDetail.creditCard.cupoAvailableOf", {
              available: formatClp(cupo.available_clp),
              total: formatClp(cupo.total_clp),
            })}
          </div>
        ) : null}
        {/* The bank's own utilizado per currency from the nightly session, and the check's verdict. */}
        {bankCupo ? (
          <div className="muted mono" title={t("accountDetail.creditCard.bankCupoHint")}>
            <div>
              {t("accountDetail.creditCard.bankCupo", {
                date: formatDateTimeLabel(new Date(bankCupo.observed_at)),
              })}
            </div>
            {bankCupo.currencies.map((c) => (
              <div
                key={c.currency}
                className={c.status === "mismatch" ? styles.bankMismatch : undefined}
                title={c.reason ?? undefined}
              >
                {formatBankAmount(c.cupo_utilizado, c.currency)} · {bankVerdict(c)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );

  if (stripSlots) return cards;
  return <div className="cards">{cards}</div>;
}
