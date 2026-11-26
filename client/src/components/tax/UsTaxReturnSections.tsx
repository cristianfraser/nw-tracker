import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { PageGridTile } from "../layout/PageGridTile";
import { loadableClass } from "../ui/Loadable";
import { formatGroupedDecimal, formatPct } from "../../format";
import { formatChileTaxPesos, formatForm1040Cents, formatForm1040Dollars } from "../../formatNative";
import type { UsTaxReturnResponse, UsTaxReturnSchedule } from "../../types";
import { TaxCodeList, type TaxCodeRow } from "./TaxCodeList";
import { TaxFacts, TaxFigures, type TaxFigure } from "./TaxHeader";
import { TaxDetailList, TaxPairs, TaxSection } from "./TaxSection";
import { countLabel } from "./taxCount";
import styles from "./TaxRows.module.css";

const dollars = (n: number | null) => (n == null ? "—" : formatForm1040Dollars(n));

type UsSettlement = NonNullable<UsTaxReturnResponse["settlement"]>;

/** Whether the filed return's refund or payment is matched by bank movements. */
function settlementStatus(t: TFunction, s: UsSettlement, expected: NonNullable<UsSettlement["expected"]>): ReactNode {
  if (s.links.length === 0) return <span className={styles.bad}>{t("taxReturn.us.settlement.notLinked")}</span>;
  return (
    <>
      {t(`taxReturn.us.settlement.settled.${expected.kind}`, { amount: formatForm1040Cents(s.settled) })}
      {s.difference != null && s.difference !== 0 ? ` · ${t("taxReturn.us.settlement.difference", { amount: formatForm1040Cents(s.difference) })}` : ""}
    </>
  );
}

/** The four result figures: total tax filed, drafted, their difference, and the draft's refund or amount owed. */
function f1040Figures(t: TFunction, data: UsTaxReturnResponse | undefined): TaxFigure[] {
  const drafted = data?.drafted ?? false;
  const diff = data?.tax_difference ?? null;
  const s = data?.settlement;
  return [
    {
      key: "filed",
      label: t("taxReturn.us.figures.filed"),
      value: dollars(data?.tax_filed ?? null),
      sub: data == null ? null : data.filed ? t("taxReturn.us.filedOn", { date: data.filed.filed_on }) : t("taxReturn.us.notFiled"),
    },
    {
      key: "draft",
      label: t("taxReturn.figures.draft"),
      value: drafted && data ? formatForm1040Dollars(data.tax_draft) : "—",
      sub: data == null ? null : drafted ? t(data.provisional ? "taxReturn.us.figures.draftOpen" : "taxReturn.us.figures.draftSub") : t("taxReturn.us.figures.notDrafted"),
    },
    {
      key: "difference",
      label: t("taxReturn.figures.difference"),
      value: dollars(diff),
      tone: diff == null || diff === 0 ? "quiet" : "bad",
      sub:
        data == null || data.tax_filed == null
          ? null
          : data.changed_lines === 0
            ? t("taxReturn.us.figures.linesAgree")
            : countLabel(t, "taxReturn.us.figures.linesDiffer", "taxReturn.us.figures.linesDifferOne", data.changed_lines),
    },
    {
      key: "balance",
      label: t(
        !drafted || data == null
          ? "taxReturn.us.figures.balance"
          : data.refund_draft > 0
            ? "taxReturn.us.figures.refund"
            : data.owed_draft > 0
              ? "taxReturn.us.figures.owed"
              : "taxReturn.us.figures.balance"
      ),
      value: !drafted || data == null ? "—" : formatForm1040Dollars(data.refund_draft > 0 ? data.refund_draft : data.owed_draft),
      // The settlement is the filed return's: said under the draft's balance only when both are a refund, or both a payment.
      sub:
        data == null || !drafted
          ? null
          : data.refund_draft === 0 && data.owed_draft === 0
            ? t("taxReturn.us.even")
            : s?.expected && (s.expected.kind === "refund") === data.refund_draft > 0
              ? settlementStatus(t, s, s.expected)
              : null,
    },
  ];
}

