import { benchmarkOptionLabel } from "../../benchmarkLabels";
import { cn } from "../../cn";
import { formatClp, formatPct, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import { useBenchmarks, useMortgagePrepaymentComparison } from "../../queries/hooks";
import { useSurfaceBenchmark } from "../../surfaceDisplayPrefs";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";
import { TableMobileCard, TableMobileCardRow, TableMobileCardSection } from "../ui/TableMobileCard";

const PAGE_SIZE = 12;
const DEFAULT_BENCHMARK = "spy";

function toneStyle(n: number | null): { color?: string } {
  if (n == null || n === 0) return {};
  return { color: n > 0 ? "var(--positive)" : "var(--negative)" };
}

/**
 * «Prepagos vs invertir» on the mortgage account page: every payment above the minimum cuota,
 * followed to today prepaid (at the mortgage benchmark) and invested in a selectable benchmark
 * (default SPY, remembered per page). Every figure is the server's
 * (`/api/mortgage-prepayment-comparison`); this only picks and formats.
 */
export function MortgagePrepaymentSection({
  accountId,
  displayUnit,
}: {
  accountId: number;
  displayUnit: "clp" | "usd";
}) {
  const { t } = useTranslation();
  const { benchmark, setBenchmark } = useSurfaceBenchmark(
    `account.${accountId}.prepayments`,
    DEFAULT_BENCHMARK
  );
  const benchmarks = useBenchmarks();
  const all = benchmarks.data?.benchmarks ?? [];
  const options = all.filter((o) => o.slug !== "mortgage");
  const mortgage = all.find((o) => o.slug === "mortgage");
  const selected = options.some((o) => o.slug === benchmark) ? benchmark : DEFAULT_BENCHMARK;
  const query = useMortgagePrepaymentComparison(
    accountId,
    selected,
    displayUnit,
    options.some((o) => o.slug === selected)
  );
  const raw = query.data;
  const data =
    raw != null && raw.unit === displayUnit && raw.benchmark.slug === selected ? raw : null;
  const newestFirst = data ? [...data.rows].reverse() : [];
  const { page, setPage, pageRows, total } = useClientPagination(newestFirst, PAGE_SIZE);

  if (raw === null || !mortgage) return null;

  const money = (n: number | null) =>
    n == null ? "—" : displayUnit === "usd" ? formatUsdFine(n) : formatClp(n);
  const irr = (pct: number | null) =>
    pct == null || data == null ? null : (
      <span className="muted" title={t("periodReturns.irrTitle")}>
        {" · "}
        {t(data.totals.irr_annualized ? "periodReturns.irrAnnual" : "periodReturns.irr", {
          pct: formatPct(pct * 100),
        })}
      </span>
    );
  const labels = {
    date: t("accountDetail.prepayments.colDate"),
    cuota: t("accountDetail.prepayments.colCuota"),
    extra: t("accountDetail.prepayments.colExtra"),
    prepaid: t("accountDetail.prepayments.colPrepaid"),
    invested: t("accountDetail.prepayments.colInvested"),
    delta: t("accountDetail.prepayments.colDelta"),
  };
  const totals = data?.totals;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div className="chart-panel-title-row" style={{ marginBottom: "0.35rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.15rem" }}>{t("accountDetail.prepayments.title")}</h2>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}>
          <span className="muted">{t("accountDetail.prepayments.compareWith")}</span>
          <select value={selected} onChange={(e) => setBenchmark(e.target.value)}>
            {options.map((o) => (
              <option key={o.slug} value={o.slug}>
                {benchmarkOptionLabel(t, o)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
        {t("accountDetail.prepayments.hint", { mortgage: benchmarkOptionLabel(t, mortgage) })}
      </p>
      {totals ? (
        <Table
          tableClassName="table--parallel-mobile"
          tableStyle={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("accountDetail.prepayments.totalLabel")}</th>
                <th className="desktop-only">{labels.extra}</th>
                <th className="desktop-only">{labels.prepaid}</th>
                <th className="desktop-only">{labels.invested}</th>
                <th className="desktop-only">{labels.delta}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          <tr>
            <td className="muted desktop-only">{data!.rows.length}</td>
            <td className="mono desktop-only">{money(totals.extra)}</td>
            <td className="mono desktop-only">
              {money(totals.prepaid_value)}
              {irr(totals.prepaid_irr_pct)}
            </td>
            <td className="mono desktop-only">
              {money(totals.invested_value)}
              {irr(totals.invested_irr_pct)}
            </td>
            <td className="mono desktop-only" style={{ ...toneStyle(totals.delta), fontWeight: 600 }}>
              {money(totals.delta)}
            </td>
            <td className="mobile-only">
              <TableMobileCard
                title={`${t("accountDetail.prepayments.totalLabel")} (${data!.rows.length})`}
              >
                <TableMobileCardSection>
                  <TableMobileCardRow label={labels.extra} value={money(totals.extra)} />
                  <TableMobileCardRow
                    label={labels.prepaid}
                    value={
                      <>
                        {money(totals.prepaid_value)}
                        {irr(totals.prepaid_irr_pct)}
                      </>
                    }
                  />
                  <TableMobileCardRow
                    label={labels.invested}
                    value={
                      <>
                        {money(totals.invested_value)}
                        {irr(totals.invested_irr_pct)}
                      </>
                    }
                  />
                  <TableMobileCardRow
                    label={labels.delta}
                    value={<span style={toneStyle(totals.delta)}>{money(totals.delta)}</span>}
                  />
                </TableMobileCardSection>
              </TableMobileCard>
            </td>
          </tr>
        </Table>
      ) : null}
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
        <Table
          tableClassName="table--parallel-mobile"
          tableStyle={{ fontSize: "0.85rem" }}
          header={
            <thead>
              <tr>
                <th className="desktop-only">{labels.date}</th>
                <th className="desktop-only">{labels.cuota}</th>
                <th className="desktop-only">{labels.extra}</th>
                <th className="desktop-only">{labels.prepaid}</th>
                <th className="desktop-only">{labels.invested}</th>
                <th className="desktop-only">{labels.delta}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {pageRows.map((row) => (
            <tr key={`${row.date}|${row.cuota}`} className={cn(data == null && "muted")}>
              <td className="mono desktop-only">{row.date}</td>
              <td className="desktop-only">{row.cuota}</td>
              <td className="mono desktop-only">{money(row.extra)}</td>
              <td className="mono desktop-only">{money(row.prepaid_value)}</td>
              <td className="mono desktop-only">{money(row.invested_value)}</td>
              <td className="mono desktop-only" style={toneStyle(row.delta)}>
                {money(row.delta)}
              </td>
              <td className="mobile-only">
                <TableMobileCard title={`${row.date} · ${row.cuota}`}>
                  <TableMobileCardSection>
                    <TableMobileCardRow label={labels.extra} value={money(row.extra)} />
                    <TableMobileCardRow label={labels.prepaid} value={money(row.prepaid_value)} />
                    <TableMobileCardRow label={labels.invested} value={money(row.invested_value)} />
                    <TableMobileCardRow
                      label={labels.delta}
                      value={<span style={toneStyle(row.delta)}>{money(row.delta)}</span>}
                    />
                  </TableMobileCardSection>
                </TableMobileCard>
              </td>
            </tr>
          ))}
        </Table>
      </PaginatedTable>
    </section>
  );
}
