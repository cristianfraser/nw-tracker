import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatUsdFine } from "../../format";
import type { AccountCcInstallmentsResponse, CcFacturacionDto } from "../../types";
import { formatYearMonthLabel } from "../../formatDateLabel";

/** «total · month», then the CLP facturado and the dollar facturado with its pesos. */
function FacturacionCardBody({ fact, note }: { fact: CcFacturacionDto | undefined; note?: ReactNode }) {
  if (!fact) return <div className="value mono">—</div>;
  return (
    <>
      <div className="value mono">
        {fact.facturado_total_clp != null ? formatClp(fact.facturado_total_clp) : "—"}{" "}
        <span className="muted">· {formatYearMonthLabel(fact.billing_month)}</span>
        {note}
      </div>
      <div className="muted mono">{fact.facturado_clp != null ? formatClp(fact.facturado_clp) : "—"}</div>
      {fact.facturado_usd != null ? (
        <div className="muted mono">
          {formatUsdFine(fact.facturado_usd)}
          {fact.facturado_usd_clp != null ? ` (${formatClp(fact.facturado_usd_clp)})` : ""}
        </div>
      ) : null}
    </>
  );
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
  // The facturación still accumulating charges — its total is what the next statement will bill.
  const openFact = facturaciones.find((f) => f.is_open_month);
  // Facturaciones are sorted descending: the first closed one is the last billed.
  const lastFact = facturaciones.find((f) => !f.is_open_month);
  const cupo = ccLedger.cupo;
  // The bank states each currency's cupo (nightly product summary); without it, the app's CLP cupo.
  const bankCupo = ccLedger.bank_cupo ?? null;
  const cupoLines: { key: string; available: string; total: string }[] = bankCupo
    ? bankCupo.currencies.map((c) => {
        const fmt = c.currency === "clp" ? formatClp : formatUsdFine;
        return { key: c.currency, available: fmt(c.cupo_disponible), total: fmt(c.cupo_total) };
      })
    : cupo?.available_clp != null && cupo.total_clp != null
      ? [{ key: "clp", available: formatClp(cupo.available_clp), total: formatClp(cupo.total_clp) }]
      : [];

  const cards = (
    <>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.openFacturacion")}</div>
        <FacturacionCardBody fact={openFact} />
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.lastFacturado")}</div>
        <FacturacionCardBody
          fact={lastFact}
          note={
            lastFact?.is_provisional_close ? (
              <span className="muted" title={t("accountDetail.creditCard.provisionalCloseHint")}>
                {" "}
                · {t("accountDetail.creditCard.provisionalClose")}
              </span>
            ) : null
          }
        />
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
        {cupoLines.length === 0 ? <div className="value mono">—</div> : null}
        {cupoLines.map((line, i) => (
          <div key={line.key} className={i === 0 ? "value mono" : "muted mono"}>
            {line.available} / {line.total}
          </div>
        ))}
      </div>
    </>
  );

  if (stripSlots) return cards;
  return <div className="cards">{cards}</div>;
}