/** One schedule or worksheet: its non-zero lines. */
function ScheduleLines({ schedule }: { schedule: UsTaxReturnSchedule }) {
  const { t, i18n } = useTranslation();
  const label = (line: string) => {
    const key = `taxReturn.us.schedules.lines.${schedule.form}.${line}`;
    return i18n.exists(key) ? t(key) : t("taxReturn.us.lineFallback", { line });
  };
  const lines = schedule.lines.filter((l) => l.amount !== 0);
  if (lines.length === 0) return null;
  const isWorksheet = schedule.form === "qdcg_worksheet";
  return (
    <>
      <h3>{t(`taxReturn.us.schedules.forms.${schedule.form}`)}</h3>
      <TaxDetailList
        rows={lines}
        rowKey={(l) => l.line}
        lead={{ header: t("taxReturn.us.table.line"), cell: (l) => l.line }}
        name={{ header: t("taxReturn.us.table.concept"), cell: (l) => label(l.line) }}
        columns={[]}
        headline={{
          key: "amount",
          header: t("taxReturn.us.schedules.amount"),
          cell: (l) => (isWorksheet && !Number.isInteger(l.amount) ? formatForm1040Cents(l.amount) : formatForm1040Dollars(l.amount)),
        }}
      />
    </>
  );
}

function UsNotesSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  if (!data.drafted && data.notes.length === 0) return null;
  return (
    <TaxSection id="f1040-notes" title={t("taxReturn.us.sections.notes")} summary={countLabel(t, "taxReturn.count.notes", "taxReturn.count.notesOne", data.notes.length)}>
      {data.drafted ? (
        <p className="muted">
          {t("taxReturn.us.intro", { stubs: data.stubs, status: t(`taxReturn.us.filingStatus.${data.filing_status}`), year: data.tax_year })}
        </p>
      ) : null}
      {data.notes.length > 0 ? (
        <ul className="muted">
          {data.notes.map((n) => (
            <li key={n}>{t(`taxReturn.us.notes.${n}`, { year: data.tax_year, lawYear: data.law_year })}</li>
          ))}
        </ul>
      ) : null}
    </TaxSection>
  );
}

function UsSchedulesSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const shown = data.schedules.filter((s) => s.lines.some((l) => l.amount !== 0));
  if (shown.length === 0) return null;
  return (
    <TaxSection id="f1040-schedules" title={t("taxReturn.us.schedules.title")} summary={countLabel(t, "taxReturn.count.forms", "taxReturn.count.formsOne", shown.length)}>
      <p className="muted">{t("taxReturn.us.schedules.explain")}</p>
      {shown.map((s) => (
        <ScheduleLines key={s.form} schedule={s} />
      ))}
    </TaxSection>
  );
}

function UsScheduleBSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const b = data.schedule_b;
  if (!b || (b.interest.length === 0 && b.dividends.length === 0)) return null;
  const list = (rows: typeof b.interest) => (
    <TaxDetailList
      rows={rows}
      rowKey={(r) => r.payer}
      name={{ header: t("taxReturn.us.scheduleB.payer"), cell: (r) => r.payer }}
      columns={[{ key: "items", header: t("taxReturn.us.scheduleB.items"), cell: (r) => r.items }]}
      headline={{ key: "usd", header: t("taxReturn.us.schedules.amount"), cell: (r) => formatForm1040Dollars(r.usd) }}
    />
  );
  return (
    <TaxSection id="f1040-schedule-b" title={t("taxReturn.us.scheduleB.title")} summary={countLabel(t, "taxReturn.count.lines", "taxReturn.count.linesOne", b.lines)}>
      {b.interest.length > 0 ? (
        <>
          <h3>{t("taxReturn.us.scheduleB.interest")}</h3>
          {list(b.interest)}
        </>
      ) : null}
      {b.dividends.length > 0 ? (
        <>
          <h3>{t("taxReturn.us.scheduleB.dividends", { qualified: formatForm1040Dollars(b.qualified_dividends) })}</h3>
          {list(b.dividends)}
        </>
      ) : null}
    </TaxSection>
  );
}

