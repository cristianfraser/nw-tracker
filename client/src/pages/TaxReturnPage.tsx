import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Table } from "../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { formatClp, formatGroupedDecimal, formatPct, formatUsdFine } from "../format";
import { useTaxReturn } from "../queries/hooks";
import type { TaxReturnResponse, TaxReturnRow } from "../types";

/** Codes with a label in master.json (`taxReturn.codes.<code>`); others show «Código N». */
const LABELLED_CODES = new Set([
  31, 39, 90, 91, 136, 152, 155, 157, 158, 161, 162, 169, 170, 304, 305, 748, 750, 751, 1018, 1032, 1098, 1104, 1869, 1878,
  645,
]);

const money = (n: number | null) => (n == null ? "—" : formatClp(n));

function useCodeLabel() {
  const { t } = useTranslation();
  return (code: number) =>
    LABELLED_CODES.has(code) ? t(`taxReturn.codes.${code}`) : t("taxReturn.codeFallback", { code });
}

function F22Table({ rows }: { rows: TaxReturnRow[] }) {
  const { t } = useTranslation();
  const label = useCodeLabel();
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.table.code")}</th>
        <th className="desktop-only">{t("taxReturn.table.concept")}</th>
        <th className="desktop-only num">{t("taxReturn.table.filed")}</th>
        <th className="desktop-only num">{t("taxReturn.table.informed")}</th>
        <th className="desktop-only num">{t("taxReturn.table.draft")}</th>
        <th className="desktop-only num">{t("taxReturn.table.difference")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <Table header={header} tableClassName="table--parallel-mobile">
      {rows.map((r) => {
        const diff = r.changed ? (r.draft ?? 0) - (r.filed ?? 0) : null;
        const strong = r.section === "subtotal" || r.section === "result";
        const faint = r.section === "memo" || r.section === "payment";
        const style = { fontWeight: strong ? 600 : undefined, opacity: faint ? 0.7 : undefined };
        const informed = (
          <span style={r.informed_mismatch ? { color: "var(--negative)" } : undefined}>{money(r.informed)}</span>
        );
        return (
          <tr key={r.code} style={style}>
            <td className="desktop-only mono">{r.code}</td>
            <td className="desktop-only">{label(r.code)}</td>
            <td className="desktop-only num">{money(r.filed)}</td>
            <td className="desktop-only num">{informed}</td>
            <td className="desktop-only num" title={r.estimated ? t("taxReturn.estimatedTitle") : undefined}>
              {r.estimated ? "≈ " : ""}
              {money(r.draft)}
            </td>
            <td className="desktop-only num" style={diff != null ? { color: "var(--negative)" } : undefined}>
              {diff == null ? "" : formatClp(diff)}
            </td>
            <td className="mobile-only">
              <TableMobileCard title={`${r.code} · ${label(r.code)}`}>
                <TableMobileCardRow label={t("taxReturn.table.filed")} value={money(r.filed)} />
                <TableMobileCardRow label={t("taxReturn.table.informed")} value={informed} />
                <TableMobileCardRow
                  label={t("taxReturn.table.draft")}
                  value={`${r.estimated ? "≈ " : ""}${money(r.draft)}`}
                />
                {diff != null ? (
                  <TableMobileCardRow label={t("taxReturn.table.difference")} value={formatClp(diff)} />
                ) : null}
              </TableMobileCard>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

/**
 * A year's offset balance: the code-169 pool (F22 line 17: crypto, fund and interest losses
 * against those gains and foreign income) or the foreign share sales, whose loss offsets only
 * other foreign share gains. Shown when a loss is left over, or, in the open year, when a gain
 * could still be offset by realizing a loss.
 */
function LossOffsetHint({ data, kind }: { data: TaxReturnResponse; kind: "pool" | "foreign" }) {
  const { t } = useTranslation();
  const o = kind === "pool" ? data.loss_offset : data.foreign_share_offset;
  const k = (key: string) => `taxReturn.lossOffset.${kind === "foreign" ? `foreign${key[0].toUpperCase()}${key.slice(1)}` : key}`;
  const year = data.income_year;
  const tax = o.tax_effect_clp != null && o.tax_effect_clp > 0 ? formatClp(o.tax_effect_clp) : null;
  let text: string | null = null;
  if (o.unused_loss_clp > 0) {
    const amount = formatClp(o.unused_loss_clp);
    text = data.provisional
      ? `${t(k("unusedOpen"), { year, amount })}${tax ? ` ${t("taxReturn.lossOffset.unusedOpenTax", { tax })}` : ""}`
      : t(k("unusedClosed"), { year, amount });
  } else if (data.provisional && o.taxed_gain_clp > 0) {
    const amount = formatClp(o.taxed_gain_clp);
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
          .map((p) => `${t(`taxReturn.lossOffset.source.${p.source}`)} ${formatClp(p.gain_clp - p.loss_clp)}`)
          .join(" · ")
      : "";
  return (
    <p style={o.unused_loss_clp > 0 ? { color: "var(--negative)" } : undefined}>
      {text}
      {parts ? <span className="muted"> {t("taxReturn.lossOffset.breakdown", { parts })}</span> : null}
    </p>
  );
}

function CryptoSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const c = data.crypto;
  if (c.sales.length === 0) return null;
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.crypto.date")}</th>
        <th className="desktop-only">{t("taxReturn.crypto.coin")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.units")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.proceeds")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.cost")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.costReajustado")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.gain")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.decemberPct")}</th>
        <th className="desktop-only num">{t("taxReturn.crypto.gainDecember")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <section style={{ margin: "1.5rem 0" }}>
      <h2>{t("taxReturn.crypto.title")}</h2>
      {c.provisional ? <p className="muted">{t("taxReturn.crypto.provisional", { month: c.reajuste_to_month.slice(0, 7) })}</p> : null}
      <p className="muted">
        {t("taxReturn.crypto.explain", {
          method: t(`taxReturn.crypto.method.${c.method}`),
          fees: t(`taxReturn.crypto.fees.${c.fee_policy}`),
        })}
      </p>
      <Table header={header} tableClassName="table--parallel-mobile">
        {c.sales.map((s) => (
          <tr key={`${s.date}-${s.coin}-${s.units}`}>
            <td className="desktop-only mono">{s.date}</td>
            <td className="desktop-only">{s.coin}</td>
            <td className="desktop-only num">{formatGroupedDecimal(s.units, 8)}</td>
            <td className="desktop-only num">{formatClp(s.proceeds_clp)}</td>
            <td className="desktop-only num">{formatClp(s.cost_clp)}</td>
            <td className="desktop-only num">{formatClp(s.cost_reajustado_clp)}</td>
            <td className="desktop-only num">{formatClp(s.gain_clp)}</td>
            <td className="desktop-only num">{formatPct(s.december_pct, 1)}</td>
            <td className="desktop-only num">{formatClp(s.gain_december_clp)}</td>
            <td className="mobile-only">
              <TableMobileCard title={`${s.date} · ${s.coin}`}>
                <TableMobileCardRow label={t("taxReturn.crypto.units")} value={formatGroupedDecimal(s.units, 8)} />
                <TableMobileCardRow label={t("taxReturn.crypto.proceeds")} value={formatClp(s.proceeds_clp)} />
                <TableMobileCardRow label={t("taxReturn.crypto.cost")} value={formatClp(s.cost_clp)} />
                <TableMobileCardRow label={t("taxReturn.crypto.costReajustado")} value={formatClp(s.cost_reajustado_clp)} />
                <TableMobileCardRow label={t("taxReturn.crypto.gain")} value={formatClp(s.gain_clp)} />
                <TableMobileCardRow label={t("taxReturn.crypto.decemberPct")} value={formatPct(s.december_pct, 1)} />
                <TableMobileCardRow label={t("taxReturn.crypto.gainDecember")} value={formatClp(s.gain_december_clp)} />
              </TableMobileCard>
            </td>
          </tr>
        ))}
      </Table>
      <p>
        {t("taxReturn.crypto.totals", {
          sales: formatClp(c.sales_clp),
          gain: formatClp(c.gain_december_clp),
        })}
        {c.informed_sales_clp != null
          ? ` ${t("taxReturn.crypto.informed", { amount: formatClp(c.informed_sales_clp) })}`
          : ""}
      </p>
      <LossOffsetHint data={data} kind="pool" />
    </section>
  );
}

function DividendsSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  if (data.dividends.length === 0) return null;
  const missing = data.dividends.filter((d) => d.gross_usd == null).length;
  const usdOrMissing = (n: number | null) => (n == null ? t("taxReturn.dividends.missingDetail") : formatUsdFine(n));
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.dividends.date")}</th>
        <th className="desktop-only num">{t("taxReturn.dividends.grossUsd")}</th>
        <th className="desktop-only num">{t("taxReturn.dividends.withholdingUsd")}</th>
        <th className="desktop-only num">{t("taxReturn.dividends.grossClp")}</th>
        <th className="desktop-only num">{t("taxReturn.dividends.withholdingClp")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <section style={{ margin: "1.5rem 0" }}>
      <h2>{t("taxReturn.dividends.title")}</h2>
      <p className="muted">
        {t(data.provisional ? "taxReturn.dividends.explainProvisional" : "taxReturn.dividends.explain", {
          rate: `$${formatGroupedDecimal(data.year_end_observado, 2)}`,
          year: data.income_year,
        })}
      </p>
      {missing > 0 ? <p style={{ color: "var(--negative)" }}>{t("taxReturn.dividends.missingNote", { count: missing })}</p> : null}
      <Table header={header} tableClassName="table--parallel-mobile">
        {data.dividends.map((d) => (
          <tr key={d.date}>
            <td className="desktop-only mono">{d.date}</td>
            <td className="desktop-only num">{usdOrMissing(d.gross_usd)}</td>
            <td className="desktop-only num">{usdOrMissing(d.withholding_usd)}</td>
            <td className="desktop-only num">{money(d.gross_clp)}</td>
            <td className="desktop-only num">{money(d.withholding_clp)}</td>
            <td className="mobile-only">
              <TableMobileCard title={d.date}>
                <TableMobileCardRow label={t("taxReturn.dividends.grossUsd")} value={usdOrMissing(d.gross_usd)} />
                <TableMobileCardRow label={t("taxReturn.dividends.withholdingUsd")} value={usdOrMissing(d.withholding_usd)} />
                <TableMobileCardRow label={t("taxReturn.dividends.grossClp")} value={money(d.gross_clp)} />
                <TableMobileCardRow label={t("taxReturn.dividends.withholdingClp")} value={money(d.withholding_clp)} />
              </TableMobileCard>
            </td>
          </tr>
        ))}
      </Table>
      <LossOffsetHint data={data} kind="pool" />
    </section>
  );
}

function ForeignSharesSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.foreign_shares;
  if (f.sales.length === 0) return null;
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.foreign.date")}</th>
        <th className="desktop-only">{t("taxReturn.foreign.instrument")}</th>
        <th className="desktop-only num">{t("taxReturn.foreign.gainUsd")}</th>
        <th className="desktop-only num">{t("taxReturn.foreign.mode.usd_31dic")}</th>
        <th className="desktop-only num">{t("taxReturn.foreign.mode.clp_ipc")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <section style={{ margin: "1.5rem 0" }}>
      <h2>{t("taxReturn.foreign.title")}</h2>
      <p className="muted">
        {t("taxReturn.foreign.explain", { mode: t(`taxReturn.foreign.mode.${f.default_mode}`) })}
        {f.provisional ? ` ${t("taxReturn.foreign.provisional")}` : ""}
      </p>
      <Table header={header} tableClassName="table--parallel-mobile">
        {f.sales.map((s) => (
          <tr key={`${s.date}-${s.account_name}`}>
            <td className="desktop-only mono">{s.date}</td>
            <td className="desktop-only">{s.account_name}</td>
            <td className="desktop-only num">{formatUsdFine(s.gain_usd)}</td>
            <td className="desktop-only num">{formatClp(s.result_clp.usd_31dic)}</td>
            <td className="desktop-only num">{formatClp(s.result_clp.clp_ipc)}</td>
            <td className="mobile-only">
              <TableMobileCard title={`${s.date} · ${s.account_name}`}>
                <TableMobileCardRow label={t("taxReturn.foreign.gainUsd")} value={formatUsdFine(s.gain_usd)} />
                <TableMobileCardRow label={t("taxReturn.foreign.mode.usd_31dic")} value={formatClp(s.result_clp.usd_31dic)} />
                <TableMobileCardRow label={t("taxReturn.foreign.mode.clp_ipc")} value={formatClp(s.result_clp.clp_ipc)} />
              </TableMobileCard>
            </td>
          </tr>
        ))}
      </Table>
      <LossOffsetHint data={data} kind="foreign" />
    </section>
  );
}

export function TaxReturnPage() {
  const { t } = useTranslation();
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const q = useTaxReturn(taxYear);
  const data = q.data;

  return (
    <div className="page">
      <h1>{t("taxReturn.title")}</h1>
      <p className="muted">{t("taxReturn.subtitle")}</p>
      {q.isError ? <p className="error">{(q.error as Error).message}</p> : null}
      {!data ? (
        q.isLoading ? <p>{t("common.loading")}</p> : null
      ) : (
        <>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "1rem 0" }}>
            <span>{t("taxReturn.taxYearLabel")}</span>
            <select value={data.tax_year} onChange={(e) => setTaxYear(Number(e.target.value))}>
              {data.available_tax_years.map((y) => (
                <option key={y} value={y}>
                  {t("taxReturn.taxYearOption", { year: y, income: y - 1 })}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{t(`taxReturn.base.${data.base}`, { months: data.salary.months })}</p>
          {data.provisional ? <p className="muted">{t("taxReturn.provisionalYear", { year: data.income_year })}</p> : null}
          {data.salary.incomplete_months.length > 0 ? (
            <p style={{ color: "var(--negative)" }}>
              {t("taxReturn.salaryIncomplete", { months: data.salary.incomplete_months.join(", ") })}
            </p>
          ) : null}
          <p>
            {t("taxReturn.summaryFiled", { amount: money(data.tax_filed) })} ·{" "}
            {t("taxReturn.summaryDraft", { amount: money(data.tax_draft) })}
            {data.tax_filed != null && data.tax_draft != null
              ? ` · ${t("taxReturn.summaryDiff", { amount: formatClp(data.tax_draft - data.tax_filed) })}`
              : ""}
          </p>
          <F22Table rows={data.rows} />
          {data.rows.some((r) => r.estimated) ? <p className="muted">{t("taxReturn.estimatedNote")}</p> : null}
          <p className="muted">{t("taxReturn.paymentNote")}</p>
          {data.crypto.sales.length === 0 && data.dividends.length === 0 && data.foreign_shares.sales.length === 0 ? (
            <LossOffsetHint data={data} kind="pool" />
          ) : null}
          <CryptoSection data={data} />
          <DividendsSection data={data} />
          <ForeignSharesSection data={data} />
        </>
      )}
    </div>
  );
}
