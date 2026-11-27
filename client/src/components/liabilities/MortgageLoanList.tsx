import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatMoney } from "../../format";
import { pct1 } from "../depto/deptoFormat";
import depto from "../depto/Depto.module.css";
import styles from "./MortgageGroup.module.css";
import type { MortgageGroupGlanceDto, MortgageGroupLoanDto } from "../../types";

const BLANK = "\u00a0";

function PaidBar({ paidShare }: { paidShare: number }) {
  return (
    <div className={styles.bar}>
      <i style={{ width: `${paidShare * 100}%`, background: "var(--accent)" }} />
    </div>
  );
}

function LoanRow({ loan, unit, several }: { loan: MortgageGroupLoanDto; unit: string; several: boolean }) {
  const { t } = useTranslation();
  const native = (value: number) => formatMoney({ value, currency: loan.loan_currency });
  const showUnit = loan.loan_currency !== unit;
  return (
    <li className={styles.row}>
      <span className={cn(styles.name, styles.cName)}>
        {several ? <i className={styles.sw} style={{ background: `rgb(${loan.color_rgb})` }} /> : null}
        <Link to={`/account/${loan.account_id}`}>{loan.name}</Link>
      </span>
      <span className={cn("mono", styles.r, styles.cBal)}>
        {native(loan.balance_loan)}
        {showUnit ? <span className={styles.sub}>{formatMoney({ value: loan.balance, currency: unit })}</span> : null}
      </span>
      <span className={cn("mono", styles.cPaid)}>
        <PaidBar paidShare={loan.paid_share} />
        <span className={styles.sub}>
          {t("liabilities.mortgageGroup.paidOf", { share: pct1(loan.paid_share), original: native(loan.original_loan) })}
        </span>
      </span>
      <span className={cn("mono", styles.r, styles.cNext)}>
        {loan.next ? (
          <>
            <em className={styles.lbl}>{t("liabilities.mortgageGroup.colNext")} </em>
            {native(loan.next.min_loan)}
            <span className={styles.sub}>
              {loan.next.date}
              {showUnit ? ` · ${formatMoney({ value: loan.next.min, currency: unit })}` : ""}
            </span>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className={cn("mono", styles.r, styles.cRate)}>
        {loan.annual_rate != null ? (
          <>
            <em className={styles.lbl}>{t("liabilities.mortgageGroup.colRate")} </em>
            {pct1(loan.annual_rate)}
          </>
        ) : null}
      </span>
      <span className={cn("mono", styles.r, styles.cPayoff)}>
        {loan.payoff ? (
          <>
            <em className={styles.lbl}>{t("liabilities.mortgageGroup.colPayoff")}</em>
            <span>
              <span className={depto.acc}>{loan.payoff.date}</span>
              <span className={styles.sub}>{t(loan.payoff.cuotas === 1 ? "liabilities.mortgageGroup.cuotasLeftOne" : "liabilities.mortgageGroup.cuotasLeft", { count: loan.payoff.cuotas })}</span>
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * The mortgage group's loan list (`mortgage-glance`): a row per loan in its own currency with the
 * unit under it, linking to its page, and a total row with several loans. The mortgage group page
 * and the Liabilities page draw it from the same payload. Blank and dimmed by the caller while
 * the payload is pending.
 */
export function MortgageLoanList({ glance }: { glance: MortgageGroupGlanceDto | undefined }) {
  const { t } = useTranslation();
  const unit = glance?.unit;
  const several = (glance?.loans.length ?? 0) > 1;
  return (
    <ul className={styles.list} aria-label={t("liabilities.mortgageGroup.loansLabel")}>
      <li className={cn(styles.row, styles.head)} aria-hidden="true">
        <span>{t("liabilities.mortgageGroup.colLoan")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colBalance")}</span>
        <span>{t("liabilities.mortgageGroup.colPaid")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colNext")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colRate")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colPayoff")}</span>
      </li>
      {glance && unit
        ? glance.loans.map((l) => <LoanRow key={l.account_id} loan={l} unit={unit} several={several} />)
        : (
          <li className={styles.row}>
            <span className={styles.cName}>{BLANK}</span>
          </li>
        )}
      {glance?.loans_without_ledger.map((l) => (
        <li key={l.account_id} className={styles.row}>
          <span className={cn(styles.name, styles.cName)}>
            <Link to={`/account/${l.account_id}`}>{l.name}</Link>
          </span>
          <span className={styles.empty}>{t("accountDetail.depto.noLedger")}</span>
        </li>
      ))}
      {glance?.total && unit ? (
        <li className={cn(styles.row, styles.total)}>
          <span className={styles.cName}>{t("liabilities.mortgageGroup.total")}</span>
          <span className={cn("mono", styles.r, styles.cBal)}>{formatMoney({ value: glance.total.balance, currency: unit })}</span>
          <span className={cn("mono", styles.cPaid)}>
            <PaidBar paidShare={glance.total.paid_share} />
            <span className={styles.sub}>{t("liabilities.mortgageGroup.paidShare", { share: pct1(glance.total.paid_share) })}</span>
          </span>
          <span className={cn("mono", styles.r, styles.cNext)}>
            {glance.total.next_min != null ? (
              <>
                <em className={styles.lbl}>{t("liabilities.mortgageGroup.colNext")} </em>
                {formatMoney({ value: glance.total.next_min, currency: unit })}
              </>
            ) : null}
          </span>
          <span className={styles.cRate} />
          <span className={styles.cPayoff} />
        </li>
      ) : null}
    </ul>
  );
}