function UsForm8949Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const c = data.capital_loss_carryover;
  const carried = c != null && (c.in.short_term || c.in.long_term || c.out.short_term || c.out.long_term);
  if (data.form_8949.length === 0 && !carried) return null;
  return (
    <TaxSection id="f1040-8949" title={t("taxReturn.us.form8949.title")} summary={data.form_8949.length > 0 ? countLabel(t, "taxReturn.count.sales", "taxReturn.count.salesOne", data.form_8949.length) : null}>
      {carried && c ? (
        <p className="muted">
          {t("taxReturn.us.form8949.carryover", {
            inShort: formatForm1040Dollars(c.in.short_term),
            inLong: formatForm1040Dollars(c.in.long_term),
            outShort: formatForm1040Dollars(c.out.short_term),
            outLong: formatForm1040Dollars(c.out.long_term),
          })}
        </p>
      ) : null}
      {data.form_8949.length > 0 ? (
        <TaxDetailList
          rows={data.form_8949}
          rowKey={(r, i) => `${r.box}|${r.description}|${r.sold}|${r.acquired}|${i}`}
          lead={{ header: t("taxReturn.us.form8949.sold"), cell: (r) => r.sold }}
          name={{ header: t("taxReturn.us.form8949.description"), cell: (r) => r.description }}
          columns={[
            { key: "box", header: t("taxReturn.us.form8949.box"), text: true, cell: (r) => `${r.box} · ${t(`taxReturn.us.form8949.term.${r.term}`)}` },
            { key: "acquired", header: t("taxReturn.us.form8949.acquired"), text: true, cell: (r) => <span className="mono">{r.acquired}</span> },
            { key: "proceeds", header: t("taxReturn.us.form8949.proceeds"), cell: (r) => formatForm1040Dollars(r.proceeds) },
            { key: "cost", header: t("taxReturn.us.form8949.cost"), cell: (r) => formatForm1040Dollars(r.cost) },
          ]}
          headline={{ key: "gain", header: t("taxReturn.us.form8949.gain"), cell: (r) => formatForm1040Dollars(r.gain) }}
        />
      ) : null}
    </TaxSection>
  );
}

function UsDualStatusSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.dual_status_statement!;
  return (
    <TaxSection
      id="f1040-dual-status"
      title={t("taxReturn.us.dualStatus.title", { from: s.from })}
      summary={
        <>
          {t("taxReturn.us.dualStatus.tax")} <b>{formatForm1040Dollars(s.tax)}</b>
        </>
      }
    >
      <p className="muted">{t("taxReturn.us.dualStatus.explain", { tax: formatForm1040Dollars(s.tax), withheld: formatForm1040Dollars(s.withheld) })}</p>
      {s.rows.length > 0 ? (
        <TaxDetailList
          rows={s.rows}
          rowKey={(r, i) => `${r.date}|${r.instrument}|${i}`}
          lead={{ header: t("taxReturn.us.dualStatus.date"), cell: (r) => r.date }}
          name={{ header: t("taxReturn.us.dualStatus.instrument"), cell: (r) => r.instrument }}
          columns={[
            { key: "gross", header: t("taxReturn.us.dualStatus.gross"), cell: (r) => formatForm1040Cents(r.gross_usd) },
            { key: "rate", header: t("taxReturn.us.dualStatus.rate"), cell: (r) => formatPct(r.rate_pct, 0) },
            { key: "withheld", header: t("taxReturn.us.dualStatus.withheld"), cell: (r) => formatForm1040Cents(r.withheld_usd) },
          ]}
          headline={{ key: "tax", header: t("taxReturn.us.dualStatus.tax"), cell: (r) => formatForm1040Cents(r.tax_usd) }}
        />
      ) : null}
    </TaxSection>
  );
}

function UsForeignAccountsSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const fa = data.foreign_accounts!;
  if (fa.accounts.length === 0) return null;
  const flag = (b: boolean) => t(b ? "taxReturn.us.foreignAccounts.required" : "taxReturn.us.foreignAccounts.notRequired");
  return (
    <TaxSection
      id="f1040-foreign-accounts"
      title={t("taxReturn.us.foreignAccounts.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.accounts", "taxReturn.count.accountsOne", fa.accounts.length)} · <b>{formatForm1040Dollars(fa.year_end_usd)}</b>
        </>
      }
    >
      <p>
        {t("taxReturn.us.foreignAccounts.summary", {
          yearEnd: formatForm1040Dollars(fa.year_end_usd),
          peak: formatForm1040Dollars(fa.peak_month_end_usd),
          fbar: flag(fa.fbar_required),
          f8938: flag(fa.form8938_required),
        })}
      </p>
      <TaxDetailList
        rows={fa.accounts}
        rowKey={(a, i) => `${a.name}|${i}`}
        name={{ header: t("taxReturn.us.foreignAccounts.account"), cell: (a) => a.name }}
        columns={[{ key: "peak", header: t("taxReturn.us.foreignAccounts.peak"), cell: (a) => formatForm1040Dollars(a.peak_month_end_usd) }]}
        headline={{ key: "yearEnd", header: t("taxReturn.us.foreignAccounts.yearEnd"), cell: (a) => formatForm1040Dollars(a.year_end_usd) }}
      />
    </TaxSection>
  );
}

function UsSettlementSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.settlement;
  if (!s || !s.expected) return null;
  return (
    <TaxSection id="f1040-settlement" title={t("taxReturn.us.settlement.title")} summary={settlementStatus(t, s, s.expected)}>
      <p>{t(`taxReturn.us.settlement.expected.${s.expected.kind}`, { amount: formatForm1040Dollars(s.expected.amount) })}</p>
      {s.links.length > 0 ? (
        <TaxDetailList
          rows={s.links}
          rowKey={(l) => l.movement_id}
          lead={{ header: t("taxReturn.settlement.colDate"), cell: (l) => l.occurred_on }}
          name={{ header: t("taxReturn.settlement.colDescription"), cell: (l) => l.description }}
          columns={[{ key: "account", header: t("taxReturn.settlement.colAccount"), text: true, wrap: true, cell: (l) => l.account_name }]}
          headline={{ key: "amount", header: t("taxReturn.settlement.colAmount"), cell: (l) => formatForm1040Cents(l.amount) }}
        />
      ) : null}
    </TaxSection>
  );
}

function UsScheduleESection({ data }: { data: UsTaxReturnResponse }) {
  const { t, i18n } = useTranslation();
  const e = data.schedule_e;
  const f = data.form_8582;
  const label = (line: string) => (i18n.exists(`taxReturn.us.scheduleE.lines.${line}`) ? t(`taxReturn.us.scheduleE.lines.${line}`) : t("taxReturn.us.lineFallback", { line }));
  return (
    <TaxSection
      id="f1040-schedule-e"
      title={t("taxReturn.us.scheduleE.title")}
      summary={
        e ? (
          <>
            {countLabel(t, "taxReturn.count.places", "taxReturn.count.placesOne", e.places.length)} · <b>{formatForm1040Dollars(e.net_usd)}</b>
          </>
        ) : null
      }
    >
      {e ? <p className="muted">{t("taxReturn.us.scheduleE.explain", { net: formatForm1040Dollars(e.net_usd) })}</p> : null}
      {e?.places.map((p) => (
        <div key={p.label}>
          <h3>{p.label}</h3>
          <TaxDetailList
            rows={p.lines.filter((l) => l.amount !== 0 || l.line === "21")}
            rowKey={(l) => l.line}
            rowClassName={(l) => (l.line === "20" || l.line === "21" ? styles.strong : undefined)}
            lead={{ header: t("taxReturn.us.table.line"), cell: (l) => l.line }}
            name={{ header: t("taxReturn.us.table.concept"), cell: (l) => label(l.line) }}
            columns={[]}
            headline={{ key: "amount", header: t("taxReturn.us.schedules.amount"), cell: (l) => formatForm1040Dollars(l.amount) }}
          />
          <p className={`muted ${styles.listNote}`}>
            {t("taxReturn.us.scheduleE.depreciation", {
              basis: formatForm1040Dollars(p.depreciation.basis_usd),
              origin: t(`taxReturn.us.scheduleE.origin.${p.depreciation.basis_origin}`),
              building: formatForm1040Dollars(p.depreciation.building_basis_usd),
              start: p.depreciation.start_date,
              reading: t(`taxReturn.us.scheduleE.reading.${p.depreciation.reading}`),
              months: p.depreciation.months_in_window,
              amount: formatForm1040Dollars(p.depreciation.amount_usd),
            })}
          </p>
        </div>
      ))}
      {f ? (
        <>
          <h3>{t("taxReturn.us.form8582.title")}</h3>
          <p>
            {t("taxReturn.us.form8582.summary", {
              magi: formatForm1040Dollars(f.magi_usd),
              allowance: formatForm1040Dollars(f.allowance_usd),
              before: formatForm1040Dollars(f.allowance_before_phase_out_usd),
              limited: formatForm1040Dollars(f.limited_loss_usd),
              prior: formatForm1040Dollars(f.prior_suspended_loss_usd),
              absorbed: formatForm1040Dollars(f.prior_loss_absorbed_usd),
              allowed: formatForm1040Dollars(f.allowed_loss_usd),
              suspended: formatForm1040Dollars(f.suspended_loss_usd),
              included: formatForm1040Dollars(f.included_in_income_usd),
            })}
          </p>
        </>
      ) : null}
    </TaxSection>
  );
}

