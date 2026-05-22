import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYmEs } from "./shared";
import type { CcBillingDetailMonthDto } from "../../types";
import { Table } from "../../components/Table";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { cn } from "../../cn";
import styles from "../AccountDetailPage.module.css";

function clpInputFromAmount(amount: number | null | undefined): string {
  if (amount == null || amount <= 0) return "";
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function parseClpInput(raw: string): number | null {
  const digits = raw.replace(/\./g, "").trim();
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function FacturadoCell({
  row,
  accountId,
  displayUnit,
  extraCcOffsets,
}: {
  row: CcBillingDetailMonthDto;
  accountId: number;
  displayUnit: "clp" | "usd";
  extraCcOffsets: Record<string, number>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => clpInputFromAmount(row.facturado_placeholder_clp));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setText(clpInputFromAmount(row.facturado_placeholder_clp));
  }, [row.facturado_placeholder_clp]);

  const refreshLedger = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.accountDetail(
        String(accountId),
        displayUnit,
        "monthly",
        JSON.stringify(extraCcOffsets)
      ),
    });
  };

  if (!row.facturado_editable) {
    return (
      <>{row.total_facturado_clp != null ? formatClp(row.total_facturado_clp) : "—"}</>
    );
  }

  const save = async () => {
    const parsed = parseClpInput(text);
    const stored = row.facturado_placeholder_clp;
    if (parsed === stored || (parsed == null && (stored == null || stored <= 0))) return;
    setBusy(true);
    try {
      await api.patchCcBillingFacturadoPlaceholder(accountId, {
        billing_month: row.billing_month,
        estimated_facturado_clp: parsed,
      });
      refreshLedger();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        className={cn("mono", styles.facturadoPlaceholderInput)}
        value={text}
        disabled={busy}
        aria-label={t("accountDetail.creditCard.facturadoPlaceholderInputAria", {
          month: row.billing_month,
        })}
        placeholder="0"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
      />
      {row.facturado_is_placeholder ? (
        <span className="muted"> · {t("accountDetail.creditCard.facturadoPlaceholderEstimated")}</span>
      ) : null}
    </>
  );
}

export function CreditCardDetallePorMesTable({
  rows,
  accountId,
  displayUnit,
  extraCcOffsets = {},
  collapsedVisibleRows = 12,
}: {
  rows: readonly CcBillingDetailMonthDto[];
  accountId: number;
  displayUnit: "clp" | "usd";
  extraCcOffsets?: Record<string, number>;
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();
  const hidden = Math.max(0, rows.length - collapsedVisibleRows);

  return (
    <Table
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={t("table.showMoreMonths", { count: hidden })}
      showLessLabel={t("table.showLessMonths")}
      header={
        <thead>
          <tr>
            <th>{t("account.creditCard.colBillingMonth")}</th>
            <th>{t("accountDetail.creditCard.colTotalFacturado")}</th>
            <th>{t("accountDetail.creditCard.colCupoEnCuotas")}</th>
            <th>{t("accountDetail.creditCard.colBalanceTotal")}</th>
          </tr>
        </thead>
      }
    >
      {rows.map((row) => (
        <tr key={`${row.billing_month}-${row.as_of_date}`}>
          <td className="mono">
            {row.billing_month} ({formatYmEs(row.billing_month)})
            {row.as_of_kind === "manual" ? (
              <span className="muted"> · {t("accountDetail.creditCard.manualRowNote")}</span>
            ) : null}
          </td>
          <td className="mono">
            <FacturadoCell
              row={row}
              accountId={accountId}
              displayUnit={displayUnit}
              extraCcOffsets={extraCcOffsets}
            />
          </td>
          <td className="mono">{formatClp(row.cupo_en_cuotas_clp)}</td>
          <td className="mono">{formatClp(row.balance_total_clp)}</td>
        </tr>
      ))}
    </Table>
  );
}
