import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatCurrency } from "../../format";
import { loadableClass } from "../../components/ui/Loadable";
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

/** The property cards need the summary's deposits and the unit they are in. */
function propertySummary(
  summary: Pick<AccountSummaryResponse, "latest_valuation"> & Partial<Pick<AccountSummaryResponse, "deposits" | "unit">>
): Pick<AccountSummaryResponse, "unit" | "deposits" | "latest_valuation"> {
  if (summary.unit == null || summary.deposits == null) {
    throw new Error("DeptoAccountSummaryCards: the property variant needs the summary's deposits and unit");
  }
  return { unit: summary.unit, deposits: summary.deposits, latest_valuation: summary.latest_valuation };
}

function formatPl(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatCurrency(value, unit);
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
  loading = false,
}: {
  variant: "mortgage" | "property";
  ledger: AccountMortgageLedgerResponse;
  summary: Pick<AccountSummaryResponse, "latest_valuation"> &
    Partial<Pick<AccountSummaryResponse, "deposits" | "unit">>;
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[];
  accountDashRow: DashboardAccountRow | null;
  /** The ledger is a placeholder or held prior data: the cards dim (empty values read «—»). */
  loading?: boolean;
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
            propertySummary(summary),
            monthlyPerfRows,
            accountDashRow
          )
        : null,
    [variant, ledger, summary, monthlyPerfRows, accountDashRow]
  );

  if (variant === "mortgage" && mortgageData) {
    return (
      <div className={loadableClass(loading, "cards")}>
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
      <div className={loadableClass(loading, "cards")}>
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
          <div className="value mono">{formatPl(propertyData.deposited, propertyData.depositedUnit)}</div>
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.property.plYtd")}</div>
          <div className="value mono">{formatPl(propertyData.plYtd, propertyData.plUnit)}</div>
        </div>
        <div className="card">
          <div className="label">{t("accountDetail.deptoSummary.property.plTotal")}</div>
          <div className="value mono">{formatPl(propertyData.plTotal, propertyData.plUnit)}</div>
        </div>
      </div>
    );
  }

  return null;
}
