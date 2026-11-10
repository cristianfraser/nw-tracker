import { useTranslation } from "react-i18next";
import { PageGridTile } from "../layout/PageGridTile";
import { ColumnTable } from "../ui/ColumnTable";
import { loadableClass } from "../ui/Loadable";
import { formatClp, formatGroupedDecimal, formatPct, formatUsd, formatUsdFine } from "../../format";
import type { UsTaxReturnResponse, UsTaxReturnRow, UsTaxReturnSchedule } from "../../types";

const dollars = (n: number | null) => (n == null ? "—" : formatUsd(n));

function useLineLabel() {
  const { t, i18n } = useTranslation();
  return (line: string) =>
    i18n.exists(`taxReturn.us.lines.${line}`) ? t(`taxReturn.us.lines.${line}`) : t("taxReturn.us.lineFallback", { line });
}

function useScheduleLineLabel() {
  const { t, i18n } = useTranslation();
  return (form: string, line: string) => {
    const key = `taxReturn.us.schedules.lines.${form}.${line}`;
    return i18n.exists(key) ? t(key) : t("taxReturn.us.lineFallback", { line });
  };
}

const lineDiff = (r: UsTaxReturnRow) => (r.changed && r.filed != null ? r.draft - r.filed : null);

function F1040Table({ rows, loading }: { rows: UsTaxReturnRow[]; loading?: boolean }) {
  const { t } = useTranslation();
  const label = useLineLabel();
  return (
    <ColumnTable
      rows={rows}
      rowKey={(r) => r.line}
      wrapClassName={loadableClass(loading)}
      cardLayout="flat"
      rowProps={(r) => ({ style: { fontWeight: r.section === "subtotal" || r.section === "result" ? 600 : undefined } })}
      columns={[
        { key: "line", header: t("taxReturn.us.table.line"), className: "mono", cell: (r) => r.printed_line, title: (r) => `${r.printed_line} · ${label(r.line)}` },
        { key: "concept", header: t("taxReturn.us.table.concept"), cell: (r) => label(r.line), desktopOnly: true },
        { key: "filed", header: t("taxReturn.us.table.filed"), headerClassName: "num", className: "num", cell: (r) => dollars(r.filed) },
        { key: "draft", header: t("taxReturn.us.table.draft"), headerClassName: "num", className: "num", cell: (r) => dollars(r.draft) },
        {
          key: "difference",
          header: t("taxReturn.us.table.difference"),
          headerClassName: "num",
          className: "num",
          cellProps: (r) => (lineDiff(r) != null ? { style: { color: "var(--negative)" } } : {}),
          cell: (r) => {
            const diff = lineDiff(r);
            return diff == null ? "" : formatUsd(diff);
          },
          card: (r) => {
            const diff = lineDiff(r);
            return diff == null ? null : formatUsd(diff);
          },
        },
      ]}
    />
  );
}

/** One schedule or worksheet: its non-zero lines (Schedule B and D always shown when the return has any). */
function ScheduleTable({ schedule }: { schedule: UsTaxReturnSchedule }) {
  const { t } = useTranslation();
  const label = useScheduleLineLabel();
  const lines = schedule.lines.filter((l) => l.amount !== 0);
  if (lines.length === 0) return null;
  const isWorksheet = schedule.form === "qdcg_worksheet";
  return (
    <>
      <h3>{t(`taxReturn.us.schedules.forms.${schedule.form}`)}</h3>
      <ColumnTable
        rows={lines}
        rowKey={(l) => l.line}
        cardLayout="flat"
        columns={[
          { key: "line", header: t("taxReturn.us.table.line"), className: "mono", cell: (l) => l.line, title: (l) => `${l.line} · ${label(schedule.form, l.line)}` },
          { key: "concept", header: t("taxReturn.us.table.concept"), cell: (l) => label(schedule.form, l.line), desktopOnly: true },
          {
            key: "amount",
            header: t("taxReturn.us.schedules.amount"),
            headerClassName: "num",
            className: "num",
            cell: (l) => (isWorksheet && !Number.isInteger(l.amount) ? formatUsdFine(l.amount) : formatUsd(l.amount)),
          },
        ]}
      />
    </>
  );
}

