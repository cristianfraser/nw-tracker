import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { PageGridTile } from "../layout/PageGridTile";
import { Pill } from "../ui/Pill";
import { formatCurrencyFine, formatGroupedDecimal, formatPct } from "../../format";
import { formatF22Pesos, formatTaxDocumentDollars } from "../../formatNative";
import type { TaxReturnResponse } from "../../types";
import { TaxCodeList, type TaxCodeRow } from "./TaxCodeList";
import { TaxFacts, TaxFigures, type TaxFigure } from "./TaxHeader";
import { TaxDetailList, TaxSection } from "./TaxSection";
import { countLabel } from "./taxCount";
import styles from "./TaxRows.module.css";

const money = (n: number | null) => (n == null ? "—" : formatF22Pesos(n));

type Settlement = NonNullable<TaxReturnResponse["settlement"]>;
type SettlementLink = Settlement["links"][number];

function settlementLinkLabel(t: TFunction, l: SettlementLink): string {
  if (l.kind === "offset_kept" || l.kind === "offset_paid") {
    return t(`taxReturn.settlement.link.${l.kind}`, { year: l.other_tax_year });
  }
  return t(`taxReturn.settlement.link.${l.kind}${l.movement_id == null ? "Card" : ""}`);
}

/** Whether the filed form's refund or payment is matched by bank movements: «paid $X», or the missing link in red. */
function settlementStatus(t: TFunction, s: Settlement, expected: NonNullable<Settlement["expected"]>): ReactNode {
  if (s.links.length === 0) return <span className={styles.bad}>{t("taxReturn.settlement.notLinked")}</span>;
  return (
    <>
      {t(`taxReturn.settlement.settled.${expected.kind}`, { amount: formatF22Pesos(s.settled) })}
      {s.difference != null && s.difference !== 0
        ? ` · ${t(`taxReturn.settlement.difference.${expected.kind}`, { amount: formatF22Pesos(s.difference) })}`
        : ""}
    </>
  );
}

/** The four result figures: tax filed, draft, their difference, and how the filed form was settled. */
function f22Figures(t: TFunction, data: TaxReturnResponse | undefined): TaxFigure[] {
  const adicional = data != null && data.regime !== "resident";
  const s = data?.settlement;
  const diff = data?.tax_difference ?? null;
  return [
    {
      key: "filed",
      label: t("taxReturn.figures.filed"),
      value: money(data?.tax_filed ?? null),
      sub: data == null ? null : data.tax_filed == null ? t("taxReturn.figures.notFiled") : t(adicional ? "taxReturn.figures.codesAdicional" : "taxReturn.figures.codeIgc"),
    },
    {
      key: "draft",
      label: t("taxReturn.figures.draft"),
      value: money(data?.tax_draft ?? null),
      sub: data == null ? null : data.tax_draft == null ? t("taxReturn.figures.draftNone") : t(data.provisional ? "taxReturn.figures.draftOpen" : "taxReturn.figures.draftSub"),
    },
    {
      key: "difference",
      label: t("taxReturn.figures.difference"),
      value: money(diff),
      tone: diff == null || diff === 0 ? "quiet" : "bad",
      sub:
        data == null || data.tax_filed == null
          ? null
          : data.changed_codes === 0
            ? t("taxReturn.figures.codesAgree")
            : countLabel(t, "taxReturn.figures.codesDiffer", "taxReturn.figures.codesDifferOne", data.changed_codes),
    },
    s?.expected
      ? {
          key: "settlement",
          label: t(`taxReturn.figures.${s.expected.kind}`),
          value: formatF22Pesos(s.expected.amount),
          sub: settlementStatus(t, s, s.expected),
        }
      : { key: "settlement", label: t("taxReturn.figures.settlement"), value: "—", sub: data == null ? null : t("taxReturn.figures.nothingToSettle") },
  ];
}

function f22Facts(t: TFunction, data: TaxReturnResponse) {
  const r = data.residency;
  const facts: { key: string; label?: string; value: ReactNode }[] = [
    { key: "base", label: t("taxReturn.facts.baseLabel"), value: t(`taxReturn.facts.base.${data.base}`, { months: data.salary.months }) },
    {
      key: "regime",
      label: t("taxReturn.facts.regimeLabel"),
      value:
        r.regime === "split"
          ? t("taxReturn.facts.regime.split", { through: typeof r.cl === "object" ? r.cl.through : "", from: typeof r.us === "object" ? r.us.from : "" })
          : t(`taxReturn.facts.regime.${r.regime}`),
    },
    { key: "residency", label: t("taxReturn.facts.residencyLabel"), value: t(r.declared ? "taxReturn.facts.declared" : "taxReturn.facts.undeclared") },
  ];
  if (data.provisional) facts.push({ key: "provisional", value: t("taxReturn.facts.provisional", { year: data.income_year }) });
  return facts;
}

/**
 * A year's offset balance: the code-169 pool (F22 line 17: crypto, fund and interest losses
 * against those gains and foreign income) or the foreign share sales, whose loss offsets only
 * other foreign share gains. Said when a loss is left over, or, in the open year, when a gain
 * could still be offset by realizing a loss; null otherwise.
 */
