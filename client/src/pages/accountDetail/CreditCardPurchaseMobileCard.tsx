import type { ReactNode } from "react";
import type { CcInstallmentPurchaseComputed, CcProxyLotResult } from "../../types";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { formatYmEs } from "./shared";
import styles from "../AccountDetailPage.module.css";

function PurchaseMeta({ children }: { children: ReactNode }) {
  return <div className={cn("muted", styles.purchaseMeta)}>{children}</div>;
}

export function CreditCardPurchaseMobileCard({
  purchase,
  hasLedger,
  dueColumn,
  originLabel,
  manualDeleteLabel,
  manualBusy,
  onDeleteManual,
  extraOffsets,
  onExtraOffsetChange,
  purchaseProxy,
  inlineTicker,
}: {
  purchase: CcInstallmentPurchaseComputed;
  hasLedger: boolean;
  dueColumn: "last" | "none";
  originLabel: string;
  manualDeleteLabel: string;
  manualBusy: boolean;
  onDeleteManual?: () => void;
  extraOffsets: Record<string, number>;
  onExtraOffsetChange: (purchaseId: string, value: number) => void;
  purchaseProxy?: CcProxyLotResult;
  inlineTicker?: string;
}) {
  const title = (
    <>
      <div>{purchase.label}</div>
      <div className={cn("mono", "muted", styles.purchaseMeta)}>{purchase.purchase_id}</div>
    </>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <PurchaseMeta>{originLabel}</PurchaseMeta>
        {purchase.note ? <PurchaseMeta>{purchase.note}</PurchaseMeta> : null}
        {hasLedger && purchase.origin === "manual" && purchase.purchase_db_id != null && onDeleteManual ? (
          <button
            type="button"
            className={cn("muted", styles.purchaseMeta)}
            disabled={manualBusy}
            onClick={onDeleteManual}
          >
            {manualDeleteLabel}
          </button>
        ) : null}
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label="Cuotas" value={String(purchase.installment_count)} />
        {dueColumn !== "last" ? <TableMobileCardRow label="Pagadas" value={String(purchase.installments_paid)} /> : null}
        {dueColumn !== "last" ? <TableMobileCardRow label="Restan" value={String(purchase.remaining_installments)} /> : null}
        <TableMobileCardRow label="Principal" value={formatClp(purchase.principal_clp)} />
      </TableMobileCardSection>

      <TableMobileCardSection>
        {!hasLedger ? (
          <TableMobileCardRow
            label="Tasa % anual"
            value={purchase.annual_interest_pct.toFixed(2).replace(".", ",")}
          />
        ) : null}
        <TableMobileCardRow label="Mes compra" value={purchase.purchase_month ?? "—"} />
        {dueColumn !== "last" ? <TableMobileCardRow label="1.ª cuota (MES)" value={purchase.first_due_month} /> : null}
        {dueColumn === "last" ? (
          <TableMobileCardRow
            label="Mes último pago"
            value={purchase.last_paid_month ? formatYmEs(purchase.last_paid_month) : "—"}
          />
        ) : null}
      </TableMobileCardSection>

      {!hasLedger ? (
        <TableMobileCardSection>
          <TableMobileCardRow label="Offset CSV (meses)" value={String(purchase.schedule_offset_months)} />
          <TableMobileCardRow
            label="Offset UI (meses)"
            value={
              <input
                type="number"
                step={1}
                className={cn("mono", styles.offsetInput)}
                value={extraOffsets[purchase.purchase_id] ?? 0}
                onChange={(e) => {
                  const raw = e.target.value;
                  const n = raw === "" || raw === "-" ? 0 : Math.trunc(Number(raw));
                  onExtraOffsetChange(purchase.purchase_id, Number.isFinite(n) ? n : 0);
                }}
                aria-label={`Meses de offset adicionales para ${purchase.label}`}
              />
            }
          />
        </TableMobileCardSection>
      ) : null}

      <TableMobileCardSection>
        <TableMobileCardRow label="Cuota CLP" value={formatClp(purchase.cuota_clp)} />
        {dueColumn !== "last" ? <TableMobileCardRow label="Restante CLP" value={formatClp(purchase.remaining_principal_clp)} /> : null}
      </TableMobileCardSection>

      {dueColumn === "none" && purchase.payment_statements && purchase.payment_statements.length > 0 ? (
        <TableMobileCardSection>
          <div className={cn("muted", styles.purchaseMeta)}>Estado(s) con cuota para esta compra:</div>
          {purchase.merged_purchase_ids && purchase.merged_purchase_ids.length > 1 ? (
            <div className={cn("mono", "muted", styles.purchaseMeta)}>
              duplicate purchase ids merged: {purchase.merged_purchase_ids.join(", ")}
            </div>
          ) : null}
          {purchase.merge_reason ? (
            <div className={cn("mono", "muted", styles.purchaseMeta)}>merge reason: {purchase.merge_reason}</div>
          ) : null}
          {purchase.heuristic_hints && purchase.heuristic_hints.length > 0 ? (
            <div className={cn("mono", "muted", styles.purchaseMeta)}>
              heuristics: {purchase.heuristic_hints.join(" | ")}
            </div>
          ) : null}
          {purchase.payment_statements.map((st) => {
            const ticker = inlineTicker ?? "fintual_cert_reserva2";
            const r = purchaseProxy?.by_ticker[ticker];
            const cuota = r?.cuotas?.find((c) => c.pay_by_date === st.pay_by_date);
            let proxyInline: string | null = null;
            if (cuota) {
              const sign = cuota.accumulated_gain_clp >= 0 ? "+" : "";
              proxyInline = `ret. acum. ${ticker}: ${sign}${formatClp(Math.round(cuota.accumulated_gain_clp))} (${cuota.accumulated_return_pct >= 0 ? "+" : ""}${cuota.accumulated_return_pct.toFixed(2)}%)`;
            }
            return (
              <div key={`${purchase.purchase_id}:st:${st.pay_by_date}`} className={cn("mono", "muted", styles.purchaseMeta)}>
                {st.statement_date ?? "sin fecha estado"} · {st.source_pdf ?? "sin source_pdf"} · pay_by{" "}
                {st.pay_by_date} · cuota {st.cuota_current ?? "?"} · {formatClp(st.amount_clp)}
                {proxyInline ? ` · ${proxyInline}` : null}
              </div>
            );
          })}
        </TableMobileCardSection>
      ) : null}
    </TableMobileCard>
  );
}

export function purchaseTableColSpan(
  hasLedger: boolean,
  dueColumn: "last" | "none"
): number {
  // Base desktop columns — "last": Compra, Cuotas, Principal, Mes compra, Cuota CLP, Mes último
  // pago; "none" swaps the último-pago column for Pagadas, Restan, 1.ª cuota, Restante CLP.
  // Without a ledger the Tasa + Offset CSV/UI columns are added. +1 = the mobile-only cell.
  const desktop = (dueColumn === "last" ? 6 : 9) + (hasLedger ? 0 : 3);
  return desktop + 1;
}