function UsForm8621Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const rows = data.form_8621;
  const partV = rows.some((r) => r.part_v_possible);
  return (
    <TaxSection
      id="f1040-8621"
      title={t("taxReturn.us.form8621.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.holdings", "taxReturn.count.holdingsOne", rows.length)}
          {partV ? <span className={styles.bad}> · {t("taxReturn.us.form8621.partVShort")}</span> : null}
        </>
      }
    >
      <p className="muted">{t("taxReturn.us.form8621.explain")}</p>
      <TaxDetailList
        rows={rows}
        rowKey={(r) => r.label}
        name={{ header: t("taxReturn.us.form8621.holding"), cell: (r) => r.label }}
        columns={[
          { key: "start", header: t("taxReturn.us.form8621.start"), cell: (r) => formatForm1040Dollars(r.start_basis_usd) },
          { key: "beforeMark", header: t("taxReturn.us.form8621.beforeMark"), cell: (r) => formatForm1040Dollars(r.basis_before_mark_usd) },
          { key: "fmv", header: t("taxReturn.us.form8621.fmv"), cell: (r) => formatForm1040Dollars(r.fmv_year_end_usd) },
          { key: "inclusion", header: t("taxReturn.us.form8621.inclusion"), cell: (r) => formatForm1040Dollars(r.inclusion_usd) },
          { key: "deduction", header: t("taxReturn.us.form8621.deduction"), cell: (r) => formatForm1040Dollars(r.deduction_usd) },
          { key: "endBasis", header: t("taxReturn.us.form8621.endBasis"), cell: (r) => formatForm1040Dollars(r.end_basis_usd) },
          { key: "unreversed", header: t("taxReturn.us.form8621.unreversed"), cell: (r) => formatForm1040Dollars(r.unreversed_inclusions_usd) },
        ]}
        headline={{ key: "ordinary", header: t("taxReturn.us.form8621.ordinary"), cell: (r) => formatForm1040Dollars(r.ordinary_income_usd) }}
      />
      {rows
        .filter((r) => r.disposals.length > 0)
        .map((r) => (
          <p key={`sales-${r.label}`} className="muted">
            {t("taxReturn.us.form8621.sales", {
              label: r.label,
              count: r.disposals.length,
              ordinary: formatForm1040Dollars(r.disposals.reduce((a, d) => a + d.ordinary_gain_usd - d.ordinary_loss_usd, 0)),
              capital: formatForm1040Dollars(r.capital_loss_usd),
            })}
          </p>
        ))}
      {rows
        .filter((r) => r.part_v_possible)
        .map((r) => (
          <p key={`partv-${r.label}`} className={styles.bad}>
            {t("taxReturn.us.form8621.partV", { label: r.label })}
          </p>
        ))}
    </TaxSection>
  );
}

