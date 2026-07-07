import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProjectionsChart } from "../components/charts/ProjectionsChart";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatCurrency } from "../format";
import { useProjections } from "../queries/hooks";
import type { ProjectionParams } from "../types";

const LS_KEY = "nw-tracker.projections.overrides";

/** Mirrors the server's PROJECTION_PARAM_BOUNDS (projections.ts) — out-of-range overrides
 * never reach the request; the field shows an inline error instead of a blocking 400. */
const PARAM_BOUNDS: Record<keyof ProjectionParams, [number, number]> = {
  real_return_pct: [-5, 20],
  monthly_aporte_clp: [0, 1_000_000_000],
  inflation_clp_pct: [0, 30],
  inflation_usd_pct: [0, 30],
  retire_return_pct: [-5, 20],
  end_age: [66, 110],
  swr_pct: [0, 25],
  pct_balance_pct: [0, 25],
  monthly_income_clp: [0, 1_000_000_000],
  liquidate_other_pct: [0, 100],
  monthly_rent_clp: [0, 1_000_000_000],
};

function isInBounds(key: keyof ProjectionParams, v: number): boolean {
  const [min, max] = PARAM_BOUNDS[key];
  return v >= min && v <= max;
}

/** Assumption fields in display order; CLP-amount fields get a wider input. */
const PARAM_FIELDS: { key: keyof ProjectionParams; amount?: boolean; step?: number }[] = [
  { key: "real_return_pct", step: 0.5 },
  { key: "monthly_aporte_clp", amount: true },
  { key: "inflation_clp_pct", step: 0.5 },
  { key: "inflation_usd_pct", step: 0.5 },
  { key: "retire_return_pct", step: 0.5 },
  { key: "end_age", step: 1 },
  { key: "swr_pct", step: 0.5 },
  { key: "pct_balance_pct", step: 0.5 },
  { key: "monthly_income_clp", amount: true },
  { key: "liquidate_other_pct", step: 5 },
  { key: "monthly_rent_clp", amount: true },
];

function readStoredOverrides(): Partial<ProjectionParams> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ProjectionParams>;
    return typeof parsed === "object" && parsed != null ? parsed : {};
  } catch {
    return {};
  }
}

