import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { PageGridTile } from "../components/layout/PageGridTile";
import { Loadable, loadableClass } from "../components/ui/Loadable";
import { Pill } from "../components/ui/Pill";
import { ColumnTable } from "../components/ui/ColumnTable";
import { formatClp, formatGroupedDecimal, formatPct, formatUsdFine } from "../format";
import { useTaxReturn } from "../queries/hooks";
import type { TaxReturnResponse, TaxReturnRow } from "../types";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";

/** Codes with a label in master.json (`taxReturn.codes.<code>`); others show «Código N». */
const LABELLED_CODES = new Set([
  31, 39, 90, 91, 105, 136, 152, 155, 157, 158, 161, 162, 169, 170, 304, 305, 610, 748, 750, 751, 1018, 1032, 1098, 1104,
  1809, 1813, 1814, 1815, 1816, 1829, 1830, 1869, 1878, 645, 1901,
]);

const money = (n: number | null) => (n == null ? "—" : formatClp(n));

function useCodeLabel() {
  const { t } = useTranslation();
  return (code: number) =>
    LABELLED_CODES.has(code) ? t(`taxReturn.codes.${code}`) : t("taxReturn.codeFallback", { code });
}

const f22Diff = (r: TaxReturnRow) => (r.changed ? (r.draft ?? 0) - (r.filed ?? 0) : null);

function F22Table({ rows, loading }: { rows: TaxReturnRow[]; loading?: boolean }) {
  const { t } = useTranslation();
  const label = useCodeLabel();
  return (
    <ColumnTable
      rows={rows}
      rowKey={(r) => r.code}
      wrapClassName={loadableClass(loading)}
      cardLayout="flat"
      rowProps={(r) => {
        const strong = r.section === "subtotal" || r.section === "result";
        const faint = r.section === "memo" || r.section === "payment";
        return { style: { fontWeight: strong ? 600 : undefined, opacity: faint ? 0.7 : undefined } };
      }}
      columns={[
        { key: "code", header: t("taxReturn.table.code"), className: "mono", cell: (r) => r.code, title: (r) => `${r.code} · ${label(r.code)}` },
        { key: "concept", header: t("taxReturn.table.concept"), cell: (r) => label(r.code), desktopOnly: true },
        { key: "filed", header: t("taxReturn.table.filed"), headerClassName: "num", className: "num", cell: (r) => money(r.filed) },
        {
          key: "informed",
          header: t("taxReturn.table.informed"),
          headerClassName: "num",
          className: "num",
          cell: (r) => <span style={r.informed_mismatch ? { color: "var(--negative)" } : undefined}>{money(r.informed)}</span>,
        },
        {
          key: "draft",
          header: t("taxReturn.table.draft"),
          headerClassName: "num",
          className: "num",
          cellProps: (r) => ({ title: r.estimated ? t("taxReturn.estimatedTitle") : undefined }),
          cell: (r) => (
            <>
              {r.estimated ? "≈ " : ""}
              {money(r.draft)}
            </>
          ),
          card: (r) => `${r.estimated ? "≈ " : ""}${money(r.draft)}`,
        },
        {
          key: "difference",
          header: t("taxReturn.table.difference"),
          headerClassName: "num",
          className: "num",
          cellProps: (r) => (f22Diff(r) != null ? { style: { color: "var(--negative)" } } : {}),
          cell: (r) => {
            const diff = f22Diff(r);
            return diff == null ? "" : formatClp(diff);
          },
          card: (r) => {
            const diff = f22Diff(r);
            return diff == null ? null : formatClp(diff);
          },
        },
      ]}
    />
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
  return (
    <PageGridTile id="crypto">
      <h2>{t("taxReturn.crypto.title")}</h2>
      {c.provisional ? <p className="muted">{t("taxReturn.crypto.provisional", { month: c.reajuste_to_month.slice(0, 7) })}</p> : null}
      <p className="muted">
        {t("taxReturn.crypto.explain", {
          method: t(`taxReturn.crypto.method.${c.method}`),
          fees: t(`taxReturn.crypto.fees.${c.fee_policy}`),
        })}
      </p>
      <ColumnTable
        rows={c.sales}
        rowKey={(s) => `${s.date}-${s.coin}-${s.units}`}
        cardLayout="flat"
        columns={[
          { key: "date", header: t("taxReturn.crypto.date"), className: "mono", cell: (s) => s.date, title: (s) => `${s.date} · ${s.coin}` },
          { key: "coin", header: t("taxReturn.crypto.coin"), cell: (s) => s.coin, desktopOnly: true },
          { key: "units", header: t("taxReturn.crypto.units"), headerClassName: "num", className: "num", cell: (s) => formatGroupedDecimal(s.units, 8) },
          { key: "proceeds", header: t("taxReturn.crypto.proceeds"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.proceeds_clp) },
          { key: "cost", header: t("taxReturn.crypto.cost"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.cost_clp) },
          { key: "costReajustado", header: t("taxReturn.crypto.costReajustado"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.cost_reajustado_clp) },
          { key: "gain", header: t("taxReturn.crypto.gain"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.gain_clp) },
          { key: "decemberPct", header: t("taxReturn.crypto.decemberPct"), headerClassName: "num", className: "num", cell: (s) => formatPct(s.december_pct, 1) },
          { key: "gainDecember", header: t("taxReturn.crypto.gainDecember"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.gain_december_clp) },
        ]}
      />
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
    </PageGridTile>
  );
}

function DividendsSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  if (data.dividends.length === 0) return null;
  const missing = data.dividends.filter((d) => d.gross_usd == null).length;
  const usdOrMissing = (n: number | null) => (n == null ? t("taxReturn.dividends.missingDetail") : formatUsdFine(n));
  return (
    <PageGridTile id="dividends">
      <h2>{t("taxReturn.dividends.title")}</h2>
      <p className="muted">
        {t(data.provisional ? "taxReturn.dividends.explainProvisional" : "taxReturn.dividends.explain", {
          rate: `$${formatGroupedDecimal(data.year_end_observado, 2)}`,
          year: data.income_year,
        })}
      </p>
      {missing > 0 ? <p style={{ color: "var(--negative)" }}>{t("taxReturn.dividends.missingNote", { count: missing })}</p> : null}
      <ColumnTable
        rows={data.dividends}
        rowKey={(d) => d.date}
        cardLayout="flat"
        columns={[
          { key: "date", header: t("taxReturn.dividends.date"), className: "mono", cell: (d) => d.date, title: true },
          { key: "grossUsd", header: t("taxReturn.dividends.grossUsd"), headerClassName: "num", className: "num", cell: (d) => usdOrMissing(d.gross_usd) },
          { key: "withholdingUsd", header: t("taxReturn.dividends.withholdingUsd"), headerClassName: "num", className: "num", cell: (d) => usdOrMissing(d.withholding_usd) },
          { key: "grossClp", header: t("taxReturn.dividends.grossClp"), headerClassName: "num", className: "num", cell: (d) => money(d.gross_clp) },
          { key: "withholdingClp", header: t("taxReturn.dividends.withholdingClp"), headerClassName: "num", className: "num", cell: (d) => money(d.withholding_clp) },
        ]}
      />
      <LossOffsetHint data={data} kind="pool" />
    </PageGridTile>
  );
}

function ForeignSharesSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.foreign_shares;
  if (f.sales.length === 0) return null;
  return (
    <PageGridTile id="foreign-shares">
      <h2>{t("taxReturn.foreign.title")}</h2>
      <p className="muted">
        {t("taxReturn.foreign.explain", { mode: t(`taxReturn.foreign.mode.${f.default_mode}`) })}
        {f.provisional ? ` ${t("taxReturn.foreign.provisional")}` : ""}
      </p>
      <ColumnTable
        rows={f.sales}
        rowKey={(s) => `${s.date}-${s.account_name}`}
        cardLayout="flat"
        columns={[
          {
            key: "date",
            header: t("taxReturn.foreign.date"),
            className: "mono",
            cell: (s) => s.date,
            title: (s) => `${s.date} · ${s.account_name}`,
          },
          { key: "instrument", header: t("taxReturn.foreign.instrument"), cell: (s) => s.account_name, desktopOnly: true },
          { key: "gainUsd", header: t("taxReturn.foreign.gainUsd"), headerClassName: "num", className: "num", cell: (s) => formatUsdFine(s.gain_usd) },
          { key: "usd31", header: t("taxReturn.foreign.mode.usd_31dic"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.result_clp.usd_31dic) },
          { key: "clpIpc", header: t("taxReturn.foreign.mode.clp_ipc"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.result_clp.clp_ipc) },
        ]}
      />
      <LossOffsetHint data={data} kind="foreign" />
    </PageGridTile>
  );
}

