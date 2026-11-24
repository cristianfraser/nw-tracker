import { useState, type ReactNode } from "react";
import { cn } from "../../cn";
import { BenchmarkSelectOptions } from "../../benchmarkLabels";
import { useTranslation } from "../../i18n";
import { useBenchmarks, useDeptoPrepayments } from "../../queries/hooks";
import { useSurfaceBenchmark } from "../../surfaceDisplayPrefs";
import { queryLoadError } from "../../queries/pageShapeReady";
import { formatMoney, formatPct } from "../../format";
import type { DisplayUnit } from "../../queries/keys";
import type {
  DeptoPaymentBarDto,
  DeptoPaymentPart,
  DeptoPaymentRowDto,
  DeptoPaymentsListDto,
  DeptoPrepayBlockDto,
  DeptoPrepayCellDto,
} from "../../types";
import { pct1Signed, signedMoney, toneOf } from "./deptoFormat";
import styles from "./Depto.module.css";

/** Rows shown before «N pagos» opens the rest. */
const COLLAPSED_ROWS = 12;

const w = (share: number) => `${share * 100}%`;

/** Each bar part's name (its segment's hover title). */
const PART_LABEL_KEY: Record<DeptoPaymentPart, string> = {
  amortization: "accountDetail.depto.partAmortization",
  extra: "accountDetail.depto.partExtra",
  interest: "accountDetail.depto.partInterest",
  insurance: "accountDetail.depto.partInsurance",
  charge: "accountDetail.depto.partCharge",
  prepago: "accountDetail.depto.partPrepago",
};

/** A figure over its muted second line (the payment currency, the extra, the insurance). */
function Cell({ className, lines }: { className?: string; lines: readonly (ReactNode | null)[] }) {
  const [first, ...rest] = lines;
  return (
    <span className={cn("mono", styles.r, className)}>
      <span className={styles.line}>{first}</span>
      {rest.map((l, i) => (l == null ? null : <span key={i} className={styles.sub}>{l}</span>))}
    </span>
  );
}

/** A payment's split bar on the list's scale; a payment over the scale is cut, «› scale». */
function SplitBar({ bar, scale, loanCurrency }: { bar: DeptoPaymentBarDto; scale: number; loanCurrency: string }) {
  const { t } = useTranslation();
  const total = bar.segments.reduce((a, s) => a + s.share, 0);
  return (
    <span className={styles.sbar}>
      <span className={styles.segs} style={{ width: w(Math.min(1, total)) }}>
        {bar.segments.map((s) => (
          <i
            key={s.part}
            className={styles[`part_${s.part}`]}
            style={{ width: total > 0 ? w(s.share / total) : 0 }}
            title={t(PART_LABEL_KEY[s.part])}
          />
        ))}
      </span>
      {bar.clipped ? <em className="mono">› {formatMoney({ value: scale, currency: loanCurrency })}</em> : null}
    </span>
  );
}

/** Prepaid vs invested today: two thin bars, then Δ and its % (tone by sign). */
function PrepayCell({ cell, unit, irr }: { cell: DeptoPrepayCellDto | undefined; unit: string; irr?: ReactNode }) {
  const { t } = useTranslation();
  if (!cell || cell.delta == null) return <span className={cn("mono", styles.r, styles.muted)}>—</span>;
  return (
    <span className={cn("mono", styles.dl)}>
      <span className={styles.pvt}>
        <span className={styles.pv}>
          <i
            style={{ width: w(cell.prepaid_share ?? 0), background: "var(--depto-prepaid)" }}
            title={cell.prepaid_value != null ? `${t("accountDetail.depto.prepaid")} ${formatMoney({ value: cell.prepaid_value, currency: unit })}` : undefined}
          />
          <i
            style={{ width: w(cell.invested_share ?? 0), background: "var(--depto-invested)" }}
            title={cell.invested_value != null ? `${t("accountDetail.depto.invested")} ${formatMoney({ value: cell.invested_value, currency: unit })}` : undefined}
          />
        </span>
        {irr}
      </span>
      <span className={cn(styles.r, styles[toneOf(cell.delta) ?? "muted"])}>
        <span className={styles.line}>{signedMoney(cell.delta, unit)}</span>
        {cell.delta_pct != null ? <span className={styles.sub}>{pct1Signed(cell.delta_pct)}</span> : null}
      </span>
    </span>
  );
}

/**
 * «Dividendos»: the next cuota (dimmed), the Σ row, then every payment newest first — one markup,
 * a row per payment while the list is wide and a card per payment when its container is narrow
 * (`@container depto-payments`), so the two renderings carry the same fields. Prepaid vs invested
 * follows the benchmark picked in the header (the bundle's block for its default, else
 * `/api/accounts/:id/depto-prepayments`), remembered per account.
 */