/** The US tab of the tax page: the 1040 draft against the filed return, its schedules, the W-2s, FICA, the settlement. */
export function UsTaxReturnSections({ data, loading }: { data: UsTaxReturnResponse | undefined; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <PageGridTile id="f1040">
        <h2>{t("taxReturn.us.title", { year: data?.tax_year ?? "" })}</h2>
        {data ? (
          <>
            <p className="muted">
              {t(`taxReturn.us.residency.${data.residency.kind}`, { from: data.residency.from ?? "", year: data.tax_year })}
            </p>
            {data.drafted ? (
              <p className="muted">
                {t("taxReturn.us.intro", { stubs: data.stubs, status: t(`taxReturn.us.filingStatus.${data.filing_status}`), year: data.tax_year })}
              </p>
            ) : (
              <p>{t(`taxReturn.us.notDrafted.${data.not_drafted_reason}`)}</p>
            )}
            {data.notes.map((n) => (
              <p key={n} className="muted">
                {t(`taxReturn.us.notes.${n}`, { year: data.tax_year, lawYear: data.law_year })}
              </p>
            ))}
            {data.drafted ? (
              <p>
                {data.filed ? t("taxReturn.us.filedOn", { date: data.filed.filed_on }) : t("taxReturn.us.notFiled")} ·{" "}
                {t("taxReturn.us.summaryFiled", { amount: dollars(data.tax_filed) })} ·{" "}
                {t("taxReturn.us.summaryDraft", { amount: dollars(data.tax_draft) })}
                {data.tax_filed != null ? ` · ${t("taxReturn.us.summaryDiff", { amount: formatUsd(data.tax_draft - data.tax_filed) })}` : ""}
                {" · "}
                {data.refund_draft > 0
                  ? t("taxReturn.us.refund", { amount: formatUsd(data.refund_draft) })
                  : data.owed_draft > 0
                    ? t("taxReturn.us.owed", { amount: formatUsd(data.owed_draft) })
                    : t("taxReturn.us.even")}
              </p>
            ) : null}
          </>
        ) : null}
        {!data || data.drafted ? <F1040Table rows={data?.rows ?? []} loading={loading} /> : null}
      </PageGridTile>
      {data ? (
        <>
          {data.drafted ? <UsSchedulesSection data={data} /> : null}
          {data.drafted ? <UsScheduleBSection data={data} /> : null}
          {data.drafted ? <UsForm8949Section data={data} /> : null}
          {data.schedule_e || data.form_8582 ? <UsScheduleESection data={data} /> : null}
          {data.form_8621.length > 0 ? <UsForm8621Section data={data} /> : null}
          {data.form_1116 ? <UsForm1116Section data={data} /> : null}
          {data.dual_status_statement ? <UsDualStatusSection data={data} /> : null}
          {data.foreign_accounts ? <UsForeignAccountsSection data={data} /> : null}
          <UsSettlementSection data={data} />
          {data.w2s.length > 0 ? (
            <PageGridTile id="w2">
              <h2>{t("taxReturn.us.w2.title")}</h2>
              <p className="muted">{t("taxReturn.us.w2.explain")}</p>
              <ColumnTable
                rows={data.w2s}
                rowKey={(w) => w.ein}
                cardLayout="flat"
                columns={[
                  { key: "employer", header: t("taxReturn.us.w2.employer"), cell: (w) => w.employer, title: (w) => `${w.employer} · ${w.ein}` },
                  { key: "stubs", header: t("taxReturn.us.w2.stubs"), headerClassName: "num", className: "num", cell: (w) => w.stubs },
                  { key: "box1", header: t("taxReturn.us.w2.box1"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box1_wages) },
                  { key: "box2", header: t("taxReturn.us.w2.box2"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box2_federal_withheld) },
                  { key: "box3", header: t("taxReturn.us.w2.box3"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box3_social_security_wages) },
                  { key: "box4", header: t("taxReturn.us.w2.box4"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box4_social_security_tax) },
                  { key: "box5", header: t("taxReturn.us.w2.box5"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box5_medicare_wages) },
                  { key: "box6", header: t("taxReturn.us.w2.box6"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box6_medicare_tax) },
                  { key: "box12d", header: t("taxReturn.us.w2.box12d"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box12_d) },
                  { key: "box12aa", header: t("taxReturn.us.w2.box12aa"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box12_aa) },
                  { key: "box12w", header: t("taxReturn.us.w2.box12w"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box12_w) },
                ]}
              />
            </PageGridTile>
          ) : null}
          {data.drafted ? (
            <PageGridTile id="fica">
              <h2>{t("taxReturn.us.fica.title")}</h2>
              <p className="muted">{t("taxReturn.us.fica.explain")}</p>
              <p>
                {t("taxReturn.us.fica.summary", {
                  socialSecurity: formatUsdFine(data.fica.social_security),
                  medicare: formatUsdFine(data.fica.medicare),
                  total: formatUsdFine(data.fica.total),
                })}
              </p>
              {data.fica.additional_medicare_tax > 0 ? (
                <p>{t("taxReturn.us.fica.additional", { amount: formatUsdFine(data.fica.additional_medicare_tax) })}</p>
              ) : null}
            </PageGridTile>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function UsSchedulesSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const shown = data.schedules.filter((s) => s.lines.some((l) => l.amount !== 0));
  if (shown.length === 0) return null;
  return (
    <PageGridTile id="f1040-schedules">
      <h2>{t("taxReturn.us.schedules.title")}</h2>
      <p className="muted">{t("taxReturn.us.schedules.explain")}</p>
      {shown.map((s) => (
        <ScheduleTable key={s.form} schedule={s} />
      ))}
    </PageGridTile>
  );
}

function UsScheduleBSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const b = data.schedule_b;
  if (!b || (b.interest.length === 0 && b.dividends.length === 0)) return null;
  const table = (rows: typeof b.interest) => (
    <ColumnTable
      rows={rows}
      rowKey={(r) => r.payer}
      cardLayout="flat"
      columns={[
        { key: "payer", header: t("taxReturn.us.scheduleB.payer"), cell: (r) => r.payer, title: (r) => r.payer },
        { key: "items", header: t("taxReturn.us.scheduleB.items"), headerClassName: "num", className: "num", cell: (r) => r.items },
        { key: "usd", header: t("taxReturn.us.schedules.amount"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.usd) },
      ]}
    />
  );
  return (
    <PageGridTile id="f1040-schedule-b">
      <h2>{t("taxReturn.us.scheduleB.title")}</h2>
      {b.interest.length > 0 ? (
        <>
          <h3>{t("taxReturn.us.scheduleB.interest")}</h3>
          {table(b.interest)}
        </>
      ) : null}
      {b.dividends.length > 0 ? (
        <>
          <h3>{t("taxReturn.us.scheduleB.dividends", { qualified: formatUsd(b.qualified_dividends) })}</h3>
          {table(b.dividends)}
        </>
      ) : null}
    </PageGridTile>
  );
}

function UsForm8949Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const c = data.capital_loss_carryover;
  const carried = c != null && (c.in.short_term || c.in.long_term || c.out.short_term || c.out.long_term);
  if (data.form_8949.length === 0 && !carried) return null;
  return (
    <PageGridTile id="f1040-8949">
      <h2>{t("taxReturn.us.form8949.title")}</h2>
      {carried && c ? (
        <p className="muted">
          {t("taxReturn.us.form8949.carryover", {
            inShort: formatUsd(c.in.short_term),
            inLong: formatUsd(c.in.long_term),
            outShort: formatUsd(c.out.short_term),
            outLong: formatUsd(c.out.long_term),
          })}
        </p>
      ) : null}
      {data.form_8949.length > 0 ? (
        <ColumnTable
          rows={data.form_8949}
          rowKey={(r) => `${r.box}|${r.description}|${r.sold}|${r.acquired}`}
          cardLayout="flat"
          columns={[
            { key: "description", header: t("taxReturn.us.form8949.description"), cell: (r) => r.description, title: (r) => `${r.description} · ${r.sold}` },
            { key: "box", header: t("taxReturn.us.form8949.box"), className: "mono", cell: (r) => `${r.box} · ${t(`taxReturn.us.form8949.term.${r.term}`)}` },
            { key: "acquired", header: t("taxReturn.us.form8949.acquired"), className: "mono", cell: (r) => r.acquired },
            { key: "sold", header: t("taxReturn.us.form8949.sold"), className: "mono", cell: (r) => r.sold },
            { key: "proceeds", header: t("taxReturn.us.form8949.proceeds"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.proceeds) },
            { key: "cost", header: t("taxReturn.us.form8949.cost"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.cost) },
            { key: "gain", header: t("taxReturn.us.form8949.gain"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.gain) },
          ]}
        />
      ) : null}
    </PageGridTile>
  );
}

function UsDualStatusSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.dual_status_statement!;
  return (
    <PageGridTile id="f1040-dual-status">
      <h2>{t("taxReturn.us.dualStatus.title", { from: s.from })}</h2>
      <p className="muted">{t("taxReturn.us.dualStatus.explain", { tax: formatUsd(s.tax), withheld: formatUsd(s.withheld) })}</p>
      {s.rows.length > 0 ? (
        <ColumnTable
          rows={s.rows}
          rowKey={(r) => `${r.date}|${r.instrument}`}
          cardLayout="flat"
          columns={[
            { key: "date", header: t("taxReturn.us.dualStatus.date"), className: "mono", cell: (r) => r.date, title: (r) => `${r.date} · ${r.instrument}` },
            { key: "instrument", header: t("taxReturn.us.dualStatus.instrument"), cell: (r) => r.instrument, desktopOnly: true },
            { key: "gross", header: t("taxReturn.us.dualStatus.gross"), headerClassName: "num", className: "num", cell: (r) => formatUsdFine(r.gross_usd) },
            { key: "rate", header: t("taxReturn.us.dualStatus.rate"), headerClassName: "num", className: "num", cell: (r) => formatPct(r.rate_pct, 0) },
            { key: "tax", header: t("taxReturn.us.dualStatus.tax"), headerClassName: "num", className: "num", cell: (r) => formatUsdFine(r.tax_usd) },
            { key: "withheld", header: t("taxReturn.us.dualStatus.withheld"), headerClassName: "num", className: "num", cell: (r) => formatUsdFine(r.withheld_usd) },
          ]}
        />
      ) : null}
    </PageGridTile>
  );
}

function UsForeignAccountsSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const fa = data.foreign_accounts!;
  if (fa.accounts.length === 0) return null;
  const flag = (b: boolean) => t(b ? "taxReturn.us.foreignAccounts.required" : "taxReturn.us.foreignAccounts.notRequired");
  return (
    <PageGridTile id="f1040-foreign-accounts">
      <h2>{t("taxReturn.us.foreignAccounts.title")}</h2>
      <p>
        {t("taxReturn.us.foreignAccounts.summary", {
          yearEnd: formatUsd(fa.year_end_usd),
          peak: formatUsd(fa.peak_month_end_usd),
          fbar: flag(fa.fbar_required),
          f8938: flag(fa.form8938_required),
        })}
      </p>
      <ColumnTable
        rows={fa.accounts}
        rowKey={(a) => a.name}
        cardLayout="flat"
        columns={[
          { key: "account", header: t("taxReturn.us.foreignAccounts.account"), cell: (a) => a.name, title: (a) => a.name },
          { key: "yearEnd", header: t("taxReturn.us.foreignAccounts.yearEnd"), headerClassName: "num", className: "num", cell: (a) => formatUsd(a.year_end_usd) },
          { key: "peak", header: t("taxReturn.us.foreignAccounts.peak"), headerClassName: "num", className: "num", cell: (a) => formatUsd(a.peak_month_end_usd) },
        ]}
      />
    </PageGridTile>
  );
}

function UsSettlementSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.settlement;
  if (!s || !s.expected) return null;
  return (
    <PageGridTile id="f1040-settlement">
      <h2>{t("taxReturn.us.settlement.title")}</h2>
      <p>
        {t(`taxReturn.us.settlement.expected.${s.expected.kind}`, { amount: formatUsd(s.expected.amount) })}
        {s.links.length === 0 ? (
          <span style={{ color: "var(--negative)" }}> · {t("taxReturn.us.settlement.notLinked")}</span>
        ) : (
          <>
            {" · "}
            {t(`taxReturn.us.settlement.settled.${s.expected.kind}`, { amount: formatUsdFine(s.settled) })}
            {s.difference != null && s.difference !== 0
              ? ` · ${t("taxReturn.us.settlement.difference", { amount: formatUsdFine(s.difference) })}`
              : ""}
          </>
        )}
      </p>
      {s.links.length > 0 ? (
        <ColumnTable
          rows={s.links}
          rowKey={(l) => l.movement_id}
          cardLayout="flat"
          columns={[
            { key: "date", header: t("taxReturn.settlement.colDate"), className: "mono", cell: (l) => l.occurred_on, title: (l) => `${l.occurred_on} · ${l.account_name}` },
            { key: "account", header: t("taxReturn.settlement.colAccount"), cell: (l) => l.account_name, desktopOnly: true },
            { key: "description", header: t("taxReturn.settlement.colDescription"), cell: (l) => l.description },
            { key: "amount", header: t("taxReturn.settlement.colAmount"), headerClassName: "num", className: "num", cell: (l) => formatUsdFine(l.amount) },
          ]}
        />
      ) : null}
    </PageGridTile>
  );
}