function UsForm1116Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.form_1116!;
  const carried = (list: { tax_year: number; amount_usd: number }[]) =>
    list.length === 0 ? formatForm1040Dollars(0) : list.map((c) => t("taxReturn.us.form1116.carryover", { year: c.tax_year, amount: formatForm1040Dollars(c.amount_usd) })).join(", ");
  return (
    <TaxSection
      id="f1040-1116"
      title={t("taxReturn.us.form1116.title")}
      summary={
        <>
          {t("taxReturn.us.form1116.summaryCredit")} <b>{formatForm1040Dollars(f.credit_usd)}</b>
        </>
      }
    >
      <p className="muted">
        {f.chile
          ? t("taxReturn.us.form1116.chile", {
              taxYear: f.chile.tax_year,
              source: t(`taxReturn.us.form1116.source.${f.chile.adicional_source}`),
              adicional: formatChileTaxPesos(f.chile.adicional_clp),
              unico: formatChileTaxPesos(f.chile.unico_art107_clp),
              rate: formatGroupedDecimal(f.rate_clp_per_usd, 2),
            })
          : t("taxReturn.us.form1116.noChile")}
      </p>
      {f.taxes.length > 0 ? (
        <ul>
          {f.taxes.map((x) => (
            <li key={x.item}>
              {t(`taxReturn.us.form1116.item.${x.item}`)}: {formatForm1040Dollars(x.amount_usd)} ·{" "}
              {t(x.creditable ? "taxReturn.us.form1116.creditable" : "taxReturn.us.form1116.notCreditable")}
              {x.unverified ? ` · ${t("taxReturn.us.form1116.unverified")}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        {t("taxReturn.us.form1116.limit", {
          gross: formatForm1040Dollars(f.foreign_passive_gross_usd),
          deductions: formatForm1040Dollars(f.foreign_passive_deductions_usd),
          net: formatForm1040Dollars(f.foreign_passive_taxable_income_usd),
          taxable: formatForm1040Dollars(f.taxable_income_usd),
          tax: formatForm1040Dollars(f.us_tax_before_credits_usd),
          limit: formatForm1040Dollars(f.limit_usd),
          fraction: formatPct(f.limit_fraction * 100, 2),
          accrued: formatForm1040Dollars(f.taxes_accrued_usd),
          carriedIn: carried(f.carryovers_in),
          credit: formatForm1040Dollars(f.credit_usd),
          carriedOut: carried(f.carryovers_out),
        })}
      </p>
    </TaxSection>
  );
}

/** The W-2s rebuilt from the pay stubs, each employer's boxes as label / amount pairs. */
function UsW2Section({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  if (data.w2s.length === 0) return null;
  const box = (key: string, n: number) => ({ key, label: t(`taxReturn.us.w2.${key}`), value: formatForm1040Cents(n) });
  return (
    <TaxSection id="w2" title={t("taxReturn.us.w2.title")} summary={countLabel(t, "taxReturn.count.employers", "taxReturn.count.employersOne", data.w2s.length)}>
      <p className="muted">{t("taxReturn.us.w2.explain")}</p>
      {data.w2s.map((w) => (
        <TaxPairs
          key={w.ein}
          head={`${w.employer} · ${w.ein} · ${countLabel(t, "taxReturn.count.payStubs", "taxReturn.count.payStubsOne", w.stubs)}`}
          pairs={[
            box("box1", w.box1_wages),
            box("box2", w.box2_federal_withheld),
            box("box3", w.box3_social_security_wages),
            box("box4", w.box4_social_security_tax),
            box("box5", w.box5_medicare_wages),
            box("box6", w.box6_medicare_tax),
            box("box12d", w.box12_d),
            box("box12aa", w.box12_aa),
            box("box12w", w.box12_w),
          ]}
        />
      ))}
    </TaxSection>
  );
}

function UsFicaSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  return (
    <TaxSection id="fica" title={t("taxReturn.us.fica.title")} summary={<b>{formatForm1040Cents(data.fica.total)}</b>}>
      <p className="muted">{t("taxReturn.us.fica.explain")}</p>
      <p>
        {t("taxReturn.us.fica.summary", {
          socialSecurity: formatForm1040Cents(data.fica.social_security),
          medicare: formatForm1040Cents(data.fica.medicare),
          total: formatForm1040Cents(data.fica.total),
        })}
      </p>
      {data.fica.additional_medicare_tax > 0 ? <p>{t("taxReturn.us.fica.additional", { amount: formatForm1040Cents(data.fica.additional_medicare_tax) })}</p> : null}
    </TaxSection>
  );
}

/**
 * The US return of a tax year: the result as figures, the 1040's lines drafted against the filed
 * return, and its schedules, forms, W-2s, FICA and settlement as folded sections. `controls` is the
 * page's year and return switch, drawn at the top of the first tile; `failed` leaves only them.
 */
export function UsTaxReturnSections({
  data,
  loading,
  failed,
  controls,
}: {
  data: UsTaxReturnResponse | undefined;
  loading: boolean;
  failed?: boolean;
  controls: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  if (failed) return <PageGridTile id="tax-result">{controls}</PageGridTile>;
  const lineLabel = (line: string) => (i18n.exists(`taxReturn.us.lines.${line}`) ? t(`taxReturn.us.lines.${line}`) : t("taxReturn.us.lineFallback", { line }));
  const rows: TaxCodeRow[] = (data?.rows ?? []).map((r) => ({
    key: r.line,
    code: r.printed_line,
    concept: lineLabel(r.line),
    group: r.group,
    filed: r.filed,
    informed: null,
    draft: r.draft,
    difference: r.difference,
    changed: r.changed,
    informedDiffers: false,
    flagged: r.changed,
    sourcesAgree: !r.changed,
    estimated: false,
    strong: r.section === "subtotal" || r.section === "result",
    faint: false,
  }));
  return (
    <>
      <PageGridTile id="tax-result" className={loadableClass(loading)}>
        {controls}
        <TaxFigures figures={f1040Figures(t, data)} />
        {data ? (
          <TaxFacts
            facts={[
              { key: "residency", value: t(`taxReturn.us.residency.${data.residency.kind}`, { from: data.residency.from ?? "", year: data.tax_year }) },
              ...(data.drafted
                ? [
                    { key: "status", label: t("taxReturn.us.facts.filingStatus"), value: t(`taxReturn.us.filingStatus.${data.filing_status}`) },
                    { key: "stubs", value: countLabel(t, "taxReturn.count.payStubs", "taxReturn.count.payStubsOne", data.stubs) },
                  ]
                : []),
            ]}
          />
        ) : null}
        {data && !data.drafted ? <p className={styles.notice}>{t(`taxReturn.us.notDrafted.${data.not_drafted_reason}`)}</p> : null}
      </PageGridTile>
      {!data || data.drafted ? (
        <PageGridTile id="f1040">
          <TaxCodeList
            key={data?.tax_year ?? "pending"}
            title={t("taxReturn.us.title", { year: data?.tax_year ?? "" })}
            rows={rows}
            flaggedCount={data?.changed_lines ?? 0}
            withInformed={false}
            money={formatForm1040Dollars}
            groupLabel={(g) => t(`taxReturn.us.groups.${g}`)}
            labels={{
              code: t("taxReturn.us.table.line"),
              concept: t("taxReturn.us.table.concept"),
              filed: t("taxReturn.us.table.filed"),
              informed: "",
              draft: t("taxReturn.us.table.draft"),
              difference: t("taxReturn.us.table.difference"),
              estimated: "",
            }}
            loading={loading}
          />
        </PageGridTile>
      ) : null}
      {data ? (
        <PageGridTile id="f1040-sections" key={data.tax_year} className={loadableClass(loading)}>
          <UsNotesSection data={data} />
          <UsSettlementSection data={data} />
          {data.drafted ? <UsSchedulesSection data={data} /> : null}
          {data.drafted ? <UsScheduleBSection data={data} /> : null}
          {data.drafted ? <UsForm8949Section data={data} /> : null}
          {data.schedule_e || data.form_8582 ? <UsScheduleESection data={data} /> : null}
          {data.form_8621.length > 0 ? <UsForm8621Section data={data} /> : null}
          {data.form_1116 ? <UsForm1116Section data={data} /> : null}
          {data.dual_status_statement ? <UsDualStatusSection data={data} /> : null}
          {data.foreign_accounts ? <UsForeignAccountsSection data={data} /> : null}
          <UsW2Section data={data} />
          {data.drafted ? <UsFicaSection data={data} /> : null}
        </PageGridTile>
      ) : null}
    </>
  );
}
