import { useState, type ReactNode } from "react";
import { Button } from "@crfrsr/ui";
import { useTranslation } from "react-i18next";
import { Loadable } from "../components/ui/Loadable";
import { useTaxReturn, useUsTaxReturn } from "../queries/hooks";
import { F22ReturnSections } from "../components/tax/F22ReturnSections";
import { UsTaxReturnSections } from "../components/tax/UsTaxReturnSections";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import formStyles from "../components/panel/PanelForm.module.css";
import styles from "../components/tax/TaxRows.module.css";

type Jurisdiction = "cl" | "us";

const JURISDICTIONS: readonly Jurisdiction[] = ["cl", "us"];

/**
 * `/tax-return`: a tax year's return as figures first (filed, draft, difference, settlement), the
 * form's codes against their sources, and the detail behind them as folded sections. The year and,
 * for a year that also has a US return, the return (F22 / Form 1040) are picked in the header.
 */
export function TaxReturnPage() {
  const { t } = useTranslation();
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const [chosenJurisdiction, setJurisdiction] = useState<Jurisdiction>("cl");
  const q = useTaxReturn(taxYear);
  const data = q.data;
  // The US return only exists for a year with a 1040; another year shows the F22.
  const usTaxYear = data?.us_tax_year ?? null;
  const jurisdiction: Jurisdiction = usTaxYear != null ? chosenJurisdiction : "cl";
  const usQ = useUsTaxReturn(jurisdiction === "us" ? usTaxYear : null);
  // First load, or the previous year's return held while the chosen year's loads.
  const loading = queryShowsLoading(q);
  const usLoading = queryShowsLoading(usQ);

  const controls: ReactNode = (
    <div className={formStyles.form}>
      <label className={formStyles.field}>
        <span className="muted">{t("taxReturn.taxYearLabel")}</span>
        <select value={taxYear ?? data?.tax_year ?? ""} disabled={loading} onChange={(e) => setTaxYear(Number(e.target.value))}>
          {(data?.available_tax_years ?? []).map((y) => (
            <option key={y} value={y}>
              {t("taxReturn.taxYearOption", { year: y, income: y - 1 })}
            </option>
          ))}
        </select>
      </label>
      {usTaxYear != null ? (
        <div className={styles.returnField}>
          <span className="muted" id="tax-return-switch">
            {t("taxReturn.us.tabsLabel")}
          </span>
          <div className={`surface-controls ${styles.returnSwitch}`}>
            <span className="surface-controls__set" role="group" aria-labelledby="tax-return-switch">
              {JURISDICTIONS.map((j) => (
                <button
                  key={j}
                  type="button"
                  className={j === jurisdiction ? "is-on" : undefined}
                  aria-pressed={j === jurisdiction}
                  disabled={loading}
                  onClick={() => setJurisdiction(j)}
                >
                  {t(j === "cl" ? "taxReturn.us.tabChile" : "taxReturn.us.tabUs")}
                </button>
              ))}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <main>
      <h1>{t("taxReturn.title")}</h1>
      {queryLoadError(q) ? (
        <>
          <p className="error">{(q.error as Error).message}</p>
          {/* The picker needs a loaded year: a chosen year that fails leaves a way back to the default one. */}
          {taxYear != null ? (
            <p>
              <Button variant="secondary" onClick={() => setTaxYear(null)}>
                {t("taxReturn.backToDefaultYear")}
              </Button>
            </p>
          ) : null}
        </>
      ) : null}
      {jurisdiction === "us" && queryLoadError(usQ) ? <p className="error">{(usQ.error as Error).message}</p> : null}
      {queryLoadError(q) ? null : (
        <Loadable loading={loading} className="page-grid">
          {jurisdiction === "us" ? (
            <UsTaxReturnSections data={queryLoadError(usQ) ? undefined : usQ.data} loading={usLoading} failed={queryLoadError(usQ) != null} controls={controls} />
          ) : (
            <F22ReturnSections data={data} loading={loading} controls={controls} />
          )}
        </Loadable>
      )}
    </main>
  );
}