function lossOffsetHint(t: TFunction, data: TaxReturnResponse, kind: "pool" | "foreign"): ReactNode {
  const o = kind === "pool" ? data.loss_offset : data.foreign_share_offset;
  const k = (key: string) => `taxReturn.lossOffset.${kind === "foreign" ? `foreign${key[0].toUpperCase()}${key.slice(1)}` : key}`;
  const year = data.income_year;
  const tax = o.tax_effect_clp != null && o.tax_effect_clp > 0 ? formatF22Pesos(o.tax_effect_clp) : null;
  let text: string | null = null;
  if (o.unused_loss_clp > 0) {
    const amount = formatF22Pesos(o.unused_loss_clp);
    text = data.provisional
      ? `${t(k("unusedOpen"), { year, amount })}${tax ? ` ${t("taxReturn.lossOffset.unusedOpenTax", { tax })}` : ""}`
      : t(k("unusedClosed"), { year, amount });
  } else if (data.provisional && o.taxed_gain_clp > 0) {
    const amount = formatF22Pesos(o.taxed_gain_clp);
    const effect = tax
      ? ` ${t("taxReturn.lossOffset.taxedOpenTax", { tax })}`
      : o.tax_effect_clp === 0
        ? ` ${t("taxReturn.lossOffset.taxedOpenNoTax")}`
        : "";
    text = `${t(k("taxedOpen"), { year, amount })}${effect}`;
  }
  if (text == null) return null;
  const parts =
    kind === "pool"
      ? data.loss_offset.parts
          .filter((p) => p.gain_clp !== 0 || p.loss_clp !== 0)
          .map((p) => `${t(`taxReturn.lossOffset.source.${p.source}`)} ${formatF22Pesos(p.gain_clp - p.loss_clp)}`)
          .join(" · ")
      : "";
  return (
    <p key={kind} className={o.unused_loss_clp > 0 ? styles.bad : undefined}>
      {text}
      {parts ? <span className="muted"> {t("taxReturn.lossOffset.breakdown", { parts })}</span> : null}
    </p>
  );
}

/** What is left of the year's losses and gains after they offset each other, when there is something to say. */
function LossOffsetSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const hints = [lossOffsetHint(t, data, "pool"), lossOffsetHint(t, data, "foreign")].filter((h) => h != null);
  if (hints.length === 0) return null;
  const unused = data.loss_offset.unused_loss_clp > 0 || data.foreign_share_offset.unused_loss_clp > 0;
  return (
    <TaxSection
      id="loss-offset"
      title={t("taxReturn.lossOffset.title")}
      summary={
        unused ? (
          <span className={styles.bad}>{t("taxReturn.lossOffset.summaryUnused")}</span>
        ) : (
          t("taxReturn.lossOffset.summaryTaxed")
        )
      }
    >
      {hints}
    </TaxSection>
  );
}

/** The declared residency the draft was built on, its assumption, the non-resident part, and what the draft starts from. */
function BasisSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const r = data.residency;
  const period = r.periods.map((p) => `${t(`panelSettings.taxResidency.jurisdictions.${p.jurisdiction}`)} ${p.from} → ${p.to ?? t("panelSettings.taxResidency.open")}`).join("; ");
  const nr = data.nonresident;
  return (
    <TaxSection id="basis" title={t("taxReturn.sections.basis")} summary={t(`taxReturn.facts.base.${data.base}`, { months: data.salary.months })}>
      <p className="muted">{t("taxReturn.subtitle")}</p>
      <p className="muted">{t(`taxReturn.base.${data.base}`, { months: data.salary.months })}</p>
      {data.provisional ? <p className="muted">{t("taxReturn.provisionalYear", { year: data.income_year })}</p> : null}
      {!r.declared ? (
        <p className="muted">{t("taxReturn.residency.undeclared")}</p>
      ) : (
        <>
          <p className="muted">
            {r.regime === "resident"
              ? t("taxReturn.residency.regime.resident", { period })
              : r.regime === "nonresident"
                ? t("taxReturn.residency.regime.nonresident", { year: data.income_year, from: typeof r.us === "object" ? r.us.from : r.periods.find((p) => p.jurisdiction === "us")?.from ?? "", period })
                : t("taxReturn.residency.regime.split", {
                    through: typeof r.cl === "object" ? r.cl.through : "",
                    from: typeof r.us === "object" ? r.us.from : "",
                  })}
          </p>
          <p className="muted">{t("taxReturn.residency.assumption")}</p>
          {r.regime === "split" ? (
            <>
              <p className="muted">{t("taxReturn.residency.art103")}</p>
              <p className="muted">{t("taxReturn.residency.yearlyDj")}</p>
            </>
          ) : null}
          {nr ? (
            <p>
              {t("taxReturn.residency.nonresidentPart", {
                from: nr.window.from,
                through: nr.window.through,
                rent: formatF22Pesos(nr.taxable_rent_clp),
                exempt: formatF22Pesos(nr.exempt_rent_clp),
                base: formatF22Pesos(nr.codes["32"] ?? 0),
                tax: formatF22Pesos(nr.codes["34"] ?? 0),
              })}
              {nr.art107.sales > 0
                ? ` ${t("taxReturn.residency.nonresidentArt107", { sales: nr.art107.sales, result: formatF22Pesos(nr.art107.result_clp), tax: formatF22Pesos(nr.art107.tax_clp) })}`
                : ""}
            </p>
          ) : null}
        </>
      )}
    </TaxSection>
  );
}

