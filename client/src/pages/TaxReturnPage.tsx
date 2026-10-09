import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Loadable, loadableClass } from "../components/ui/Loadable";
import { Pill } from "../components/ui/Pill";
import { Table } from "../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { formatClp, formatGroupedDecimal, formatPct, formatUsdFine } from "../format";
import { useTaxReturn } from "../queries/hooks";
import type { TaxReturnResponse, TaxReturnRow } from "../types";

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

function F22Table({ rows, loading }: { rows: TaxReturnRow[]; loading?: boolean }) {
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
    <Table header={header} tableClassName="table--parallel-mobile" wrapClassName={loadableClass(loading)}>
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
  const salesHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.art107.date")}</th>
        <th className="desktop-only">{t("taxReturn.art107.instrument")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.units")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.proceeds")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.costPaid")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.costReajustado")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.closeDec31")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.result")}</th>
        <th className="desktop-only">{t("taxReturn.art107.regime")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  const distributionsHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.dividends.date")}</th>
        <th className="desktop-only">{t("taxReturn.art107.colAccount")}</th>
        <th className="desktop-only num">{t("taxReturn.art107.colAmount")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <section style={{ margin: "1.5rem 0" }}>
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
          <Table header={salesHeader} tableClassName="table--parallel-mobile">
            {a.sales.map((s, i) => {
              const kind = t(`taxReturn.art107.kind.${s.kind}`);
              const regime = <Pill size="small" uppercase={false}>{t(`taxReturn.art107.regimeLabel.${s.regime}`)}</Pill>;
              const result = s.result_clp[a.default_option];
              return (
                <tr key={`${s.date}-${s.account_name}-${i}`} style={{ opacity: s.regime === "inr" ? 0.7 : undefined }}>
                  <td className="desktop-only mono">{s.date}</td>
                  <td className="desktop-only">
                    {s.account_name} <span className="muted">{kind}</span>
                  </td>
                  <td className="desktop-only num">{formatGroupedDecimal(s.units, 0, 4)}</td>
                  <td className="desktop-only num">{formatClp(s.proceeds_clp)}</td>
                  <td className="desktop-only num">{formatClp(s.cost_clp)}</td>
                  <td className="desktop-only num">{formatClp(s.cost_reajustado_clp)}</td>
                  <td className="desktop-only num">{money(s.cost_close_dec31_clp)}</td>
                  <td className="desktop-only num">{money(result)}</td>
                  <td className="desktop-only">{regime}</td>
                  <td className="mobile-only">
                    <TableMobileCard title={`${s.date} · ${s.account_name} · ${kind}`}>
                      <TableMobileCardRow label={t("taxReturn.art107.units")} value={formatGroupedDecimal(s.units, 0, 4)} />
                      <TableMobileCardRow label={t("taxReturn.art107.proceeds")} value={formatClp(s.proceeds_clp)} />
                      <TableMobileCardRow label={t("taxReturn.art107.costPaid")} value={formatClp(s.cost_clp)} />
                      <TableMobileCardRow label={t("taxReturn.art107.costReajustado")} value={formatClp(s.cost_reajustado_clp)} />
                      <TableMobileCardRow label={t("taxReturn.art107.closeDec31")} value={money(s.cost_close_dec31_clp)} />
                      <TableMobileCardRow label={t("taxReturn.art107.result")} value={money(result)} />
                      <TableMobileCardRow label={t("taxReturn.art107.regime")} value={regime} />
                    </TableMobileCard>
                  </td>
                </tr>
              );
            })}
          </Table>
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
          <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("taxReturn.art107.distributionsTitle")}</h3>
          <p className="muted">{t("taxReturn.art107.distributionsExplain")}</p>
          <Table header={distributionsHeader} tableClassName="table--parallel-mobile">
            {a.distributions.map((d, i) => (
              <tr key={`${d.date}-${d.account_name}-${i}`}>
                <td className="desktop-only mono">{d.date}</td>
                <td className="desktop-only">{d.account_name}</td>
                <td className="desktop-only num">{formatClp(d.amount_clp)}</td>
                <td className="mobile-only">
                  <TableMobileCard title={`${d.date} · ${d.account_name}`}>
                    <TableMobileCardRow label={t("taxReturn.art107.colAmount")} value={formatClp(d.amount_clp)} />
                  </TableMobileCard>
                </td>
              </tr>
            ))}
          </Table>
          <p>{t("taxReturn.art107.distributionsTotal", { amount: formatClp(a.distributions_clp) })}</p>
        </>
      ) : null}
    </section>
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
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.usdFx.date")}</th>
        <th className="desktop-only">{t("taxReturn.usdFx.account")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.usd")}</th>
        <th className="desktop-only">{t("taxReturn.usdFx.purchaseDates")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.proceeds")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.cost")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.result")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.decemberPct")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.resultDecember")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  const feesHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.usdFx.date")}</th>
        <th className="desktop-only">{t("taxReturn.usdFx.account")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.usd")}</th>
        <th className="desktop-only num">{t("taxReturn.usdFx.costLost")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
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
    <section style={{ margin: "1.5rem 0" }}>
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
          <Table header={header} tableClassName="table--parallel-mobile">
            {f.disposals.map((s, i) => {
              const bought = s.purchase_dates.join(", ");
              return (
                <tr key={`${s.date}-${s.account_name}-${i}`}>
                  <td className="desktop-only mono">{s.date}</td>
                  <td className="desktop-only">{s.account_name}</td>
                  <td className="desktop-only num">{formatUsdFine(s.usd)}</td>
                  <td className="desktop-only mono">{bought}</td>
                  <td className="desktop-only num">{formatClp(s.proceeds_clp)}</td>
                  <td className="desktop-only num">{formatClp(s.cost_clp)}</td>
                  <td className="desktop-only num">{formatClp(s.gain_clp)}</td>
                  <td className="desktop-only num">{formatPct(s.december_pct, 1)}</td>
                  <td className="desktop-only num">{formatClp(s.gain_december_clp)}</td>
                  <td className="mobile-only">
                    <TableMobileCard title={`${s.date} · ${s.account_name}`}>
                      <TableMobileCardRow label={t("taxReturn.usdFx.usd")} value={formatUsdFine(s.usd)} />
                      <TableMobileCardRow label={t("taxReturn.usdFx.purchaseDates")} value={bought} />
                      <TableMobileCardRow label={t("taxReturn.usdFx.proceeds")} value={formatClp(s.proceeds_clp)} />
                      <TableMobileCardRow label={t("taxReturn.usdFx.cost")} value={formatClp(s.cost_clp)} />
                      <TableMobileCardRow label={t("taxReturn.usdFx.result")} value={formatClp(s.gain_clp)} />
                      <TableMobileCardRow label={t("taxReturn.usdFx.decemberPct")} value={formatPct(s.december_pct, 1)} />
                      <TableMobileCardRow label={t("taxReturn.usdFx.resultDecember")} value={formatClp(s.gain_december_clp)} />
                    </TableMobileCard>
                  </td>
                </tr>
              );
            })}
          </Table>
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
          <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("taxReturn.usdFx.feesTitle")}</h3>
          <p className="muted">{t("taxReturn.usdFx.feesExplain")}</p>
          <Table header={feesHeader} tableClassName="table--parallel-mobile">
            {f.fees.map((x, i) => (
              <tr key={`${x.date}-${x.account_name}-${i}`}>
                <td className="desktop-only mono">{x.date}</td>
                <td className="desktop-only">{x.account_name}</td>
                <td className="desktop-only num">{formatUsdFine(x.usd)}</td>
                <td className="desktop-only num">{formatClp(x.cost_lost_clp)}</td>
                <td className="mobile-only">
                  <TableMobileCard title={`${x.date} · ${x.account_name}`}>
                    <TableMobileCardRow label={t("taxReturn.usdFx.usd")} value={formatUsdFine(x.usd)} />
                    <TableMobileCardRow label={t("taxReturn.usdFx.costLost")} value={formatClp(x.cost_lost_clp)} />
                  </TableMobileCard>
                </td>
              </tr>
            ))}
          </Table>
          <p>{t("taxReturn.usdFx.feesTotal", { amount: formatClp(f.fees_lost_clp) })}</p>
        </>
      ) : null}
      {f.deferred.length > 0 ? (
        <p className="muted">
          {t("taxReturn.usdFx.deferredTotal", { count: f.deferred.length, amount: formatClp(f.deferred_clp) })}
        </p>
      ) : null}
    </section>
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
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.settlement.colDate")}</th>
        <th className="desktop-only">{t("taxReturn.settlement.colAccount")}</th>
        <th className="desktop-only">{t("taxReturn.settlement.colDescription")}</th>
        <th className="desktop-only num">{t("taxReturn.settlement.colAmount")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <section style={{ margin: "1.5rem 0" }}>
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
        <Table header={header} tableClassName="table--parallel-mobile">
          {s.links.map((l) => (
            <tr key={`${l.kind}-${l.account_id}-${l.occurred_on}-${l.amount}`}>
              <td className="desktop-only mono">{l.occurred_on}</td>
              <td className="desktop-only">{l.account_name ?? "—"}</td>
              <td className="desktop-only">{settlementLinkLabel(t, l)}</td>
              <td className="desktop-only num">{formatClp(l.amount)}</td>
              <td className="mobile-only">
                <TableMobileCard title={l.account_name ? `${l.occurred_on} · ${l.account_name}` : l.occurred_on}>
                  <TableMobileCardRow label={t("taxReturn.settlement.colDescription")} value={settlementLinkLabel(t, l)} />
                  <TableMobileCardRow label={t("taxReturn.settlement.colAmount")} value={formatClp(l.amount)} />
                </TableMobileCard>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </section>
  );
}

function PayrollWithholdingSection({ data }: { data: TaxReturnResponse }) {
  const { t } = useTranslation();
  const w = data.payroll_withholding;
  if (w.payslips === 0) return null;
  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("taxReturn.payroll.colMonth")}</th>
        <th className="desktop-only num">{t("taxReturn.payroll.colWithheld")}</th>
        <th className="desktop-only num">{t("taxReturn.payroll.colTable")}</th>
        <th className="desktop-only num">{t("taxReturn.payroll.colDifference")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  const differs = (d: number) => Math.abs(d) > 1;
  return (
    <section style={{ margin: "1.5rem 0" }}>
      <h2>{t("taxReturn.payroll.title")}</h2>
      <p className="muted">{t("taxReturn.payroll.explain")}</p>
      <p>
        {t("taxReturn.payroll.summary", {
          withheld: formatClp(w.withheld),
          byTable: formatClp(w.by_table),
          difference: formatClp(w.difference),
        })}
      </p>
      <Table header={header} tableClassName="table--parallel-mobile">
        {w.months.map((m) => {
          const label = `${m.period_month}${m.origin === "rebuilt" ? ` (${t("taxReturn.payroll.rebuilt")})` : ""}`;
          const style = differs(m.difference) ? { color: "var(--negative)" } : undefined;
          return (
            <tr key={m.payslip_id}>
              <td className="desktop-only mono">{label}</td>
              <td className="desktop-only num">{formatClp(m.withheld)}</td>
              <td className="desktop-only num">{formatClp(m.by_table)}</td>
              <td className="desktop-only num" style={style}>
                {differs(m.difference) ? formatClp(m.difference) : "—"}
              </td>
              <td className="mobile-only">
                <TableMobileCard title={label}>
                  <TableMobileCardRow label={t("taxReturn.payroll.colWithheld")} value={formatClp(m.withheld)} />
                  <TableMobileCardRow label={t("taxReturn.payroll.colTable")} value={formatClp(m.by_table)} />
                  <TableMobileCardRow
                    label={t("taxReturn.payroll.colDifference")}
                    value={differs(m.difference) ? formatClp(m.difference) : "—"}
                  />
                </TableMobileCard>
              </td>
            </tr>
          );
        })}
      </Table>
    </section>
  );
}

export function TaxReturnPage() {
  const { t } = useTranslation();
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const q = useTaxReturn(taxYear);
  const data = q.data;
  // First load, or the previous year's return held while the chosen year's loads.
  const loading = q.isPending || q.isPlaceholderData;

  return (
    <div className="page">
      <h1>{t("taxReturn.title")}</h1>
      <p className="muted">{t("taxReturn.subtitle")}</p>
      {q.isError ? <p className="error">{(q.error as Error).message}</p> : null}
      {q.isError && !data ? null : (
        <Loadable loading={loading}>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "1rem 0" }}>
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
    </div>
  );
}
