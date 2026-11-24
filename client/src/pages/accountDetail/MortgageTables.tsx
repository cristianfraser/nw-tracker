import { useMemo } from "react";
import { PaginatedTable, useClientPagination } from "../../components/ui/PaginatedTable";
import { Table } from "../../components/ui/Table";
import { ColumnTable, type TableColumn } from "../../components/ui/ColumnTable";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import type {
  AccountMortgageLedgerResponse,
  DeptoMortgageSheetRow,
  DeptoPaymentScenarioRow,
  DeptoPaymentScenarioTerm,
} from "../../types";
import { formatMoney } from "../../format";
import { cn } from "../../cn";
import i18n from "../../i18n";
import { PageGridTile } from "../../components/layout/PageGridTile";
import styles from "../AccountDetailPage.module.css";

/** The two currencies of a ledger row, a scenario row or the ledger's meta. */
type LoanCurrencies = { loan_currency: string; payment_currency: string };

/** A figure in the loan's currency with its payment-currency amount as a muted sub-line (shared desktop/mobile pair cell). */
function cellLoanPayPair(c: LoanCurrencies, loan: number | null, pay: number | null) {
  if (loan == null && pay == null) return "—";
  return (
    <>
      {loan != null ? formatMoney({ value: loan, currency: c.loan_currency }, { precision: "full" }) : "—"}
      {pay != null ? (
        <span className={cn("muted", styles.cellSub)}>{formatMoney({ value: pay, currency: c.payment_currency })}</span>
      ) : null}
    </>
  );
}

/** The minimum payment's payment-currency amount is not on the row; convert at the row's rate. */
function minPay(row: DeptoMortgageSheetRow): number | null {
  if (row.min_loan == null || row.loan_rate_day == null) return null;
  return row.min_loan * row.loan_rate_day;
}

/** The maximum payment's payment-currency amount is not on the row; convert at the row's rate. */
function maxPay(row: DeptoMortgageSheetRow): number | null {
  if (row.max_loan == null || row.loan_rate_day == null) return null;
  return row.max_loan * row.loan_rate_day;
}

/** Remaining credit: the loan's currency (coarse) with the payment-currency amount as a muted sub-line. */
function cellCreditoPair(row: DeptoMortgageSheetRow) {
  if (row.credito_restante_loan == null && row.restante_pay == null) return "—";
  return (
    <>
      {row.credito_restante_loan != null ? formatMoney({ value: row.credito_restante_loan, currency: row.loan_currency }) : "—"}
      {row.restante_pay != null ? (
        <span className={cn("muted", styles.cellSub)}>{formatMoney({ value: row.restante_pay, currency: row.payment_currency })}</span>
      ) : null}
    </>
  );
}

function colLabel(key: string): string {
  return i18n.t(`accountDetail.mortgageSheet.cols.${key}`);
}

type MergedCellLine = {
  /** Column key of the value the line carries. */
  key: string;
  /** A total of the lines above it: no label, drawn under a separator line. */
  total?: boolean;
  /** Leading figure: an amount in the loan's currency, or any ready-made text (the cuota number). */
  main: string;
  /** Trailing muted figure: the payment-currency amount; null when `main` is the whole line, spanning both figure columns. */
  sub: string | null;
};

function loanPayLine(c: LoanCurrencies, key: string, loan: number | null, pay: number | null): MergedCellLine {
  return {
    key,
    main: loan != null ? formatMoney({ value: loan, currency: c.loan_currency }, { precision: "full" }) : "—",
    sub: pay != null ? formatMoney({ value: pay, currency: c.payment_currency }) : null,
  };
}

function loanPayTotalLine(c: LoanCurrencies, loan: number | null, pay: number | null): MergedCellLine {
  return { ...loanPayLine(c, "total", loan, pay), total: true };
}

/**
 * Several values in one cell: one line per value, label / figure / muted figure
 * aligned in columns across the lines (desktop only; the mobile card keeps one row per value).
 * `labels: false` leaves the label column out where the header already says what each line is.
 */