/** What the non-resident part does not declare, each item with its amount and reason. */
function ExcludedSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  if (data.excluded.length === 0) return null;
  return (
    <TaxSection id="excluded" title={t("taxReturn.residency.excludedTitle")} summary={countLabel(t, "taxReturn.count.items", "taxReturn.count.itemsOne", data.excluded.length)}>
      <p className="muted">{t("taxReturn.residency.excludedExplain")}</p>
      <TaxDetailList
        rows={data.excluded}
        rowKey={(x) => `${x.kind}-${x.window.from}`}
        name={{ header: t("taxReturn.residency.excludedKind"), cell: (x) => t(`taxReturn.residency.kind.${x.kind}`) }}
        columns={[{ key: "reason", header: t("taxReturn.residency.excludedReason"), text: true, wrap: true, cell: (x) => t(`taxReturn.residency.reason.${x.reason}`) }]}
        headline={{ key: "amount", header: t("taxReturn.settlement.colAmount"), cell: (x) => formatF22Pesos(x.clp) }}
      />
    </TaxSection>
  );
}

function SettlementSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.settlement;
  if (!s || !s.expected) return null;
  return (
    <TaxSection id="settlement" title={t("taxReturn.settlement.title")} summary={settlementStatus(t, s, s.expected)}>
      <p>{t(`taxReturn.settlement.expected.${s.expected.kind}`, { amount: formatF22Pesos(s.expected.amount) })}</p>
      {s.links.length > 0 ? (
        <TaxDetailList
          rows={s.links}
          rowKey={(l) => `${l.kind}-${l.account_id}-${l.occurred_on}-${l.amount}`}
          lead={{ header: t("taxReturn.settlement.colDate"), cell: (l) => l.occurred_on }}
          name={{ header: t("taxReturn.settlement.colDescription"), cell: (l) => settlementLinkLabel(t, l) }}
          columns={[{ key: "account", header: t("taxReturn.settlement.colAccount"), text: true, wrap: true, cell: (l) => l.account_name ?? "—" }]}
          headline={{ key: "amount", header: t("taxReturn.settlement.colAmount"), cell: (l) => formatF22Pesos(l.amount) }}
        />
      ) : null}
    </TaxSection>
  );
}

function PayrollWithholdingSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const w = data.payroll_withholding;
  if (w.payslips === 0) return null;
  const anyDiffers = w.months.some((m) => m.differs);
  return (
    <TaxSection
      id="payroll-withholding"
      title={t("taxReturn.payroll.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.payslips", "taxReturn.count.payslipsOne", w.months.length)} ·{" "}
          <span className={anyDiffers ? styles.bad : undefined}>
            {t("taxReturn.payroll.summaryDifference", { difference: formatF22Pesos(w.difference) })}
          </span>
        </>
      }
    >
      <p className="muted">{t("taxReturn.payroll.explain")}</p>
      <p>
        {t("taxReturn.payroll.summary", {
          withheld: formatF22Pesos(w.withheld),
          byTable: formatF22Pesos(w.by_table),
          difference: formatF22Pesos(w.difference),
        })}
      </p>
      <TaxDetailList
        rows={w.months}
        rowKey={(m) => m.payslip_id}
        name={{
          header: t("taxReturn.payroll.colMonth"),
          cell: (m) => (
            <span className="mono">
              {m.period_month}
              {m.origin === "rebuilt" ? ` (${t("taxReturn.payroll.rebuilt")})` : ""}
            </span>
          ),
        }}
        columns={[
          { key: "withheld", header: t("taxReturn.payroll.colWithheld"), cell: (m) => formatF22Pesos(m.withheld) },
          { key: "byTable", header: t("taxReturn.payroll.colTable"), cell: (m) => formatF22Pesos(m.by_table) },
        ]}
        headline={{
          key: "difference",
          header: t("taxReturn.payroll.colDifference"),
          cell: (m) => (m.differs ? <span className={styles.bad}>{formatF22Pesos(m.difference)}</span> : "—"),
        }}
      />
    </TaxSection>
  );
}

function CryptoSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const c = data.crypto;
  if (c.sales.length === 0) return null;
  return (
    <TaxSection
      id="crypto"
      title={t("taxReturn.crypto.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.sales", "taxReturn.count.salesOne", c.sales.length)} · <b>{formatF22Pesos(c.gain_december_clp)}</b>
        </>
      }
    >
      {c.provisional ? <p className="muted">{t("taxReturn.crypto.provisional", { month: c.reajuste_to_month.slice(0, 7) })}</p> : null}
      <p className="muted">
        {t("taxReturn.crypto.explain", {
          method: t(`taxReturn.crypto.method.${c.method}`),
          fees: t(`taxReturn.crypto.fees.${c.fee_policy}`),
        })}
      </p>
      <TaxDetailList
        rows={c.sales}
        rowKey={(s, i) => `${s.date}-${s.coin}-${s.units}-${i}`}
        lead={{ header: t("taxReturn.crypto.date"), cell: (s) => s.date }}
        name={{ header: t("taxReturn.crypto.coin"), cell: (s) => s.coin }}
        columns={[
          { key: "units", header: t("taxReturn.crypto.units"), cell: (s) => formatGroupedDecimal(s.units, 8) },
          { key: "proceeds", header: t("taxReturn.crypto.proceeds"), cell: (s) => formatF22Pesos(s.proceeds_clp) },
          { key: "cost", header: t("taxReturn.crypto.cost"), cell: (s) => formatF22Pesos(s.cost_clp) },
          { key: "costReajustado", header: t("taxReturn.crypto.costReajustado"), cell: (s) => formatF22Pesos(s.cost_reajustado_clp) },
          { key: "gain", header: t("taxReturn.crypto.gain"), cell: (s) => formatF22Pesos(s.gain_clp) },
          { key: "decemberPct", header: t("taxReturn.crypto.decemberPct"), cell: (s) => formatPct(s.december_pct, 1) },
        ]}
        headline={{ key: "gainDecember", header: t("taxReturn.crypto.gainDecember"), cell: (s) => formatF22Pesos(s.gain_december_clp) }}
      />
      <p>
        {t("taxReturn.crypto.totals", {
          sales: formatF22Pesos(c.sales_clp),
          gain: formatF22Pesos(c.gain_december_clp),
        })}
        {c.informed_sales_clp != null ? ` ${t("taxReturn.crypto.informed", { amount: formatF22Pesos(c.informed_sales_clp) })}` : ""}
      </p>
    </TaxSection>
  );
}

function DividendsSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  if (data.dividends.length === 0) return null;
  const missing = data.dividends.filter((d) => d.gross_usd == null).length;
  const usdOrMissing = (n: number | null) => (n == null ? t("taxReturn.dividends.missingDetail") : formatTaxDocumentDollars(n));
  return (
    <TaxSection
      id="dividends"
      title={t("taxReturn.dividends.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.lines", "taxReturn.count.linesOne", data.dividends.length)} · <b>{formatF22Pesos(data.dividends_gross_clp)}</b>
          {missing > 0 ? <span className={styles.bad}> · {t("taxReturn.dividends.pendingCount", { count: missing })}</span> : null}
        </>
      }
    >
      <p className="muted">
        {t(data.provisional ? "taxReturn.dividends.explainProvisional" : "taxReturn.dividends.explain", {
          rate: `$${formatGroupedDecimal(data.year_end_observado, 2)}`,
          year: data.income_year,
        })}
      </p>
      {missing > 0 ? <p className={styles.bad}>{t("taxReturn.dividends.missingNote", { count: missing })}</p> : null}
      <TaxDetailList
        rows={data.dividends}
        rowKey={(d, i) => `${d.date}-${i}`}
        name={{ header: t("taxReturn.dividends.date"), cell: (d) => <span className="mono">{d.date}</span> }}
        columns={[
          { key: "grossUsd", header: t("taxReturn.dividends.grossUsd"), cell: (d) => usdOrMissing(d.gross_usd) },
          { key: "withholdingUsd", header: t("taxReturn.dividends.withholdingUsd"), cell: (d) => usdOrMissing(d.withholding_usd) },
          { key: "withholdingClp", header: t("taxReturn.dividends.withholdingClp"), cell: (d) => money(d.withholding_clp) },
        ]}
        headline={{ key: "grossClp", header: t("taxReturn.dividends.grossClp"), cell: (d) => money(d.gross_clp) }}
      />
    </TaxSection>
  );
}

function ForeignSharesSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.foreign_shares;
  if (f.sales.length === 0) return null;
  const other = f.default_mode === "usd_31dic" ? "clp_ipc" : "usd_31dic";
  return (
    <TaxSection
      id="foreign-shares"
      title={t("taxReturn.foreign.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.sales", "taxReturn.count.salesOne", f.sales.length)} · <b>{formatF22Pesos(f.total_clp[f.default_mode])}</b>
        </>
      }
    >
      <p className="muted">
        {t("taxReturn.foreign.explain", { mode: t(`taxReturn.foreign.mode.${f.default_mode}`) })}
        {f.provisional ? ` ${t("taxReturn.foreign.provisional")}` : ""}
      </p>
      <TaxDetailList
        rows={f.sales}
        rowKey={(s, i) => `${s.date}-${s.account_name}-${i}`}
        lead={{ header: t("taxReturn.foreign.date"), cell: (s) => s.date }}
        name={{ header: t("taxReturn.foreign.instrument"), cell: (s) => s.account_name }}
        columns={[
          { key: "gainUsd", header: t("taxReturn.foreign.gainUsd"), cell: (s) => formatTaxDocumentDollars(s.gain_usd) },
          { key: "other", header: t(`taxReturn.foreign.mode.${other}`), cell: (s) => formatF22Pesos(s.result_clp[other]) },
        ]}
        headline={{ key: "default", header: t(`taxReturn.foreign.mode.${f.default_mode}`), cell: (s) => formatF22Pesos(s.result_clp[f.default_mode]) }}
      />
    </TaxSection>
  );
}