function UsScheduleESection({ data }: { data: UsTaxReturnResponse }) {
  const { t, i18n } = useTranslation();
  const e = data.schedule_e;
  const f = data.form_8582;
  const label = (line: string) => (i18n.exists(`taxReturn.us.scheduleE.lines.${line}`) ? t(`taxReturn.us.scheduleE.lines.${line}`) : t("taxReturn.us.lineFallback", { line }));
  return (
    <PageGridTile id="f1040-schedule-e">
      <h2>{t("taxReturn.us.scheduleE.title")}</h2>
      {e ? <p className="muted">{t("taxReturn.us.scheduleE.explain", { net: formatUsd(e.net_usd) })}</p> : null}
      {e?.places.map((p) => (
        <div key={p.label}>
          <h3>{p.label}</h3>
          <ColumnTable
            rows={p.lines.filter((l) => l.amount !== 0 || l.line === "21")}
            rowKey={(l) => l.line}
            cardLayout="flat"
            rowProps={(l) => ({ style: { fontWeight: l.line === "20" || l.line === "21" ? 600 : undefined } })}
            columns={[
              { key: "line", header: t("taxReturn.us.table.line"), className: "mono", cell: (l) => l.line, title: (l) => `${l.line} · ${label(l.line)}` },
              { key: "concept", header: t("taxReturn.us.table.concept"), cell: (l) => label(l.line), desktopOnly: true },
              { key: "amount", header: t("taxReturn.us.schedules.amount"), headerClassName: "num", className: "num", cell: (l) => formatUsd(l.amount) },
            ]}
          />
          <p className="muted">
            {t("taxReturn.us.scheduleE.depreciation", {
              basis: formatUsd(p.depreciation.basis_usd),
              origin: t(`taxReturn.us.scheduleE.origin.${p.depreciation.basis_origin}`),
              building: formatUsd(p.depreciation.building_basis_usd),
              start: p.depreciation.start_date,
              reading: t(`taxReturn.us.scheduleE.reading.${p.depreciation.reading}`),
              months: p.depreciation.months_in_window,
              amount: formatUsd(p.depreciation.amount_usd),
            })}
          </p>
        </div>
      ))}
      {f ? (
        <>
          <h3>{t("taxReturn.us.form8582.title")}</h3>
          <p>
            {t("taxReturn.us.form8582.summary", {
              magi: formatUsd(f.magi_usd),
              allowance: formatUsd(f.allowance_usd),
              before: formatUsd(f.allowance_before_phase_out_usd),
              limited: formatUsd(f.limited_loss_usd),
              prior: formatUsd(f.prior_suspended_loss_usd),
              absorbed: formatUsd(f.prior_loss_absorbed_usd),
              allowed: formatUsd(f.allowed_loss_usd),
              suspended: formatUsd(f.suspended_loss_usd),
              included: formatUsd(f.included_in_income_usd),
            })}
          </p>
        </>
      ) : null}
    </PageGridTile>
  );
}

