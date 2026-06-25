import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import type {
  AccountMortgageLedgerResponse,
  AccountMonthlyPerformanceRow,
  AccountSummaryResponse,
  DashboardAccountRow,
} from "../../types";
import { ClpUfSuperscriptAmount } from "./ClpUfSuperscriptAmount";
import {
  buildMortgageSummaryCardsData,
  buildPropertySummaryCardsData,
} from "./deptoAccountSummary";
import styles from "../AccountDetailPage.module.css";

function formatPlClp(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatClp(value);
}

function PaymentCardValue({
  amountClp,
  date,
}: {
  amountClp: number | null;
  date: string | null;
}) {
  if (amountClp == null || !Number.isFinite(amountClp)) {
    return <span className="mono">—</span>;
  }
  return (
    <>
      <div className="value mono">{formatClp(amountClp)}</div>
      {date ? <div className="muted mono">{date}</div> : null}
    </>
  );
}

export function DeptoAccountSummaryCards({
  variant,
  ledger,
  summary,
  monthlyPerfRows,
  accountDashRow,
}: {
  variant: "mortgage" | "property";
  ledger: AccountMortgageLedgerResponse;
  summary: Pick<AccountSummaryResponse, "latest_valuation_clp"> &
    Partial<Pick<AccountSummaryResponse, "deposits_clp">>;
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[];
  accountDashRow: DashboardAccountRow | null;
}) {
  const { t } = useTranslation();

  const mortgageData = useMemo(
    () =>
      variant === "mortgage"
        ? buildMortgageSummaryCardsData(ledger, summary, monthlyPerfRows, accountDashRow)
        : null,
    [variant, ledger, summary, monthlyPerfRows, accountDashRow]
  );

  const propertyData = useMemo(
    () =>
      variant === "property"
        ? buildPropertySummaryCardsData(
            ledger,
            {
              latest_valuation_clp: summary.latest_valuation_clp,
              deposits_clp: summary.deposits_clp ?? 0,
            },
            monthlyPerfRows,
            accountDashRow
          )
        : null,
    [variant, ledger, summary, monthlyPerfRows, accountDashRow]
  );

  if (variant === "mortgage" && mortgageData) {
    return (
      <div className={cn("cards", styles.cardsBelow, styles.positionBlock)}>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.mortgage.currentBalance")}</div>
          <div className="value">
            <ClpUfSuperscriptAmount
              clpClp={mortgageData.balanceClp}
              ufAmount={mortgageData.balanceUf}
            />
          </div>
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.mortgage.lastPayment")}</div>
          <PaymentCardValue
            amountClp={mortgageData.lastPaymentClp}
            date={mortgageData.lastPaymentDate}
          />
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.mortgage.nextPayment")}</div>
          <PaymentCardValue
            amountClp={mortgageData.nextPaymentClp}
            date={mortgageData.nextPaymentDate}
          />
        </div>
      </div>
    );
  }

  if (variant === "property" && propertyData) {
    return (
      <div className={cn("cards", styles.cardsBelow, styles.positionBlock)}>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.property.value")}</div>
          <div className="value">
            <ClpUfSuperscriptAmount
              clpClp={propertyData.valueClp}
              ufAmount={propertyData.valueUf}
            />
          </div>
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.property.deposited")}</div>
          <div className="value mono">{formatClp(propertyData.depositedClp)}</div>
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.property.plYtd")}</div>
          <div className="value mono">{formatPlClp(propertyData.plYtdClp)}</div>
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.property.plTotal")}</div>
          <div className="value mono">{formatPlClp(propertyData.plTotalClp)}</div>
        </div>
      </div>
    );
  }

  return null;
}