/**
 * The year's rents by place (server: f22/rentals.ts): a non-DFL-2 place's rent is línea 5 letra a)
 * (code 1849 → 955), its contribuciones the línea-39 credit (1637) up to the IGC on the rent; a
 * DFL-2 place's rent is shown and enters no code (DFL N° 2 art. 15).
 */
function RentalsSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const r = data.rentals;
  if (r.places.length === 0) return null;
  const credit = r.property_tax_credit;
  return (
    <TaxSection
      id="rentals"
      title={t("taxReturn.rentals.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.places", "taxReturn.count.placesOne", r.places.length)} · {t("taxReturn.rentals.summaryTaxable")} <b>{formatF22Pesos(r.taxable_rent_clp)}</b>
        </>
      }
    >
      <p className="muted">
        {t("taxReturn.rentals.explain")}
        {r.provisional ? ` ${t("taxReturn.rentals.provisional")}` : ""}
      </p>
      <TaxDetailList
        rows={r.places}
        rowKey={(p) => p.slug}
        name={{ header: t("taxReturn.rentals.place"), cell: (p) => p.label }}
        columns={[
          { key: "treatment", header: t("taxReturn.rentals.treatment"), text: true, cell: (p) => t(p.dfl2 ? "taxReturn.rentals.exempt" : "taxReturn.rentals.taxable") },
          { key: "credits", header: t("taxReturn.rentals.credits"), cell: (p) => String(p.credits) },
          { key: "propertyTax", header: t("taxReturn.rentals.propertyTax"), cell: (p) => formatF22Pesos(p.property_tax_paid_clp) },
        ]}
        headline={{ key: "rent", header: t("taxReturn.rentals.rent"), cell: (p) => formatF22Pesos(p.rent_clp) }}
      />
      <p>{t("taxReturn.rentals.totals", { taxable: formatF22Pesos(r.taxable_rent_clp), exempt: formatF22Pesos(r.exempt_rent_clp) })}</p>
      {credit ? (
        <p className="muted">
          {t("taxReturn.rentals.credit", {
            paid: formatF22Pesos(credit.paid_clp),
            cap: formatF22Pesos(credit.cap_clp),
            credit: formatF22Pesos(credit.credit_clp),
          })}
        </p>
      ) : null}
    </TaxSection>
  );
}

/**
 * Foreign-source income (server: f22/foreignIncome.ts): the US salary in code 1030 with its credit
 * for the US tax (748 / 1018, art. 41 A and the Chile–US treaty), and a foreign broker's interest in
 * 1104. The figures are the server's; the page only formats them.
 */
function ForeignIncomeSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const { salary, interest } = data.foreign_income;
  if (salary.stubs === 0 && interest.lines.length === 0) return null;
  return (
    <TaxSection
      id="foreign-income"
      title={t("taxReturn.foreignIncome.title")}
      summary={
        salary.stubs > 0 ? (
          <>
            {countLabel(t, "taxReturn.count.payStubs", "taxReturn.count.payStubsOne", salary.stubs)} · <b>{formatF22Pesos(salary.gross_clp)}</b>
          </>
        ) : (
          <>
            {countLabel(t, "taxReturn.count.lines", "taxReturn.count.linesOne", interest.lines.length)} · <b>{formatF22Pesos(interest.clp)}</b>
          </>
        )
      }
    >
      <p className="muted">
        {t("taxReturn.foreignIncome.explain")}
        {salary.provisional ? ` ${t("taxReturn.foreignIncome.provisional")}` : ""}
      </p>
      {salary.stubs > 0 ? (
        <p>
          {t("taxReturn.foreignIncome.salary", {
            stubs: salary.stubs,
            usd: formatTaxDocumentDollars(salary.income_usd),
            gross: formatF22Pesos(salary.gross_clp),
            taxUsd: formatTaxDocumentDollars(salary.us_tax_usd),
            source: salary.us_tax_source ? t(`taxReturn.foreignIncome.taxSource.${salary.us_tax_source}`) : "—",
            tax: formatF22Pesos(salary.us_tax_clp),
            net: formatF22Pesos(salary.net_clp),
          })}
        </p>
      ) : null}
      {salary.credit_cap_clp != null && salary.credit_applied_clp != null ? (
        <p className="muted">
          {t("taxReturn.foreignIncome.credit", {
            credit: formatF22Pesos(salary.credit_clp),
            cap: formatF22Pesos(salary.credit_cap_clp),
            applied: formatF22Pesos(salary.credit_applied_clp),
          })}
        </p>
      ) : null}
      {interest.lines.length > 0 ? (
        <p className="muted">{t("taxReturn.foreignIncome.interest", { usd: formatTaxDocumentDollars(interest.usd), clp: formatF22Pesos(interest.clp) })}</p>
      ) : null}
    </TaxSection>
  );
}