function cellMergedLines(lines: MergedCellLine[], { labels = true }: { labels?: boolean } = {}) {
  return (
    <span className={cn(styles.mergedLines, !labels && styles.mergedLinesUnlabelled)}>
      {lines.map((l) => (
        <span key={l.key} className={cn(styles.mergedLine, l.total && styles.mergedLineTotal)}>
          {labels ? (
            <span className={cn("muted", styles.mergedLineLabel)}>
              {l.total ? "" : colLabel(l.key)}
            </span>
          ) : null}
          {l.sub == null ? (
            <span className={styles.mergedLineWide}>{l.main}</span>
          ) : (
            <>
              <span>{l.main}</span>
              <span className="muted">{l.sub}</span>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

function MortgageDividendosMobileCard({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <TableMobileCard title={`${row.cuota} · ${row.occurred_on}`}>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("pago")} value={cellLoanPayPair(row, row.pago_loan, row.pago_pay)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("credito")} value={cellCreditoPair(row)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("minUf")} value={cellLoanPayPair(row, row.min_loan, minPay(row))} />
        <TableMobileCardRow label={colLabel("maxUf")} value={cellLoanPayPair(row, row.max_loan, maxPay(row))} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={colLabel("incendio")}
          value={cellLoanPayPair(row, row.incendio_loan, row.incendio_pay)}
        />
        <TableMobileCardRow
          label={colLabel("desgravamen")}
          value={cellLoanPayPair(row, row.desgravamen_loan, row.desgravamen_pay)}
        />
        <TableMobileCardRow
          label={colLabel("interes")}
          value={cellLoanPayPair(row, row.interes_loan, row.interes_pay)}
        />
        {row.prepayment_charge_pay != null ? (
          <TableMobileCardRow
            label={colLabel("prepaymentCharge")}
            value={cellLoanPayPair(row, row.prepayment_charge_loan, row.prepayment_charge_pay)}
          />
        ) : null}
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={colLabel("amortizacion")}
          value={cellLoanPayPair(row, row.amortizacion_loan, row.amortizacion_pay)}
        />
        <TableMobileCardRow
          label={colLabel("amortExt")}
          value={cellLoanPayPair(row, row.amortizacion_ext_loan, row.amortizacion_ext_pay)}
        />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

function MortgageDividendosDesktopRow({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <>
      <td className={cn("mono", "desktop-only", styles.nowrap)}>
        {cellMergedLines(
          [
            { key: "cuota", main: `${row.cuota} · ${row.occurred_on}`, sub: null },
            loanPayLine(row, "pago", row.pago_loan, row.pago_pay),
          ],
          { labels: false }
        )}
      </td>
      <td className="mono desktop-only">{cellCreditoPair(row)}</td>
      <td className={cn("mono", "desktop-only", styles.nowrap)}>
        {cellMergedLines([
          loanPayLine(row, "min", row.min_loan, minPay(row)),
          loanPayLine(row, "max", row.max_loan, maxPay(row)),
        ])}
      </td>
      <td className={cn("mono", "desktop-only", styles.nowrap)}>
        {cellMergedLines([
          loanPayLine(row, "incendio", row.incendio_loan, row.incendio_pay),
          loanPayLine(row, "desgravamen", row.desgravamen_loan, row.desgravamen_pay),
          loanPayLine(row, "interes", row.interes_loan, row.interes_pay),
          ...(row.prepayment_charge_pay != null
            ? [loanPayLine(row, "prepaymentCharge", row.prepayment_charge_loan, row.prepayment_charge_pay)]
            : []),
          loanPayTotalLine(row, row.seguros_interes_loan, row.seguros_interes_pay),
        ])}
      </td>
      <td className={cn("mono", "desktop-only", styles.nowrap)}>
        {cellMergedLines([
          loanPayLine(row, "amortizacion", row.amortizacion_loan, row.amortizacion_pay),
          loanPayLine(row, "amortExt", row.amortizacion_ext_loan, row.amortizacion_ext_pay),
          loanPayTotalLine(row, row.amortizacion_total_loan, row.amortizacion_total_pay),
        ])}
      </td>
    </>
  );
}

export function MortgageDividendosTable({
  ledger,
  variant = "property",
  loading = false,
}: {
  ledger: AccountMortgageLedgerResponse;
  /** `property` = inmueble (incl. pie); `mortgage` = pasivo (solo cuotas / prepagos). */
  variant?: "property" | "mortgage";
  /** The ledger is a placeholder: the meta cards show their frame («—») instead of waiting for `meta`. */
  loading?: boolean;
}) {
  const m = ledger.meta;
  const isMortgageView = variant === "mortgage";

  const rowsSorted = useMemo(
    () => [...ledger.rows].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on))),
    [ledger.rows]
  );

  // Display newest payments first. `occurred_on` is ISO-like (`YYYY-MM-DD`), so lexicographic
  // order matches chronological order.
  const { page, setPage, pageRows, total } = useClientPagination(rowsSorted, 12);

  const showSheetCards = Boolean(m || loading) && !isMortgageView;
  const heading = (
    <h2>
      {isMortgageView
        ? i18n.t("accountDetail.mortgageSheet.titleMortgage")
        : i18n.t("accountDetail.mortgageSheet.titleProperty")}
    </h2>
  );

  // Tiles of the page grid (styles/page-grid.css): the heading rides in the first one, the
  // sheet cards (property view) get their own tile so the row gap separates them from the table.
  return (
    <>
      {showSheetCards ? (
        <PageGridTile id="mortgage-sheet-cards">
          {heading}
          <div className="cards">
            <div className="card">
              <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.viviendaHoja")}</div>
              <div className="value mono">
                {m?.valor_vivienda_loan != null ? formatMoney({ value: m.valor_vivienda_loan, currency: m.loan_currency }) : "—"}
              </div>
            </div>
            <div className="card">
              <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.hipotecaTrasPie")}</div>
              <div className="value mono">
                {m?.hipoteca_tras_pie_loan != null ? formatMoney({ value: m.hipoteca_tras_pie_loan, currency: m.loan_currency }) : "—"}
              </div>
            </div>
            <div className="card">
              <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.pieClpUf")}</div>
              <div className={cn("value", "mono", styles.cardValueSecondary)}>
                {m?.pie_pay != null ? formatMoney({ value: m.pie_pay, currency: m.payment_currency }) : "—"} ·{" "}
                {m?.pie_loan != null ? formatMoney({ value: m.pie_loan, currency: m.loan_currency }, { precision: "full" }) : "—"}
              </div>
            </div>
            <div className="card">
              <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.filasDePago")}</div>
              <div className="value mono">{m?.row_count ?? "—"}</div>
            </div>
          </div>
        </PageGridTile>
      ) : null}
      <PageGridTile id="mortgage-sheet">
        {showSheetCards ? null : heading}
        {ledger.card_lines_without_payment.length > 0 && (
          <p className="muted">
            {i18n.t("accountDetail.mortgageSheet.cardLinesWithoutPayment")}{" "}
            {ledger.card_lines_without_payment
              .map((l) => `${l.date} · ${l.merchant} · ${formatMoney(l.amount)} · ${l.account_name}`)
              .join(" | ")}
          </p>
        )}
        <PaginatedTable page={page} pageSize={12} total={total} onPageChange={setPage}>
          <Table
            tableClassName={cn("mortgage-sheet", "table--parallel-mobile", styles.tableMortgage)}
            header={
            <thead>
              <tr>
                <th className="desktop-only">{colLabel("cuotaPago")}</th>
                <th className="desktop-only">{colLabel("credito")}</th>
                <th className="desktop-only">{colLabel("minMaxUf")}</th>
                <th className="desktop-only">{colLabel("segurosInteres")}</th>
                <th className="desktop-only">{colLabel("amortizaciones")}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
          >
            {pageRows.map((row, idx) => (
              <tr key={`${row.cuota}-${row.occurred_on}-${idx}`}>
                <MortgageDividendosDesktopRow row={row} />
                <td className="mobile-only">
                  <MortgageDividendosMobileCard row={row} />
                </td>
              </tr>
            ))}
          </Table>
        </PaginatedTable>
      </PageGridTile>
    </>
  );
}

const SCENARIO_TERMS: DeptoPaymentScenarioTerm[] = [30, 25, 20, 15, 12, 10, 5, "max"];

function scenarioTermLabel(term: DeptoPaymentScenarioTerm): string {
  if (term === 30) return i18n.t("accountDetail.mortgageSheet.terms.years30Min");
  if (term === "max") return i18n.t("accountDetail.mortgageSheet.terms.max");
  return i18n.t("accountDetail.mortgageSheet.terms.years", { n: term });
}

function scenarioPaymentForTerm(
  row: DeptoPaymentScenarioRow,
  term: DeptoPaymentScenarioTerm,
  byTerm: Map<DeptoPaymentScenarioTerm, { payment_loan: number | null; payment_pay: number | null }>
): { loan: number | null; pay: number | null } {
  if (term === 30) {
    return { loan: row.min_payment_loan, pay: row.min_payment_pay };
  }
  const cell = byTerm.get(term);
  return { loan: cell?.payment_loan ?? null, pay: cell?.payment_pay ?? null };
}

/** «próx.» / «cotizada» under the cuota number; the card's title leads each with a space. */
function scenarioCuotaMarks(row: DeptoPaymentScenarioRow, lead: string) {
  return (
    <>
      {row.is_next_payment ? (
        <span className={cn("muted", styles.cellSub)}>
          {lead}
          {i18n.t("accountDetail.mortgageSheet.proxAbbrev")}
        </span>
      ) : null}
      {row.quoted ? (
        <span className={cn("muted", styles.cellSub)}>
          {lead}
          {i18n.t("accountDetail.mortgageSheet.quotedAbbrev")}
        </span>
      ) : null}
    </>
  );
}

const scenarioColumns = (): TableColumn<DeptoPaymentScenarioRow>[] => [
  {
    key: "cuota",
    header: colLabel("cuota"),
    className: "mono",
    cell: (row) => (
      <>
        {row.cuota}
        {scenarioCuotaMarks(row, "")}
      </>
    ),
    // The card's title carries the date too (the desktop row's second column).
    title: (row) => (
      <>
        {row.cuota}
        {scenarioCuotaMarks(row, " ")}
        {" · "}
        {row.occurred_on}
      </>
    ),
  },
  { key: "fecha", header: colLabel("fecha"), className: "mono", cell: (row) => row.occurred_on, desktopOnly: true },
  ...SCENARIO_TERMS.map(
    (term): TableColumn<DeptoPaymentScenarioRow> => ({
      key: String(term),
      header: scenarioTermLabel(term),
      headerClassName: styles.nowrap,
      className: cn("mono", styles.nowrap),
      cell: (row) => {
        const cell = scenarioPaymentForTerm(row, term, new Map(row.scenarios.map((s) => [s.term, s])));
        return cellLoanPayPair(row, cell.loan, cell.pay);
      },
    })
  ),
];

export function DeptoPaymentScenarioTable({
  rows,
  loading = false,
}: {
  rows: DeptoPaymentScenarioRow[];
  /** The scenarios are a placeholder: the table shows its header only instead of vanishing. */
  loading?: boolean;
}) {
  const rowsDisplay = useMemo(() => [...rows].reverse(), [rows]);

  const { page: scenarioPage, setPage: setScenarioPage, pageRows: scenarioPageRows, total: scenarioTotal } =
    useClientPagination(rowsDisplay, 12);

  if (!rows.length && !loading) return null;

  return (
    <PageGridTile id="mortgage-scenarios">
      <h3>{i18n.t("accountDetail.mortgageSheet.referenceMinMax")}</h3>
      <PaginatedTable page={scenarioPage} pageSize={12} total={scenarioTotal} onPageChange={setScenarioPage}>
        <ColumnTable
          rows={scenarioPageRows}
          columns={scenarioColumns()}
          rowKey={(row) => `${row.cuota}-${row.occurred_on}`}
          tableClassName={styles.tableScenario}
        />
      </PaginatedTable>
    </PageGridTile>
  );
}