export function DeptoPaymentsList({
  accountId,
  payments,
  unit,
  loanCurrency,
  payCurrency,
  onRegisterPayment,
}: {
  accountId: number;
  payments: DeptoPaymentsListDto;
  unit: DisplayUnit;
  loanCurrency: string;
  payCurrency: string;
  /** Opens the payment form; null when the account has no such capability. */
  onRegisterPayment: (() => void) | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { benchmark, setBenchmark } = useSurfaceBenchmark(`account.${accountId}.prepayments`, payments.default_benchmark);
  const benchmarks = useBenchmarks();
  const options = (benchmarks.data?.benchmarks ?? []).filter((o) => o.slug !== "mortgage");
  const selected = options.some((o) => o.slug === benchmark) ? benchmark : payments.default_benchmark;
  // Never in the bundle: a stale benchmark series fails this column only.
  const prepay = useDeptoPrepayments(accountId, selected, unit, true);
  const block: DeptoPrepayBlockDto | null =
    prepay.data != null && prepay.data.benchmark === selected && prepay.data.unit === unit ? prepay.data : null;
  // The block in flight: the prepay column dims (the rest of the list stays).
  const prepayLoading = (prepay.isPending || prepay.isPlaceholderData) && prepay.error == null;
  // The block failed and nothing is held: say so (the cells show «—»).
  const prepayFailed = queryLoadError(prepay) != null;
  // A benchmark whose history starts after the first payment leaves the earlier ones out of Σ.
  const partial = block != null && block.totals.covered_payments < Object.keys(block.rows).length ? block.totals : null;

  const rows = expanded ? payments.rows : payments.rows.slice(0, COLLAPSED_ROWS);
  const totals = payments.totals;
  const next = payments.next;
  const prepayClass = prepayLoading ? "loadable is-loading" : undefined;
  const irr = (pct: number | null, color: string, annualized: boolean) =>
    pct == null ? (
      <b />
    ) : (
      <b
        style={{ color }}
        title={`${t(annualized ? "periodReturns.irrAnnual" : "periodReturns.irr", { pct: formatPct(pct * 100, 1) })} · ${t("periodReturns.irrTitle")}`}
      >
        {formatPct(pct * 100, 1)}
      </b>
    );

  return (
    <div className={cn(styles.scope, styles.payWrap)}>
      <div className={styles.payList}>
        <div className={cn(styles.payRow, styles.payHead)}>
          <span />
          <span className={styles.r}>{t("accountDetail.depto.colPaid")}</span>
          <span />
          <span className={styles.r}>{t("accountDetail.depto.colAmortization")}</span>
          <span className={styles.r}>{t("accountDetail.depto.colInterest")}</span>
          <span className={styles.r}>{t("accountDetail.depto.colBalance")}</span>
          <span className={styles.r}>{t("accountDetail.depto.colMin")}</span>
          <span className={styles.r}>
            {options.length ? (
              <select
                className={styles.benchSelect}
                value={selected}
                aria-label={t("accountDetail.depto.compareWith")}
                onChange={(e) => setBenchmark(e.target.value)}
              >
                <BenchmarkSelectOptions t={t} options={options} />
              </select>
            ) : null}
          </span>
        </div>

        {next ? (
          <div className={cn(styles.payRow, styles.payNext)}>
            <span className="mono">
              <b className={styles.line}>{next.cuota}</b>
              <span className={styles.sub}>{next.date}</span>
            </span>
            <Cell lines={[formatMoney({ value: next.min_loan, currency: loanCurrency }), formatMoney({ value: next.min_pay, currency: payCurrency })]} />
            <span className={styles.sbar}>
              <span className={styles.ghost} style={{ width: w(next.min_share) }} />
              {next.max_share != null ? (
                <span className={styles.ghostHi} style={{ width: w(next.max_share - next.min_share) }} />
              ) : null}
              {next.max_loan != null ? <em className="mono">{formatMoney({ value: next.max_loan, currency: loanCurrency })}</em> : null}
            </span>
            <span />
            <span />
            <span />
            <span className={cn("mono", styles.r, styles.muted)}>{formatMoney({ value: next.min_loan, currency: loanCurrency })}</span>
            <span className={styles.r}>
              {onRegisterPayment ? (
                <button type="button" className={styles.btn} onClick={onRegisterPayment}>
                  {t("accountDetail.depto.registerPayment")}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}

        <div className={cn(styles.payRow, styles.payTotal)}>
          <span className="mono">
            <b className={styles.line}>Σ</b>
            <span className={styles.sub}>{totals.first_date}</span>
          </span>
          <Cell lines={[formatMoney({ value: totals.paid_loan, currency: loanCurrency }), formatMoney({ value: totals.paid_pay, currency: payCurrency })]} />
          <SplitBar bar={totals.bar} scale={payments.bar_scale_loan} loanCurrency={loanCurrency} />
          <Cell
            lines={[
              formatMoney({ value: totals.amortization_loan, currency: loanCurrency }),
              `+${formatMoney({ value: totals.extra_loan, currency: loanCurrency })}`,
              formatMoney({ value: totals.amortization_total_pay, currency: payCurrency }),
            ]}
          />
          <Cell
            className={styles.neg}
            lines={[
              formatMoney({ value: totals.interest_loan, currency: loanCurrency }),
              formatMoney({ value: totals.insurance_loan, currency: loanCurrency }),
              formatMoney({ value: totals.interest_pay, currency: payCurrency }),
              formatMoney({ value: totals.insurance_pay, currency: payCurrency }),
            ]}
          />
          <span />
          <span />
          <span className={prepayClass}>
            <PrepayCell
              cell={block?.totals}
              unit={unit}
              irr={
                block ? (
                  <span className={styles.irr}>
                    {irr(block.totals.prepaid_irr_pct, "var(--depto-prepaid)", block.totals.irr_annualized)}
                    {irr(block.totals.invested_irr_pct, "var(--depto-invested)", block.totals.irr_annualized)}
                  </span>
                ) : null
              }
            />
          </span>
        </div>

        {rows.map((row) => (
          <PaymentRow
            key={row.key}
            row={row}
            scale={payments.bar_scale_loan}
            loanCurrency={loanCurrency}
            payCurrency={payCurrency}
            unit={unit}
            cell={block?.rows[row.key]}
            prepayClass={prepayClass}
          />
        ))}
      </div>
      <div className={styles.foot}>
        {prepayFailed ? <span className="error">{t("accountDetail.depto.prepayLoadFailed")}</span> : null}
        {partial && partial.covered_from ? (
          <span className="mono">
            {t("accountDetail.depto.prepayCoveredFrom", {
              date: partial.covered_from,
              covered: partial.covered_payments,
              total: Object.keys(block!.rows).length,
            })}
          </span>
        ) : null}
        {payments.rows.length > COLLAPSED_ROWS ? (
          <button type="button" className={styles.lnk} onClick={() => setExpanded((v) => !v)}>
            {expanded ? t("accountDetail.depto.paymentsCollapse") : t("accountDetail.depto.paymentsCount", { count: payments.rows.length })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PaymentRow({
  row,
  scale,
  loanCurrency,
  payCurrency,
  unit,
  cell,
  prepayClass,
}: {
  row: DeptoPaymentRowDto;
  scale: number;
  loanCurrency: string;
  payCurrency: string;
  unit: string;
  cell: DeptoPrepayCellDto | undefined;
  prepayClass: string | undefined;
}) {
  const { t } = useTranslation();
  const isPrepago = row.kind === "prepago";
  return (
    <div className={styles.payRow}>
      <span className="mono">
        <b className={cn(styles.line, isPrepago && styles.prepagoNum)}>
          {isPrepago ? t("accountDetail.depto.prepagoNumber", { n: row.number }) : row.number}
        </b>
        <span className={styles.sub}>{row.date}</span>
      </span>
      <Cell lines={[formatMoney({ value: row.paid_loan, currency: loanCurrency }), formatMoney({ value: row.paid_pay, currency: payCurrency })]} />
      <SplitBar bar={row.bar} scale={scale} loanCurrency={loanCurrency} />
      <Cell
        lines={[
          row.amortization_loan != null ? formatMoney({ value: row.amortization_loan, currency: loanCurrency }) : "—",
          row.extra_loan != null ? `+${formatMoney({ value: row.extra_loan, currency: loanCurrency })}` : null,
        ]}
      />
      <Cell
        className={styles.neg}
        lines={[
          row.interest_loan != null ? formatMoney({ value: row.interest_loan, currency: loanCurrency }) : "—",
          row.insurance_loan != null ? formatMoney({ value: row.insurance_loan, currency: loanCurrency }) : row.charge_loan != null ? formatMoney({ value: row.charge_loan, currency: loanCurrency }) : "—",
        ]}
      />
      <Cell lines={[formatMoney({ value: row.balance_loan, currency: loanCurrency }), formatMoney({ value: row.balance_pay, currency: payCurrency })]} />
      <span className={cn("mono", styles.r, styles.muted)}>{row.min_loan != null ? formatMoney({ value: row.min_loan, currency: loanCurrency }) : "—"}</span>
      <span className={prepayClass}>
        <PrepayCell cell={cell} unit={unit} />
      </span>
    </div>
  );
}