/**
 * Art. 107 LIR: fund units and shares sold on the exchange. Sales through 2026 pay a flat 10%
 * single tax on the mayor valor (codes 1809 / 1813 → 1814, carried loss 1815, base 1816, line 66
 * 1829 / 1830); from 2027 they are ingreso no renta and only listed. The fund's distributions are
 * dividends afectos al IGC (codes 105 / 610). Server: f22/art107.ts, f22/draft.ts.
 */
function Art107Section({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const a = data.art107;
  if (!a) return null;
  const carried = a.carried_loss_clp !== 0;
  const informed = a.informed_sales_clp != null || a.informed_result_clp != null;
  if (a.sales.length === 0 && a.distributions.length === 0 && !carried && !informed) return null;
  const taxed = a.sales.some((s) => s.regime === "tax_10pct");
  const hasInr = a.sales.some((s) => s.regime === "inr");
  return (
    <TaxSection
      id="art107"
      title={t("taxReturn.art107.title")}
      summary={
        <>
          {a.sales.length > 0
            ? countLabel(t, "taxReturn.count.sales", "taxReturn.count.salesOne", a.sales.length)
            : countLabel(t, "taxReturn.count.lines", "taxReturn.count.linesOne", a.distributions.length)}{" "}
          · {t("taxReturn.art107.summaryTax")} <b>{formatF22Pesos(a.tax_clp)}</b>
        </>
      }
    >
      {a.provisional ? <p className="muted">{t("taxReturn.art107.provisional")}</p> : null}
      <p className="muted">{t("taxReturn.art107.explain", { inrFrom: a.inr_from, method: t(`taxReturn.art107.lotMethod.${a.lot_method}`) })}</p>
      {hasInr ? <p className="muted">{t("taxReturn.art107.explainInr", { inrFrom: a.inr_from })}</p> : null}
      {a.sales.length > 0 ? (
        <>
          <p className="muted">
            {t("taxReturn.art107.costExplain", { option: t(`taxReturn.art107.option.${a.default_option}`) })} {t("taxReturn.art107.closeStandIn")}
          </p>
          <TaxDetailList
            rows={a.sales}
            rowKey={(s, i) => `${s.date}-${s.account_name}-${i}`}
            rowClassName={(s) => (s.regime === "inr" ? styles.faint : undefined)}
            lead={{ header: t("taxReturn.art107.date"), cell: (s) => s.date }}
            name={{
              header: t("taxReturn.art107.instrument"),
              cell: (s) => (
                <>
                  {s.account_name} <span className="muted">{t(`taxReturn.art107.kind.${s.kind}`)}</span>
                </>
              ),
            }}
            columns={[
              {
                key: "regime",
                header: t("taxReturn.art107.regime"),
                text: true,
                cell: (s) => (
                  <Pill size="small" uppercase={false}>
                    {t(`taxReturn.art107.regimeLabel.${s.regime}`)}
                  </Pill>
                ),
              },
              { key: "units", header: t("taxReturn.art107.units"), cell: (s) => formatGroupedDecimal(s.units, 0, 4) },
              { key: "proceeds", header: t("taxReturn.art107.proceeds"), cell: (s) => formatF22Pesos(s.proceeds_clp) },
              { key: "costPaid", header: t("taxReturn.art107.costPaid"), cell: (s) => formatF22Pesos(s.cost_clp) },
              { key: "costReajustado", header: t("taxReturn.art107.costReajustado"), cell: (s) => formatF22Pesos(s.cost_reajustado_clp) },
              { key: "closeDec31", header: t("taxReturn.art107.closeDec31"), cell: (s) => money(s.cost_close_dec31_clp) },
            ]}
            headline={{ key: "result", header: t("taxReturn.art107.result"), cell: (s) => money(s.result_clp[a.default_option]) }}
          />
          {taxed ? (
            <p>
              {t("taxReturn.art107.totals", {
                costPaid: formatF22Pesos(a.totals_clp.cost_paid),
                closeDec31: money(a.totals_clp.close_dec31),
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {carried ? (
        <p>
          {t("taxReturn.art107.carriedLoss", { amount: formatF22Pesos(a.carried_loss_clp) })}
          {a.carried_loss_source != null ? ` ${t(`taxReturn.art107.carriedLossSource.${a.carried_loss_source}`)}` : ""}
        </p>
      ) : null}
      {taxed || carried ? (
        <p>
          {t("taxReturn.art107.summary", {
            result: formatF22Pesos(a.result_clp),
            base: formatF22Pesos(a.base_clp),
            tax: formatF22Pesos(a.tax_clp),
          })}
        </p>
      ) : null}
      {a.informed_sales_clp != null ? <p className="muted">{t("taxReturn.art107.informedSales", { amount: formatF22Pesos(a.informed_sales_clp) })}</p> : null}
      {a.informed_result_clp != null ? <p className="muted">{t("taxReturn.art107.informedResult", { amount: formatF22Pesos(a.informed_result_clp) })}</p> : null}
      {a.distributions.length > 0 ? (
        <>
          <h3>{t("taxReturn.art107.distributionsTitle")}</h3>
          <p className="muted">{t("taxReturn.art107.distributionsExplain")}</p>
          <TaxDetailList
            rows={a.distributions}
            rowKey={(d, i) => `${d.date}-${d.account_name}-${i}`}
            lead={{ header: t("taxReturn.dividends.date"), cell: (d) => d.date }}
            name={{ header: t("taxReturn.art107.colAccount"), cell: (d) => d.account_name }}
            columns={[]}
            headline={{ key: "amount", header: t("taxReturn.art107.colAmount"), cell: (d) => formatF22Pesos(d.amount_clp) }}
          />
          <p>{t("taxReturn.art107.distributionsTotal", { amount: formatF22Pesos(a.distributions_clp) })}</p>
        </>
      ) : null}
    </TaxSection>
  );
}

/**
 * The exchange result on the foreign currency bought with pesos: each realized outflow (date, amount, the
 * lots' purchase dates, proceeds and cost at its currency's observado, result and its December
 * reajuste), the fees whose cost is lost, the deferred total, the posture and the route, and the
 * codes the route gives (1901 + IDPC credited back, or 1032 / 169). Report-only. Server:
 * f22/foreignFx.ts, f22/draft.ts.
 */
function ForeignFxSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.foreign_fx;
  if (!f) return null;
  if (f.disposals.length === 0 && f.fees.length === 0 && f.deferred.length === 0) return null;
  const codes =
    f.route === "idpc_1901" ? (
      f.codes[1901] != null && f.codes.idpc_clp != null ? (
        <p>{t("taxReturn.foreignFx.codes1901", { amount: formatF22Pesos(f.codes[1901]), idpc: formatF22Pesos(f.codes.idpc_clp) })}</p>
      ) : f.result_december_clp < 0 ? (
        <p className={styles.bad}>{t("taxReturn.foreignFx.lossLost1901")}</p>
      ) : null
    ) : f.codes[1032] != null ? (
      <p>{t("taxReturn.foreignFx.codes1032", { amount: formatF22Pesos(f.codes[1032]) })}</p>
    ) : f.codes.loss169 != null ? (
      <p>{t("taxReturn.foreignFx.loss169", { amount: formatF22Pesos(f.codes.loss169) })}</p>
    ) : null;
  return (
    <TaxSection
      id="foreign-fx"
      title={t("taxReturn.foreignFx.title")}
      summary={
        <>
          {countLabel(t, "taxReturn.count.lines", "taxReturn.count.linesOne", f.disposals.length + f.fees.length + f.deferred.length)} ·{" "}
          <b>{formatF22Pesos(f.result_december_clp)}</b>
        </>
      }
    >
      <p className="muted">
        {t("taxReturn.foreignFx.explain", {
          posture: t(`taxReturn.foreignFx.posture.${f.posture}`),
          cost: t(`taxReturn.foreignFx.costOption.${f.purchase_cost}`),
          route: t(`taxReturn.foreignFx.route.${f.route}`),
        })}
      </p>
      <p className="muted">{t("taxReturn.foreignFx.estimateNote")}</p>
      {f.provisional ? <p className="muted">{t("taxReturn.foreignFx.provisional", { month: f.reajuste_to_month.slice(0, 7) })}</p> : null}
      {f.disposals.length > 0 ? (
        <>
          <TaxDetailList
            rows={f.disposals}
            rowKey={(s, i) => `${s.date}-${s.account_name}-${i}`}
            lead={{ header: t("taxReturn.foreignFx.date"), cell: (s) => s.date }}
            name={{ header: t("taxReturn.foreignFx.account"), cell: (s) => s.account_name }}
            columns={[
              { key: "amount", header: t("taxReturn.foreignFx.amount"), cell: (s) => formatCurrencyFine(s.amount, s.currency) },
              { key: "purchaseDates", header: t("taxReturn.foreignFx.purchaseDates"), text: true, wrap: true, cell: (s) => <span className="mono">{s.purchase_dates.join(", ")}</span> },
              { key: "proceeds", header: t("taxReturn.foreignFx.proceeds"), cell: (s) => formatF22Pesos(s.proceeds_clp) },
              { key: "cost", header: t("taxReturn.foreignFx.cost"), cell: (s) => formatF22Pesos(s.cost_clp) },
              { key: "result", header: t("taxReturn.foreignFx.result"), cell: (s) => formatF22Pesos(s.gain_clp) },
              { key: "decemberPct", header: t("taxReturn.foreignFx.decemberPct"), cell: (s) => formatPct(s.december_pct, 1) },
            ]}
            headline={{ key: "resultDecember", header: t("taxReturn.foreignFx.resultDecember"), cell: (s) => formatF22Pesos(s.gain_december_clp) }}
          />
          <p>
            {t("taxReturn.foreignFx.totals", {
              result: formatF22Pesos(f.result_clp),
              resultDecember: formatF22Pesos(f.result_december_clp),
            })}
          </p>
          {f.by_currency.length > 1
            ? f.by_currency
                .filter((c) => c.disposals > 0)
                .map((c) => (
                  <p key={c.currency} className="muted">
                    {t("taxReturn.foreignFx.byCurrency", {
                      currency: c.currency.toUpperCase(),
                      result: formatF22Pesos(c.result),
                      resultDecember: formatF22Pesos(c.result_december),
                      count: c.disposals,
                    })}
                  </p>
                ))
            : null}
        </>
      ) : null}
      {codes}
      {f.fees.length > 0 ? (
        <>
          <h3>{t("taxReturn.foreignFx.feesTitle")}</h3>
          <p className="muted">{t("taxReturn.foreignFx.feesExplain")}</p>
          <TaxDetailList
            rows={f.fees}
            rowKey={(x, i) => `${x.date}-${x.account_name}-${i}`}
            lead={{ header: t("taxReturn.foreignFx.date"), cell: (x) => x.date }}
            name={{ header: t("taxReturn.foreignFx.account"), cell: (x) => x.account_name }}
            columns={[{ key: "amount", header: t("taxReturn.foreignFx.amount"), cell: (x) => formatCurrencyFine(x.amount, x.currency) }]}
            headline={{ key: "costLost", header: t("taxReturn.foreignFx.costLost"), cell: (x) => formatF22Pesos(x.cost_lost_clp) }}
          />
          <p>{t("taxReturn.foreignFx.feesTotal", { amount: formatF22Pesos(f.fees_lost_clp) })}</p>
        </>
      ) : null}
      {f.deferred.length > 0 ? (
        <p className="muted">{t("taxReturn.foreignFx.deferredTotal", { count: f.deferred.length, amount: formatF22Pesos(f.deferred_clp) })}</p>
      ) : null}
    </TaxSection>
  );
}

/**
 * The Chilean return of a tax year: the result as figures, the F22's codes against what was filed
 * and what third parties informed, and the detail behind the draft's codes as folded sections.
 * `controls` is the page's year and return switch, drawn at the top of the first tile.
 */
export function F22ReturnSections({ data, loading, controls }: { data: TaxReturnResponse | undefined; loading: boolean; controls: ReactNode }) {
  const { t, i18n } = useTranslation();
  // A code with a label in master.json (`taxReturn.codes.<code>`) shows it; any other «Código N».
  const codeLabel = (code: number) => (i18n.exists(`taxReturn.codes.${code}`) ? t(`taxReturn.codes.${code}`) : t("taxReturn.codeFallback", { code }));
  const rows: TaxCodeRow[] = (data?.rows ?? []).map((r) => ({
    key: String(r.code),
    code: String(r.code),
    concept: codeLabel(r.code),
    group: r.group,
    filed: r.filed,
    informed: r.informed,
    draft: r.draft,
    difference: r.difference,
    changed: r.changed,
    informedMismatch: r.informed_mismatch,
    sourcesAgree: r.sources_agree,
    estimated: r.estimated,
    strong: r.section === "subtotal" || r.section === "result",
    faint: r.section === "memo" || r.section === "payment",
  }));
  return (
    <>
      <PageGridTile id="tax-result">
        {controls}
        <TaxFigures figures={f22Figures(t, data)} />
        {data ? <TaxFacts facts={f22Facts(t, data)} /> : null}
        {data && data.salary.incomplete_months.length > 0 ? (
          <p className={`${styles.notice} ${styles.bad}`}>{t("taxReturn.salaryIncomplete", { months: data.salary.incomplete_months.join(", ") })}</p>
        ) : null}
      </PageGridTile>
      <PageGridTile id="f22">
        <TaxCodeList
          title={t("taxReturn.list.f22Title", { year: data?.tax_year ?? "" })}
          rows={rows}
          flaggedCount={data?.flagged_codes ?? 0}
          withInformed
          money={formatF22Pesos}
          groupLabel={(g) => t(`taxReturn.groups.${g}`)}
          labels={{
            code: t("taxReturn.table.code"),
            concept: t("taxReturn.table.concept"),
            filed: t("taxReturn.table.filed"),
            informed: t("taxReturn.table.informed"),
            draft: t("taxReturn.table.draft"),
            difference: t("taxReturn.table.difference"),
            estimated: t("taxReturn.estimatedTitle"),
          }}
          loading={loading}
          note={
            <>
              {data?.rows.some((r) => r.estimated) ? <p className={styles.listNote}>{t("taxReturn.estimatedNote")}</p> : null}
              <p className={styles.listNote}>{t("taxReturn.paymentNote")}</p>
            </>
          }
        />
      </PageGridTile>
      {/* The sections are server-decided absences; they wait for the response so none shows up for
          a year that has not loaded. */}
      {data ? (
        <PageGridTile id="f22-sections">
          <BasisSection data={data} />
          <SettlementSection data={data} />
          <LossOffsetSection data={data} />
          <ExcludedSection data={data} />
          <PayrollWithholdingSection data={data} />
          <CryptoSection data={data} />
          <DividendsSection data={data} />
          <ForeignSharesSection data={data} />
          <RentalsSection data={data} />
          <ForeignIncomeSection data={data} />
          <Art107Section data={data} />
          <ForeignFxSection data={data} />
        </PageGridTile>
      ) : null}
    </>
  );
}
