import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useFlowsDepositsReconciliation } from "../queries/hooks";
import { PageGridTile } from "../components/layout/PageGridTile";
import { FlowMonthList, MonthRowDay } from "../components/flows/FlowMonthList";
import listStyles from "../components/flows/FlowMonthRows.module.css";
import { loadableClass } from "../components/ui/Loadable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { cn } from "../cn";
import { useTranslation, depositFlowCategoryLabel } from "../i18n";
import { formatFlowMoney } from "../flowsDisplay";
import { formatGroupedDecimal } from "../format";
import type {
  DepositManualAssertionRow,
  DepositReconciliationRow,
  DepositReconciliationSection,
  DepositReconciliationStatus,
  DepositRedemptionRow,
  DepositRedemptionStatus,
  DepositsReconciliationPayload,
} from "../types";
import type { DisplayUnit } from "../queries/keys";
import { queryLoadError } from "../queries/pageShapeReady";
import styles from "./DepositsReconciliationPage.module.css";

const DEPOSIT_SECTION_TITLE: Record<DepositReconciliationStatus, string> = {
  unlinked_checking_present: "depositsReconciliation.sectionNeedsAttention",
  unlinked_no_checking_source: "depositsReconciliation.sectionNoCheckingSource",
  resolved_internal_transfer: "depositsReconciliation.sectionResolvedInternalTransfer",
  resolved_tax_refund: "depositsReconciliation.sectionResolvedTaxRefund",
  linked: "depositsReconciliation.sectionLinked",
};

const REDEMPTION_SECTION_TITLE: Record<DepositRedemptionStatus, string> = {
  unlinked_checking_present: "depositsReconciliation.redemptionSectionNeedsAttention",
  unlinked_no_checking_source: "depositsReconciliation.redemptionSectionNoCheckingSource",
  resolved_internal_transfer: "depositsReconciliation.sectionResolvedInternalTransfer",
  linked: "depositsReconciliation.redemptionSectionLinked",
};

const emptySection = <S extends string>(status: S) => ({ status, count: 0, total: 0, months: [] });

/**
 * The frame drawn until the first payload arrives: every heading with a zero total and no rows (a
 * guess at the shape, as `coldPageShape.ts` is). The sections follow the key order of the two title
 * maps above, which must stay the server's (`DEPOSIT_SECTION_ORDER` / `REDEMPTION_SECTION_ORDER`
 * in `flowsDepositsReconciliation.ts`), or the tiles swap places when the payload lands.
 */
const PLACEHOLDER: DepositsReconciliationPayload = {
  unit: "",
  deposits: {
    count: 0,
    total: 0,
    sections: (Object.keys(DEPOSIT_SECTION_TITLE) as DepositReconciliationStatus[]).map(emptySection),
    by_month: [],
  },
  redemptions: {
    count: 0,
    total: 0,
    sections: (Object.keys(REDEMPTION_SECTION_TITLE) as DepositRedemptionStatus[]).map(emptySection),
  },
  manual_assertions: { count: 0, total: 0, linked_count: 0, months: [] },
  fx_conversion_error: false,
  fx_conversion_warnings: [],
};

/**
 * The frame drawn while another unit's payload loads: the last payload's own tiles (the statuses
 * that had rows, the manual marks and «By month» when it had them), with zero figures and no rows,
 * so only the figures blank and no tile comes or goes.
 */
function blankFrame(last: DepositsReconciliationPayload): DepositsReconciliationPayload {
  const blank = <S extends string>(sections: { status: S; count: number }[]) =>
    sections.filter((s) => s.count > 0).map((s) => emptySection(s.status));
  return {
    ...PLACEHOLDER,
    deposits: { ...PLACEHOLDER.deposits, sections: blank(last.deposits.sections) },
    redemptions: { ...PLACEHOLDER.redemptions, sections: blank(last.redemptions.sections) },
  };
}

/** An amount in the payload's unit; one with no rate on file reads «—». */
function money(v: number | null, unit: DisplayUnit): string {
  return v == null ? "—" : formatFlowMoney(v, unit);
}