function UsForm8621Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const rows = data.form_8621;
  return (
    <PageGridTile id="f1040-8621">
      <h2>{t("taxReturn.us.form8621.title")}</h2>
      <p className="muted">{t("taxReturn.us.form8621.explain")}</p>
      <ColumnTable
        rows={rows}
        rowKey={(r) => r.label}
        cardLayout="flat"
        columns={[
          { key: "holding", header: t("taxReturn.us.form8621.holding"), cell: (r) => r.label, title: (r) => r.label },
          { key: "start", header: t("taxReturn.us.form8621.start"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.start_basis_usd) },
          { key: "beforeMark", header: t("taxReturn.us.form8621.beforeMark"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.basis_before_mark_usd) },
          { key: "fmv", header: t("taxReturn.us.form8621.fmv"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.fmv_year_end_usd) },
          { key: "inclusion", header: t("taxReturn.us.form8621.inclusion"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.inclusion_usd) },
          { key: "deduction", header: t("taxReturn.us.form8621.deduction"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.deduction_usd) },
          { key: "ordinary", header: t("taxReturn.us.form8621.ordinary"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.ordinary_income_usd) },
          { key: "endBasis", header: t("taxReturn.us.form8621.endBasis"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.end_basis_usd) },
          { key: "unreversed", header: t("taxReturn.us.form8621.unreversed"), headerClassName: "num", className: "num", cell: (r) => formatUsd(r.unreversed_inclusions_usd) },
        ]}
      />
      {rows
        .filter((r) => r.disposals.length > 0)
        .map((r) => (
          <p key={`sales-${r.label}`} className="muted">
            {t("taxReturn.us.form8621.sales", {
              label: r.label,
              count: r.disposals.length,
              ordinary: formatUsd(r.disposals.reduce((a, d) => a + d.ordinary_gain_usd - d.ordinary_loss_usd, 0)),
              capital: formatUsd(r.capital_loss_usd),
            })}
          </p>
        ))}
      {rows
        .filter((r) => r.part_v_possible)
        .map((r) => (
          <p key={`partv-${r.label}`} style={{ color: "var(--negative)" }}>
            {t("taxReturn.us.form8621.partV", { label: r.label })}
          </p>
        ))}
    </PageGridTile>
  );
}