/**
 * Art. 107 LIR: fund units and shares sold on the exchange. Sales through 2026 pay a flat 10%
 * single tax on the mayor valor (codes 1809 / 1813 → 1814, carried loss 1815, base 1816, line 66
 * 1829 / 1830); from 2027 they are ingreso no renta and only listed. The fund's distributions are
 * dividends afectos al IGC (codes 105 / 610). Server: art107TaxGains.ts, f22Draft.ts.
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
    <PageGridTile id="art107">
      <h2>{t("taxReturn.art107.title")}</h2>
      {a.provisional ? <p className="muted">{t("taxReturn.art107.provisional")}</p> : null}
      <p className="muted">
        {t("taxReturn.art107.explain", { inrFrom: a.inr_from, method: t(`taxReturn.art107.lotMethod.${a.lot_method}`) })}
      </p>
      {hasInr ? <p className="muted">{t("taxReturn.art107.explainInr", { inrFrom: a.inr_from })}</p> : null}
      {a.sales.length > 0 ? (
        <>
          <p className="muted">
            {t("taxReturn.art107.costExplain", { option: t(`taxReturn.art107.option.${a.default_option}`) })}{" "}
            {t("taxReturn.art107.closeStandIn")}
          </p>
          <ColumnTable
            rows={a.sales}
            rowKey={(s) => `${s.date}-${s.account_name}-${a.sales.indexOf(s)}`}
            cardLayout="flat"
            rowProps={(s) => ({ style: { opacity: s.regime === "inr" ? 0.7 : undefined } })}
            columns={[
              {
                key: "date",
                header: t("taxReturn.art107.date"),
                className: "mono",
                cell: (s) => s.date,
                title: (s) => `${s.date} · ${s.account_name} · ${t(`taxReturn.art107.kind.${s.kind}`)}`,
              },
              {
                key: "instrument",
                header: t("taxReturn.art107.instrument"),
                desktopOnly: true,
                cell: (s) => (
                  <>
                    {s.account_name} <span className="muted">{t(`taxReturn.art107.kind.${s.kind}`)}</span>
                  </>
                ),
              },
              { key: "units", header: t("taxReturn.art107.units"), headerClassName: "num", className: "num", cell: (s) => formatGroupedDecimal(s.units, 0, 4) },
              { key: "proceeds", header: t("taxReturn.art107.proceeds"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.proceeds_clp) },
              { key: "costPaid", header: t("taxReturn.art107.costPaid"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.cost_clp) },
              { key: "costReajustado", header: t("taxReturn.art107.costReajustado"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.cost_reajustado_clp) },
              { key: "closeDec31", header: t("taxReturn.art107.closeDec31"), headerClassName: "num", className: "num", cell: (s) => money(s.cost_close_dec31_clp) },
              { key: "result", header: t("taxReturn.art107.result"), headerClassName: "num", className: "num", cell: (s) => money(s.result_clp[a.default_option]) },
              {
                key: "regime",
                header: t("taxReturn.art107.regime"),
                cell: (s) => (
                  <Pill size="small" uppercase={false}>
                    {t(`taxReturn.art107.regimeLabel.${s.regime}`)}
                  </Pill>
                ),
              },
            ]}
          />
          {taxed ? (
            <p>
              {t("taxReturn.art107.totals", {
                costPaid: formatClp(a.totals_clp.cost_paid),
                closeDec31: money(a.totals_clp.close_dec31),
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {carried ? (
        <p>
          {t("taxReturn.art107.carriedLoss", { amount: formatClp(a.carried_loss_clp) })}
          {a.carried_loss_source != null ? ` ${t(`taxReturn.art107.carriedLossSource.${a.carried_loss_source}`)}` : ""}
        </p>
      ) : null}
      {taxed || carried ? (
        <p>
          {t("taxReturn.art107.summary", {
            result: formatClp(a.result_clp),
            base: formatClp(a.base_clp),
            tax: formatClp(a.tax_clp),
          })}
        </p>
      ) : null}
      {a.informed_sales_clp != null ? (
        <p className="muted">{t("taxReturn.art107.informedSales", { amount: formatClp(a.informed_sales_clp) })}</p>
      ) : null}
      {a.informed_result_clp != null ? (
        <p className="muted">{t("taxReturn.art107.informedResult", { amount: formatClp(a.informed_result_clp) })}</p>
      ) : null}
      {a.distributions.length > 0 ? (
        <>
          <h3>{t("taxReturn.art107.distributionsTitle")}</h3>
          <p className="muted">{t("taxReturn.art107.distributionsExplain")}</p>
          <ColumnTable
            rows={a.distributions}
            rowKey={(d) => `${d.date}-${d.account_name}-${a.distributions.indexOf(d)}`}
            cardLayout="flat"
            columns={[
              {
                key: "date",
                header: t("taxReturn.dividends.date"),
                className: "mono",
                cell: (d) => d.date,
                title: (d) => `${d.date} · ${d.account_name}`,
              },
              { key: "account", header: t("taxReturn.art107.colAccount"), cell: (d) => d.account_name, desktopOnly: true },
              { key: "amount", header: t("taxReturn.art107.colAmount"), headerClassName: "num", className: "num", cell: (d) => formatClp(d.amount_clp) },
            ]}
          />
          <p>{t("taxReturn.art107.distributionsTotal", { amount: formatClp(a.distributions_clp) })}</p>
        </>
      ) : null}
    </PageGridTile>
  );
}

/**
 * The exchange result on the dollars bought with pesos: each realized outflow (date, dollars, the
 * lots' purchase dates, proceeds and cost at the dólar observado, result and its December
 * reajuste), the fees whose cost is lost, the deferred total, the posture and the route, and the
 * codes the route gives (1901 + IDPC credited back, or 1032 / 169). Report-only. Server:
 * usdFxTaxGains.ts, f22Draft.ts.
 */
function UsdFxSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const f = data.usd_fx;
  if (!f) return null;
  if (f.disposals.length === 0 && f.fees.length === 0 && f.deferred.length === 0) return null;
  const codes =
    f.route === "idpc_1901" ? (
      f.codes[1901] != null && f.codes.idpc_clp != null ? (
        <p>{t("taxReturn.usdFx.codes1901", { amount: formatClp(f.codes[1901]), idpc: formatClp(f.codes.idpc_clp) })}</p>
      ) : f.result_december_clp < 0 ? (
        <p style={{ color: "var(--negative)" }}>{t("taxReturn.usdFx.lossLost1901")}</p>
      ) : null
    ) : f.codes[1032] != null ? (
      <p>{t("taxReturn.usdFx.codes1032", { amount: formatClp(f.codes[1032]) })}</p>
    ) : f.codes.loss169 != null ? (
      <p>{t("taxReturn.usdFx.loss169", { amount: formatClp(f.codes.loss169) })}</p>
    ) : null;
  return (
    <PageGridTile id="usd-fx">
      <h2>{t("taxReturn.usdFx.title")}</h2>
      <p className="muted">
        {t("taxReturn.usdFx.explain", {
          posture: t(`taxReturn.usdFx.posture.${f.posture}`),
          cost: t(`taxReturn.usdFx.costOption.${f.purchase_cost}`),
          route: t(`taxReturn.usdFx.route.${f.route}`),
        })}
      </p>
      <p className="muted">{t("taxReturn.usdFx.estimateNote")}</p>
      {f.provisional ? <p className="muted">{t("taxReturn.usdFx.provisional", { month: f.reajuste_to_month.slice(0, 7) })}</p> : null}
      {f.disposals.length > 0 ? (
        <>
          <ColumnTable
            rows={f.disposals}
            rowKey={(s) => `${s.date}-${s.account_name}-${f.disposals.indexOf(s)}`}
            cardLayout="flat"
            columns={[
              {
                key: "date",
                header: t("taxReturn.usdFx.date"),
                className: "mono",
                cell: (s) => s.date,
                title: (s) => `${s.date} · ${s.account_name}`,
              },
              { key: "account", header: t("taxReturn.usdFx.account"), cell: (s) => s.account_name, desktopOnly: true },
              { key: "usd", header: t("taxReturn.usdFx.usd"), headerClassName: "num", className: "num", cell: (s) => formatUsdFine(s.usd) },
              {
                key: "purchaseDates",
                header: t("taxReturn.usdFx.purchaseDates"),
                className: "mono",
                cell: (s) => s.purchase_dates.join(", "),
              },
              { key: "proceeds", header: t("taxReturn.usdFx.proceeds"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.proceeds_clp) },
              { key: "cost", header: t("taxReturn.usdFx.cost"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.cost_clp) },
              { key: "result", header: t("taxReturn.usdFx.result"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.gain_clp) },
              { key: "decemberPct", header: t("taxReturn.usdFx.decemberPct"), headerClassName: "num", className: "num", cell: (s) => formatPct(s.december_pct, 1) },
              { key: "resultDecember", header: t("taxReturn.usdFx.resultDecember"), headerClassName: "num", className: "num", cell: (s) => formatClp(s.gain_december_clp) },
            ]}
          />
          <p>
            {t("taxReturn.usdFx.totals", {
              result: formatClp(f.result_clp),
              resultDecember: formatClp(f.result_december_clp),
            })}
          </p>
        </>
      ) : null}
      {codes}
      {f.fees.length > 0 ? (
        <>
          <h3>{t("taxReturn.usdFx.feesTitle")}</h3>
          <p className="muted">{t("taxReturn.usdFx.feesExplain")}</p>
          <ColumnTable
            rows={f.fees}
            rowKey={(x) => `${x.date}-${x.account_name}-${f.fees.indexOf(x)}`}
            cardLayout="flat"
            columns={[
              {
                key: "date",
                header: t("taxReturn.usdFx.date"),
                className: "mono",
                cell: (x) => x.date,
                title: (x) => `${x.date} · ${x.account_name}`,
              },
              { key: "account", header: t("taxReturn.usdFx.account"), cell: (x) => x.account_name, desktopOnly: true },
              { key: "usd", header: t("taxReturn.usdFx.usd"), headerClassName: "num", className: "num", cell: (x) => formatUsdFine(x.usd) },
              { key: "costLost", header: t("taxReturn.usdFx.costLost"), headerClassName: "num", className: "num", cell: (x) => formatClp(x.cost_lost_clp) },
            ]}
          />
          <p>{t("taxReturn.usdFx.feesTotal", { amount: formatClp(f.fees_lost_clp) })}</p>
        </>
      ) : null}
      {f.deferred.length > 0 ? (
        <p className="muted">
          {t("taxReturn.usdFx.deferredTotal", { count: f.deferred.length, amount: formatClp(f.deferred_clp) })}
        </p>
      ) : null}
    </PageGridTile>
  );
}