/** A list's heading: its title, how many rows it holds and their total. */
function ListHeading({
  as: Heading,
  title,
  count,
  total,
  loading,
}: {
  as: "h3" | "h4";
  title: string;
  count?: number;
  total?: string;
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Heading className={styles.heading}>
      <span>{title}</span>
      {count != null ? (
        <span className={loadableClass(loading, styles.count)}>
          <span aria-hidden="true">{formatGroupedDecimal(count, 0)}</span>
          <span className="visually-hidden">
            {count === 1
              ? t("depositsReconciliation.rowCountOne")
              : t("depositsReconciliation.rowCount", { count: formatGroupedDecimal(count, 0) })}
          </span>
        </span>
      ) : null}
      {total != null ? <span className={loadableClass(loading, cn("mono", styles.total))}>{total}</span> : null}
    </Heading>
  );
}

/** A deposit or a redemption: day, account with its category as a tag, amount. */
function movementRow(r: DepositReconciliationRow | DepositRedemptionRow, unit: DisplayUnit): ReactNode {
  return (
    <>
      <MonthRowDay ymd={r.occurred_on} />
      <span className={listStyles.account}>
        <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
        <span className={listStyles.chip}>{depositFlowCategoryLabel(r.category)}</span>
      </span>
      <span className={cn("mono", listStyles.num)}>{money(r.amount, unit)}</span>
    </>
  );
}

/**
 * One side's status sections, in the server's order: each with rows is a tile (title, count,
 * total, its months); the ones with none are named together on one line once loaded.
 */