function UsForm1116Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.form_1116!;
  const carried = (list: { tax_year: number; amount_usd: number }[]) =>
    list.length === 0 ? formatUsd(0) : list.map((c) => t("taxReturn.us.form1116.carryover", { year: c.tax_year, amount: formatUsd(c.amount_usd) })).join(", ");
  return (
    <PageGridTile id="f1040-1116">
      <h2>{t("taxReturn.us.form1116.title")}</h2>
      <p className="muted">
        {f.chile
          ? t("taxReturn.us.form1116.chile", {
              taxYear: f.chile.tax_year,
              source: t(`taxReturn.us.form1116.source.${f.chile.adicional_source}`),
              adicional: formatClp(f.chile.adicional_clp),
              unico: formatClp(f.chile.unico_art107_clp),
              rate: formatGroupedDecimal(f.rate_clp_per_usd, 2),
            })
          : t("taxReturn.us.form1116.noChile")}
      </p>
      {f.taxes.length > 0 ? (
        <ul>
          {f.taxes.map((x) => (
            <li key={x.item}>
              {t(`taxReturn.us.form1116.item.${x.item}`)}: {formatUsd(x.amount_usd)} ·{" "}
              {t(x.creditable ? "taxReturn.us.form1116.creditable" : "taxReturn.us.form1116.notCreditable")}
              {x.unverified ? ` · ${t("taxReturn.us.form1116.unverified")}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        {t("taxReturn.us.form1116.limit", {
          gross: formatUsd(f.foreign_passive_gross_usd),
          deductions: formatUsd(f.foreign_passive_deductions_usd),
          net: formatUsd(f.foreign_passive_taxable_income_usd),
          taxable: formatUsd(f.taxable_income_usd),
          tax: formatUsd(f.us_tax_before_credits_usd),
          limit: formatUsd(f.limit_usd),
          fraction: formatPct(f.limit_fraction * 100, 2),
          accrued: formatUsd(f.taxes_accrued_usd),
          carriedIn: carried(f.carryovers_in),
          credit: formatUsd(f.credit_usd),
          carriedOut: carried(f.carryovers_out),
        })}
      </p>
    </PageGridTile>
  );
}
