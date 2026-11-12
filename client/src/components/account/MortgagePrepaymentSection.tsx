import { BenchmarkSelectOptions, benchmarkOptionLabel } from "../../benchmarkLabels";
import { cn } from "../../cn";
import { currencyFormatInfo, formatCurrency, formatCurrencyFine, formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { useBenchmarks, useMortgagePrepaymentComparison } from "../../queries/hooks";
import { useSurfaceBenchmark } from "../../surfaceDisplayPrefs";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { loadableClass } from "../ui/Loadable";
import { PageGridTile } from "../layout/PageGridTile";
import { ColumnTable } from "../ui/ColumnTable";
import type { DisplayUnit } from "../../queries/keys";

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
  displayUnit: DisplayUnit;
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
  // Benchmarks or the comparison still in flight: the section frames itself (title, selector,
  // table header) dimmed. Absence stays hidden: the server's null comparison or no mortgage benchmark.
  const loading = benchmarks.isPending || query.isLoading;

  if (raw === null || (!mortgage && !loading)) return null;

  // A currency with minor units shows them (dollars and euros with cents); pesos whole.
  const money = (n: number | null) =>
    n == null
      ? "—"
      : currencyFormatInfo(displayUnit).minorDigits > 0
        ? formatCurrencyFine(n, displayUnit)
        : formatCurrency(n, displayUnit);
  const irr = (pct: number | null) =>
    pct == null || data == null ? null : (
      <span className="muted" title={t("periodReturns.irrTitle")}>
        {" · "}
        {t(data.totals.irr_annualized ? "periodReturns.irrAnnual" : "periodReturns.irr", {
          pct: formatPct(pct * 100),
        })}
      </span>
    );
  // Δ with its percentage of the prepaid value beside it, both in the Δ's tone.
  const delta = (amount: number | null, pct: number | null) =>
    amount == null ? (
      "—"
    ) : (
      <span style={toneStyle(amount)}>
        {money(amount)}
        {pct == null ? null : ` · ${formatPct(pct * 100)}`}
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
    <PageGridTile id="mortgage-prepayments" className={loadableClass(loading)} aria-busy={loading || undefined}>
      <div className="chart-panel-title-row">
        <h2>{t("accountDetail.prepayments.title")}</h2>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "var(--font-size-prose)" }}>
          <span className="muted">{t("accountDetail.prepayments.compareWith")}</span>
          <select value={selected} onChange={(e) => setBenchmark(e.target.value)}>
            <BenchmarkSelectOptions t={t} options={options} />
          </select>
        </label>
      </div>
      {mortgage ? (
        <p className="muted" style={{ fontSize: "var(--font-size-prose)", marginTop: 0 }}>
          {t("accountDetail.prepayments.hint", { mortgage: benchmarkOptionLabel(t, mortgage) })}
        </p>
      ) : null}
      {totals && data && totals.covered_payments < data.rows.length && totals.covered_from ? (
        <p className="muted" style={{ fontSize: "var(--font-size-prose)", marginTop: 0 }}>
          {t("accountDetail.prepayments.coveredFrom", {
            date: totals.covered_from,
            covered: totals.covered_payments,
            total: data.rows.length,
          })}
        </p>
      ) : null}
      {totals ? (
        <ColumnTable
          rows={[totals]}
          rowKey={() => "totals"}
          tableStyle={{ fontSize: "var(--font-size-prose)", marginBottom: "0.75rem" }}
          columns={[
            {
              key: "total",
              header: t("accountDetail.prepayments.totalLabel"),
              className: "muted",
              cell: (x) => x.covered_payments,
              title: (x) => `${t("accountDetail.prepayments.totalLabel")} (${x.covered_payments})`,
            },
            { key: "extra", header: labels.extra, className: "mono", cell: (x) => money(x.extra) },
            {
              key: "prepaid",
              header: labels.prepaid,
              className: "mono",
              cell: (x) => (
                <>
                  {money(x.prepaid_value)}
                  {irr(x.prepaid_irr_pct)}
                </>
              ),
            },
            {
              key: "invested",
              header: labels.invested,
              className: "mono",
              cell: (x) => (
                <>
                  {money(x.invested_value)}
                  {irr(x.invested_irr_pct)}
                </>
              ),
            },
            {
              key: "delta",
              header: labels.delta,
              className: "mono",
              cellProps: () => ({ style: { fontWeight: 600 } }),
              cell: (x) => delta(x.delta, x.delta_pct),
            },
          ]}
        />
      ) : null}
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
        <ColumnTable
          rows={pageRows}
          rowKey={(row) => `${row.date}|${row.cuota}`}
          rowProps={() => ({ className: cn(data == null && "muted") })}
          tableStyle={{ fontSize: "var(--font-size-prose)" }}
          columns={[
            {
              key: "date",
              header: labels.date,
              className: "mono",
              cell: (row) => row.date,
              title: (row) => `${row.date} · ${row.cuota}`,
            },
            { key: "cuota", header: labels.cuota, cell: (row) => row.cuota, desktopOnly: true },
            { key: "extra", header: labels.extra, className: "mono", cell: (row) => money(row.extra) },
            { key: "prepaid", header: labels.prepaid, className: "mono", cell: (row) => money(row.prepaid_value) },
            { key: "invested", header: labels.invested, className: "mono", cell: (row) => money(row.invested_value) },
            { key: "delta", header: labels.delta, className: "mono", cell: (row) => delta(row.delta, row.delta_pct) },
          ]}
        />
      </PaginatedTable>
    </PageGridTile>
  );
}