type SettlementLink = NonNullable<TaxReturnResponse["settlement"]>["links"][number];

function settlementLinkLabel(t: TFunction, l: SettlementLink): string {
  if (l.kind === "offset_kept" || l.kind === "offset_paid") {
    return t(`taxReturn.settlement.link.${l.kind}`, { year: l.other_tax_year });
  }
  return t(`taxReturn.settlement.link.${l.kind}${l.movement_id == null ? "Card" : ""}`);
}

function SettlementSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.settlement;
  if (!s || !s.expected) return null;
  return (
    <PageGridTile id="settlement">
      <h2>{t("taxReturn.settlement.title")}</h2>
      <p>
        {t(`taxReturn.settlement.expected.${s.expected.kind}`, { amount: formatClp(s.expected.amount) })}
        {s.links.length === 0 ? (
          <span style={{ color: "var(--negative)" }}> · {t("taxReturn.settlement.notLinked")}</span>
        ) : (
          <>
            {" · "}
            {t(`taxReturn.settlement.settled.${s.expected.kind}`, { amount: formatClp(s.settled) })}
            {s.difference != null && s.difference !== 0
              ? ` · ${t(`taxReturn.settlement.difference.${s.expected.kind}`, { amount: formatClp(s.difference) })}`
              : ""}
          </>
        )}
      </p>
      {s.links.length > 0 ? (
        <ColumnTable
          rows={s.links}
          rowKey={(l) => `${l.kind}-${l.account_id}-${l.occurred_on}-${l.amount}`}
          cardLayout="flat"
          columns={[
            {
              key: "date",
              header: t("taxReturn.settlement.colDate"),
              className: "mono",
              cell: (l) => l.occurred_on,
              title: (l) => (l.account_name ? `${l.occurred_on} · ${l.account_name}` : l.occurred_on),
            },
            { key: "account", header: t("taxReturn.settlement.colAccount"), cell: (l) => l.account_name ?? "—", desktopOnly: true },
            { key: "description", header: t("taxReturn.settlement.colDescription"), cell: (l) => settlementLinkLabel(t, l) },
            { key: "amount", header: t("taxReturn.settlement.colAmount"), headerClassName: "num", className: "num", cell: (l) => formatClp(l.amount) },
          ]}
        />
      ) : null}
    </PageGridTile>
  );
}

function PayrollWithholdingSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const w = data.payroll_withholding;
  if (w.payslips === 0) return null;
  const differs = (d: number) => Math.abs(d) > 1;
  const monthLabel = (m: (typeof w.months)[number]) =>
    `${m.period_month}${m.origin === "rebuilt" ? ` (${t("taxReturn.payroll.rebuilt")})` : ""}`;
  return (
    <PageGridTile id="payroll-withholding">
      <h2>{t("taxReturn.payroll.title")}</h2>
      <p className="muted">{t("taxReturn.payroll.explain")}</p>
      <p>
        {t("taxReturn.payroll.summary", {
          withheld: formatClp(w.withheld),
          byTable: formatClp(w.by_table),
          difference: formatClp(w.difference),
        })}
      </p>
      <ColumnTable
        rows={w.months}
        rowKey={(m) => m.payslip_id}
        cardLayout="flat"
        columns={[
          { key: "month", header: t("taxReturn.payroll.colMonth"), className: "mono", cell: monthLabel, title: true },
          { key: "withheld", header: t("taxReturn.payroll.colWithheld"), headerClassName: "num", className: "num", cell: (m) => formatClp(m.withheld) },
          { key: "byTable", header: t("taxReturn.payroll.colTable"), headerClassName: "num", className: "num", cell: (m) => formatClp(m.by_table) },
          {
            key: "difference",
            header: t("taxReturn.payroll.colDifference"),
            headerClassName: "num",
            className: "num",
            cellProps: (m) => (differs(m.difference) ? { style: { color: "var(--negative)" } } : {}),
            cell: (m) => (differs(m.difference) ? formatClp(m.difference) : "—"),
          },
        ]}
      />
    </PageGridTile>
  );
}

export function TaxReturnPage() {
  const { t } = useTranslation();
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const q = useTaxReturn(taxYear);
  const data = q.data;
  // First load, or the previous year's return held while the chosen year's loads.
  const loading = queryShowsLoading(q);

  return (
    <main>
      <h1>{t("taxReturn.title")}</h1>
      <p className="muted">{t("taxReturn.subtitle")}</p>
      {queryLoadError(q) ? <p className="error">{(q.error as Error).message}</p> : null}
      {queryLoadError(q) ? null : (
        <Loadable loading={loading} className="page-grid">
          <PageGridTile id="f22">
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span>{t("taxReturn.taxYearLabel")}</span>
              <select
                value={taxYear ?? data?.tax_year ?? ""}
                disabled={loading}
                onChange={(e) => setTaxYear(Number(e.target.value))}
              >
                {(data?.available_tax_years ?? []).map((y) => (
                  <option key={y} value={y}>
                    {t("taxReturn.taxYearOption", { year: y, income: y - 1 })}
                  </option>
                ))}
              </select>
            </label>
            {data ? <p className="muted">{t(`taxReturn.base.${data.base}`, { months: data.salary.months })}</p> : null}
            {data?.provisional ? <p className="muted">{t("taxReturn.provisionalYear", { year: data.income_year })}</p> : null}
            {data && data.salary.incomplete_months.length > 0 ? (
              <p style={{ color: "var(--negative)" }}>
                {t("taxReturn.salaryIncomplete", { months: data.salary.incomplete_months.join(", ") })}
              </p>
            ) : null}
            <p>
              {t("taxReturn.summaryFiled", { amount: money(data?.tax_filed ?? null) })} ·{" "}
              {t("taxReturn.summaryDraft", { amount: money(data?.tax_draft ?? null) })}
              {data && data.tax_filed != null && data.tax_draft != null
                ? ` · ${t("taxReturn.summaryDiff", { amount: formatClp(data.tax_draft - data.tax_filed) })}`
                : ""}
            </p>
            <F22Table rows={data?.rows ?? []} loading={loading} />
            {data?.rows.some((r) => r.estimated) ? <p className="muted">{t("taxReturn.estimatedNote")}</p> : null}
            <p className="muted">{t("taxReturn.paymentNote")}</p>
          </PageGridTile>
          {/* The sections below are server-decided absences; they wait for the response so no
              explanatory copy shows up for a year that has not loaded. */}
          {data ? (
            <>
              {data.crypto.sales.length === 0 && data.dividends.length === 0 && data.foreign_shares.sales.length === 0 ? (
                <LossOffsetHint data={data} kind="pool" />
              ) : null}
              <SettlementSection data={data} />
              <PayrollWithholdingSection data={data} />
              <CryptoSection data={data} />
              <DividendsSection data={data} />
              <ForeignSharesSection data={data} />
              <Art107Section data={data} />
              <UsdFxSection data={data} />
            </>
          ) : null}
        </Loadable>
      )}
    </main>
  );
}