function StatusSections<S extends DepositReconciliationStatus, R extends DepositReconciliationRow | DepositRedemptionRow>({
  idPrefix,
  sections,
  titleKeys,
  rowKey,
  loading,
}: {
  idPrefix: string;
  sections: DepositReconciliationSection<S, R>[];
  titleKeys: Record<S, string>;
  rowKey: (row: R, index: number) => string | number;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  // While loading every status keeps its tile (the placeholder's): loading is not absence.
  const empty = loading ? [] : sections.filter((s) => s.count === 0);
  return (
    <>
      {sections
        .filter((s) => loading || s.count > 0)
        .map((s) => (
          <PageGridTile key={s.status} id={`${idPrefix}-${s.status}`}>
            <ListHeading
              as="h4"
              title={t(titleKeys[s.status])}
              count={s.count}
              total={money(s.total, displayUnit)}
              loading={loading}
            />
            <FlowMonthList
              months={s.months}
              loading={loading}
              monthHeading="h5"
              monthTotal={(m) => money(m.total, displayUnit)}
              rowKey={rowKey}
              renderRow={(r) => movementRow(r, displayUnit)}
            />
          </PageGridTile>
        ))}
      {empty.length > 0 ? (
        <p className={cn("muted", styles.emptyLine)}>
          {t("depositsReconciliation.emptySections", {
            list: empty.map((s) => t(`depositsReconciliation.statusShort.${s.status}`)).join(" · "),
          })}
        </p>
      ) : null}
    </>
  );
}

function manualAssertionNote(r: DepositManualAssertionRow, t: (k: string, o?: Record<string, unknown>) => string): string {
  const candidates =
    r.candidate_count === 0
      ? t("depositsReconciliation.assertedNoCandidate")
      : r.candidate_count === 1
        ? t("depositsReconciliation.assertedCandidatesOne")
        : t("depositsReconciliation.assertedCandidates", { count: r.candidate_count });
  return r.merchant ? `${r.merchant} · ${candidates}` : candidates;
}

/** The checking outflows marked as deposits that found no deposit, as the same list by month. */
function ManualAssertions({
  block,
  loading,
}: {
  block: DepositsReconciliationPayload["manual_assertions"];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  return (
    <PageGridTile id="asserted">
      <ListHeading
        as="h4"
        title={t("depositsReconciliation.assertedTitle")}
        count={block.count}
        total={money(block.total, displayUnit)}
        loading={loading}
      />
      <FlowMonthList
        months={block.months}
        loading={loading}
        monthHeading="h5"
        monthTotal={(m) => money(m.total, displayUnit)}
        rowKey={(r) => r.purchase_key}
        renderRow={(r) => (
          <>
            <MonthRowDay ymd={r.occurred_on} />
            <span className={listStyles.account}>
              <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
              <span className={listStyles.sub}>{manualAssertionNote(r, t)}</span>
            </span>
            <span className={cn("mono", listStyles.num)}>{money(r.amount, displayUnit)}</span>
          </>
        )}
      />
      {block.linked_count > 0 ? (
        <p className={cn("muted", styles.note)}>
          {block.linked_count === 1
            ? t("depositsReconciliation.assertedLinkedSummaryOne")
            : t("depositsReconciliation.assertedLinkedSummary", { count: block.linked_count })}
        </p>
      ) : null}
    </PageGridTile>
  );
}

/** «By month»: the same list, a month's rows being the statuses with deposits in it. */
function ByMonth({
  months,
  loading,
}: {
  months: DepositsReconciliationPayload["deposits"]["by_month"];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  return (
    <PageGridTile id="by-month">
      <ListHeading as="h4" title={t("depositsReconciliation.byMonth")} loading={loading} />
      <FlowMonthList
        months={months.map((m) => ({ month: m.month, total: m.total, rows: m.statuses }))}
        loading={loading}
        monthHeading="h5"
        monthTotal={(m) => money(m.total, displayUnit)}
        rowKey={(r) => r.status}
        renderRow={(r) => (
          <>
            <span className={listStyles.span2}>{t(`depositsReconciliation.statusShort.${r.status}`)}</span>
            <span className={cn("mono", listStyles.num)}>{money(r.total, displayUnit)}</span>
          </>
        )}
      />
    </PageGridTile>
  );
}

export function DepositsReconciliationPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { data, error: queryError } = useFlowsDepositsReconciliation(displayUnit);
  // The last payload drawn, kept across a unit switch (state set during render, React's pattern
  // for a value derived from a previous render).
  const [last, setLast] = useState<DepositsReconciliationPayload | null>(null);
  if (data && data !== last) setLast(data);
  const error = queryLoadError({ data, error: queryError });
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (err) {
    return <p className="error">{err}</p>;
  }

  // The frame renders with its headings, zero totals and no rows until the payload arrives: the
  // last payload's tiles when there was one (a unit switch), else the placeholder's.
  const loading = !data;
  const page = data ?? (last ? blankFrame(last) : PLACEHOLDER);
  const { manual_assertions: manual } = page;
  // What the server states once loaded; while loading, what the last payload stated (else shown).
  const shape = data ?? last;
  const showManual = shape ? shape.manual_assertions.count > 0 || shape.manual_assertions.linked_count > 0 : true;
  const showByMonth = shape ? shape.deposits.by_month.length > 0 : true;

  return (
    <>
      <h2 className="flow-section-title">{t("depositsReconciliation.title")}</h2>

      <div className={styles.side}>
        <PageGridTile id="deposits-head">
          <ListHeading
            as="h3"
            title={t("depositsReconciliation.depositsTitle")}
            total={money(page.deposits.total, displayUnit)}
            loading={loading}
          />
        </PageGridTile>
        <StatusSections
          idPrefix="reconciliation"
          sections={page.deposits.sections}
          titleKeys={DEPOSIT_SECTION_TITLE}
          rowKey={(r) => r.movement_id}
          loading={loading}
        />
        {showManual ? <ManualAssertions block={manual} loading={loading} /> : null}
        {showByMonth ? <ByMonth months={page.deposits.by_month} loading={loading} /> : null}
      </div>

      <div className={cn(styles.side, styles.sideEnd)}>
        <PageGridTile id="redemptions-head">
          <ListHeading
            as="h3"
            title={t("depositsReconciliation.redemptionsTitle")}
            total={money(page.redemptions.total, displayUnit)}
            loading={loading}
          />
        </PageGridTile>
        <StatusSections
          idPrefix="redemption"
          sections={page.redemptions.sections}
          titleKeys={REDEMPTION_SECTION_TITLE}
          rowKey={(r, idx) => `${r.account_id}-${r.occurred_on}-${idx}`}
          loading={loading}
        />
      </div>
    </>
  );
}
