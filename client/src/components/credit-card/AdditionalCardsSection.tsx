import { useTranslation } from "../../i18n";
import {
  flowChartGranularityFromMetricsPeriod,
  flowPeriodLabel,
  flowTableGranularity,
  formatFlowMoney,
} from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { AdditionalCardsPeriodRow, AdditionalCardsSummary } from "../../types";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { SurfaceControls } from "../ui/SurfaceControls";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";

const PAGE_SIZE = 12;

function pick(clp: number, usd: number | null, unit: DisplayUnit, what: string): number {
  if (unit === "usd") {
    if (usd == null) throw new Error(`missing USD figure for additional cards ${what}`);
    return usd;
  }
  return clp;
}

/**
 * «Tarjetas adicionales»: the additional cards' charges (auto `no_cuenta`, not the user's gastos)
 * against the credits classified `card_reimbursement`, per month or year, with the running
 * balance owed. Every figure is the server's (`payload.additional_cards`); this only picks.
 */
export function AdditionalCardsSection({
  summary,
  displayUnit,
}: {
  summary: AdditionalCardsSummary;
  displayUnit: DisplayUnit;
}) {
  const { t } = useTranslation();
  const prefs = useSurfacePrefs("flows.expenses.additionalCards", "month", "total");
  const granularity = flowTableGranularity(flowChartGranularityFromMetricsPeriod(prefs.period));
  const rows = granularity === "year" ? summary.by_year : summary.by_month;
  const newestFirst = [...rows].reverse();
  const { page, setPage, pageRows, total } = useClientPagination(newestFirst, PAGE_SIZE);

  if (summary.by_month.length === 0) return null;

  const money = (row: AdditionalCardsPeriodRow, field: "charges" | "reimbursements" | "net" | "balance") =>
    formatFlowMoney(
      pick(row[`${field}_clp`], row[`${field}_usd`], displayUnit, `${field} ${row.period_month}`),
      displayUnit
    );
  const labels = {
    charges: t("expenses.additionalCards.colCharges"),
    reimbursements: t("expenses.additionalCards.colReimbursements"),
    net: t("expenses.additionalCards.colNet"),
    balance: t("expenses.additionalCards.colBalance"),
  };

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div className="chart-panel-title-row" style={{ marginBottom: "0.35rem" }}>
        <h3 style={{ fontSize: "1.1rem", margin: 0 }}>
          {t("expenses.additionalCards.title")}
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {t("expenses.additionalCards.balanceLabel")}{" "}
            {formatFlowMoney(
              pick(
                summary.totals.balance_clp,
                summary.totals.balance_usd,
                displayUnit,
                "balance total"
              ),
              displayUnit
            )}
          </span>
        </h3>
        <SurfaceControls
          period={prefs.period}
          onPeriodChange={prefs.setPeriod}
          periodOptions={["month", "year"]}
        />
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
        {t("expenses.additionalCards.hint")}
      </p>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
        <Table
          tableStyle={{ fontSize: "0.85rem" }}
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("accountDetail.monthCloseColumn")}</th>
                <th className="desktop-only">{labels.charges}</th>
                <th className="desktop-only">{labels.reimbursements}</th>
                <th className="desktop-only">{labels.net}</th>
                <th className="desktop-only">{labels.balance}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {pageRows.map((row) => {
            const period = `${row.as_of_date} (${flowPeriodLabel(row.period_month, granularity)})`;
            return (
              <tr key={row.period_month}>
                <td className="mono desktop-only">{period}</td>
                <td className="mono desktop-only">
                  {money(row, "charges")} <span className="muted">({row.charge_count})</span>
                </td>
                <td className="mono desktop-only">
                  {money(row, "reimbursements")}{" "}
                  <span className="muted">({row.reimbursement_count})</span>
                </td>
                <td className="mono desktop-only">{money(row, "net")}</td>
                <td className="mono desktop-only">{money(row, "balance")}</td>
                <td className="mobile-only">
                  <TableMobileCard title={period}>
                    <TableMobileCardSection>
                      <TableMobileCardRow
                        label={labels.charges}
                        value={`${money(row, "charges")} (${row.charge_count})`}
                      />
                      <TableMobileCardRow
                        label={labels.reimbursements}
                        value={`${money(row, "reimbursements")} (${row.reimbursement_count})`}
                      />
                    </TableMobileCardSection>
                    <TableMobileCardSection>
                      <TableMobileCardRow label={labels.net} value={money(row, "net")} />
                      <TableMobileCardRow label={labels.balance} value={money(row, "balance")} />
                    </TableMobileCardSection>
                  </TableMobileCard>
                </td>
              </tr>
            );
          })}
        </Table>
      </PaginatedTable>
    </section>
  );
}
