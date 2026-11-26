import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatCurrency, formatMoney } from "../../format";
import { pct1, pct1Signed, signedMoney, toneOf } from "../depto/deptoFormat";
import depto from "../depto/Depto.module.css";
import styles from "./RealEstateGroup.module.css";
import type { RealEstateGroupGlanceDto, RealEstateGroupPropertyDto } from "../../types";

/** A share as a percent: signed only when negative, as the depto header prints it. */
function pctLoose(share: number): string {
  return share < 0 ? pct1Signed(share) : pct1(share);
}

function PropertyRow({ property, unit }: { property: RealEstateGroupPropertyDto; unit: string }) {
  const { t } = useTranslation();
  const showUnit = property.loan_currency !== unit;
  const cell = (key: "day" | "month" | "year" | "total", className: string | undefined, pct: number | null) => {
    const value = property.strip[key];
    return (
      <span className={cn("mono", styles.r, className)}>
        <em className={styles.lbl}>{t(`accountDetail.depto.${key}`)} </em>
        {value != null ? <span className={depto[toneOf(value) ?? "muted"]}>{signedMoney(value, unit)}</span> : <span className={depto.muted}>—</span>}
        {pct != null ? (
          <>
            {" "}
            <span className={styles.pct}>{pctLoose(pct)}</span>
          </>
        ) : null}
      </span>
    );
  };
  return (
    <li className={styles.row}>
      <span className={cn(styles.name, styles.cName)}>
        <i className={styles.sw} style={{ background: `rgb(${property.color_rgb})` }} />
        <Link to={`/account/${property.account_id}`}>{property.name}</Link>
      </span>
      <span className={cn("mono", styles.r, styles.cEquity)}>
        {/* Beside the name at every width: named to a screen reader only. */}
        <span className="visually-hidden">{t("realEstate.group.colEquity")} </span>
        <b>{formatCurrency(property.equity_loan, property.loan_currency)}</b>
        {showUnit ? <span className={styles.sub}>{formatMoney({ value: property.equity, currency: unit })}</span> : null}
      </span>
      <span className={cn("mono", styles.r, styles.cOwned)}>
        <em className={styles.lbl}>{t("realEstate.group.colOwned")} </em>
        {pct1(property.owned_share)}
        <span className={styles.sub}>
          {property.owed_loan > 0
            ? t("realEstate.group.ownedOf", { appraisal: formatCurrency(property.appraisal_loan, property.loan_currency) })
            : t("realEstate.group.noLoan")}
        </span>
      </span>
      {cell("day", styles.cDay, null)}
      {cell("month", styles.cMonth, null)}
      {cell("year", styles.cYear, property.strip.year_pct)}
      {cell("total", styles.cTotal, property.strip.total_pct)}
    </li>
  );
}

/**
 * The real-estate group's property list (`real-estate-glance`, several properties): a row per
 * property carrying what its own page opens with — net equity in its loan currency with the unit
 * under it, the share of the appraisal it owns, día / mes / año / total — linking to that page; its
 * swatch is its layer of the value chart. A property with no ledger is listed without figures.
 */
export function RealEstatePropertyList({ glance }: { glance: RealEstateGroupGlanceDto }) {
  const { t } = useTranslation();
  return (
    <ul className={styles.list} aria-label={t("realEstate.group.propertiesLabel")}>
      {/* The column names, only over rows that carry figures. */}
      {glance.several ? (
        <li className={cn(styles.row, styles.head)} aria-hidden="true">
          <span>{t("realEstate.group.colProperty")}</span>
          <span className={styles.r}>{t("realEstate.group.colEquity")}</span>
          <span className={styles.r}>{t("realEstate.group.colOwned")}</span>
          <span className={styles.r}>{t("accountDetail.depto.day")}</span>
          <span className={styles.r}>{t("accountDetail.depto.month")}</span>
          <span className={styles.r}>{t("accountDetail.depto.year")}</span>
          <span className={styles.r}>{t("accountDetail.depto.total")}</span>
        </li>
      ) : null}
      {glance.several?.properties.map((p) => <PropertyRow key={p.account_id} property={p} unit={glance.unit} />)}
      {glance.properties_without_ledger.map((p) => (
        <li key={p.account_id} className={cn(styles.row, styles.rowEmpty)}>
          <span className={styles.name}>
            <Link to={`/account/${p.account_id}`}>{p.name}</Link>
          </span>
          <span className={styles.empty}>{t("realEstate.group.noLedger")}</span>
        </li>
      ))}
    </ul>
  );
}