export function ProjectionsPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [overrides, setOverrides] = useState<Partial<ProjectionParams>>(readStoredOverrides);
  /** Free-form text while a field is being edited (allows "" mid-edit); committed on change,
   * cleared on blur so the display snaps back to the effective value. */
  const [drafts, setDrafts] = useState<Partial<Record<keyof ProjectionParams, string>>>({});
  // Only in-bounds overrides go to the server; invalid fields show inline errors while the
  // chart keeps rendering with the last valid parameters.
  const validOverrides = useMemo(() => {
    const out: Partial<ProjectionParams> = {};
    for (const [k, v] of Object.entries(overrides) as [keyof ProjectionParams, number][]) {
      if (typeof v === "number" && Number.isFinite(v) && isInBounds(k, v)) out[k] = v;
    }
    return out;
  }, [overrides]);
  const { data, error, isPending } = useProjections(displayUnit, validOverrides);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(overrides));
  }, [overrides]);

  const setParam = (key: keyof ProjectionParams, raw: string) => {
    setDrafts((prev) => ({ ...prev, [key]: raw }));
    setOverrides((prev) => {
      const next = { ...prev };
      if (raw.trim() === "") delete next[key];
      else {
        const n = Number(raw);
        if (Number.isFinite(n)) next[key] = n;
      }
      return next;
    });
  };

  const commitParam = (key: keyof ProjectionParams) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const money = (n: number) => formatCurrency(n, displayUnit);
  const chartPoints = data?.chart.points ?? [];
  const milestoneLines = useMemo(
    () => (data?.chart.lines ?? []).filter((l) => l.dataKey.startsWith("usd_")),
    [data]
  );
  const namedLines = useMemo(
    () => (data?.chart.lines ?? []).filter((l) => !l.dataKey.startsWith("usd_")),
    [data]
  );

  if (isPending && !data) return <p className="muted">{t("common.loading")}</p>;
  if (error) {
    return (
      <main>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }
  if (!data) return null;

  const s = data.summary;

  return (
    <main>
      <h1>{t("projections.title")}</h1>
      <p className="muted">{t("projections.intro", { age: data.retire_age })}</p>

      <div className="flows-filters" style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        {PARAM_FIELDS.map(({ key, amount, step }) => {
          const raw = overrides[key];
          const invalid = raw != null && !isInBounds(key, raw);
          const [min, max] = PARAM_BOUNDS[key];
          return (
            <label key={key} style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
              <span className="muted" style={{ fontSize: "0.8em" }}>
                {t(`projections.params.${key}`)}
              </span>
              <input
                type="number"
                step={step ?? 1}
                min={min}
                max={max}
                size={amount ? 12 : 6}
                style={{
                  width: amount ? "9rem" : "5rem",
                  ...(invalid ? { borderColor: "var(--negative, #ef4444)" } : {}),
                }}
                value={drafts[key] ?? String(raw ?? data.params[key])}
                onChange={(e) => setParam(key, e.target.value)}
                onBlur={() => commitParam(key)}
              />
              {invalid ? (
                <span className="error" style={{ fontSize: "0.75em" }}>
                  {t("projections.invalidRange", { min, max })}
                </span>
              ) : null}
            </label>
          );
        })}
        <button
          type="button"
          style={{ alignSelf: "flex-end" }}
          disabled={Object.keys(overrides).length === 0}
          onClick={() => {
            setOverrides({});
            setDrafts({});
          }}
        >
          {t("projections.reset")}
        </button>
      </div>

      <section style={{ margin: "1rem 0" }}>
        <p>
          <strong>{t("projections.summary.balanceAtRetire", { age: data.retire_age })}:</strong>{" "}
          {t("projections.summary.investedLabel")} {money(s.invested_at_retire)} ·{" "}
          {t("projections.summary.totalLabel")} {money(s.total_at_retire)}{" "}
          <span className="muted">
            ({t("projections.summary.todaysMoney")};{" "}
            {t("projections.summary.potDescription", {
              pot: money(s.balance_at_retire),
              pct: validOverrides.liquidate_other_pct ?? data.params.liquidate_other_pct,
            })}
            )
          </span>
        </p>
        {s.monthly_rent > 0 ? (
          <p className="muted">{t("projections.summary.rentIncluded", { amount: money(s.monthly_rent) })}</p>
        ) : null}
        <p>
          <strong>{t("projections.summary.swr", { pct: validOverrides.swr_pct ?? data.params.swr_pct })}:</strong>{" "}
          {t("projections.summary.income", { amount: money(s.swr_monthly_income) })}{" "}
          {s.swr_depletion_age != null ? (
            <span className="error">{t("projections.summary.depletes", { age: s.swr_depletion_age })}</span>
          ) : (
            <span className="muted">{t("projections.summary.lasts", { age: validOverrides.end_age ?? data.params.end_age })}</span>
          )}
        </p>
        <p>
          <strong>
            {t("projections.summary.pctBalance", { pct: validOverrides.pct_balance_pct ?? data.params.pct_balance_pct })}:
          </strong>{" "}
          {t("projections.summary.initialIncome", { amount: money(s.pct_balance_initial_monthly_income) })}{" "}
          <span className="muted">{t("projections.summary.neverDepletes")}</span>
        </p>
        <p>
          <strong>{t("projections.summary.fixedIncome")}:</strong>{" "}
          {t("projections.summary.income", { amount: money(s.fixed_monthly_income) })}{" "}
          {s.fixed_income_depletion_age != null ? (
            <span className="error">
              {t("projections.summary.depletes", { age: s.fixed_income_depletion_age })}
            </span>
          ) : (
            <span className="muted">{t("projections.summary.lasts", { age: validOverrides.end_age ?? data.params.end_age })}</span>
          )}
        </p>
      </section>

      <div style={{ width: "100%", height: 420 }}>
        <ProjectionsChart
          points={chartPoints}
          namedLines={namedLines}
          milestoneLines={milestoneLines}
          displayUnit={displayUnit}
        />
      </div>
      <p className="muted" style={{ fontSize: "0.85em" }}>
        {t("projections.footnote", { fx: Math.round(data.fx_clp_per_usd) })}
      </p>
    </main>
  );
}
