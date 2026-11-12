import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageGridTile } from "../components/layout/PageGridTile";
import { ProjectionsChart } from "../components/charts/ProjectionsChart";
import { Loadable, loadableClass } from "../components/ui/Loadable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatCurrency, formatNumberInput, formatPct, parseNumberInput } from "../format";
import { useCurrencies, useProjections } from "../queries/hooks";
import {
  projectionInflationKey,
  projectionMoneyCurrencyKey,
  readStoredProjectionOverrides,
  writeStoredProjectionOverrides,
  type ProjectionMoneyKey,
  type ProjectionOverrides,
} from "../projectionsOverrides";
import type { ProjectionParams, ProjectionsResponse } from "../types";
import { Button, Field, Input } from "@crfrsr/ui";

/** The plain numeric inputs (no currency), mirroring the server's bounds (projections.ts). */
const NUMBER_BOUNDS = {
  real_return_pct: [-5, 20],
  retire_return_pct: [-5, 20],
  end_age: [66, 110],
  swr_pct: [0, 25],
  pct_balance_pct: [0, 25],
  liquidate_other_pct: [0, 100],
} as const;
type NumberKey = keyof typeof NUMBER_BOUNDS;
const MONEY_BOUNDS: readonly [number, number] = [0, 1_000_000_000];
const INFLATION_BOUNDS: readonly [number, number] = [0, 30];

/** One form field: its request key, how it reads the server's echo and its bounds. */
type FieldSpec =
  | { kind: "number"; key: NumberKey }
  | { kind: "money"; key: ProjectionMoneyKey }
  | { kind: "inflation"; code: string };

function fieldKey(f: FieldSpec): string {
  return f.kind === "inflation" ? projectionInflationKey(f.code) : f.key;
}

function fieldBounds(f: FieldSpec): readonly [number, number] {
  if (f.kind === "number") return NUMBER_BOUNDS[f.key];
  return f.kind === "money" ? MONEY_BOUNDS : INFLATION_BOUNDS;
}

function isInBounds(f: FieldSpec, v: number): boolean {
  const [min, max] = fieldBounds(f);
  return v >= min && v <= max;
}

/** Assumption fields in display order; one inflation field per core currency. */
function fieldSpecs(inflationCodes: readonly string[]): FieldSpec[] {
  return [
    { kind: "number", key: "real_return_pct" },
    { kind: "money", key: "monthly_aporte" },
    ...inflationCodes.map((code): FieldSpec => ({ kind: "inflation", code })),
    { kind: "number", key: "retire_return_pct" },
    { kind: "number", key: "end_age" },
    { kind: "number", key: "swr_pct" },
    { kind: "number", key: "pct_balance_pct" },
    { kind: "money", key: "monthly_income" },
    { kind: "number", key: "liquidate_other_pct" },
    { kind: "money", key: "monthly_rent" },
  ];
}

/** Summary figures while the first load has nothing to show: zeros, dimmed, never a guess. */
const EMPTY_SUMMARY: ProjectionsResponse["summary"] = {
  balance_at_retire: 0,
  invested_at_retire: 0,
  total_at_retire: 0,
  monthly_rent: 0,
  swr_monthly_income: 0,
  pct_balance_initial_monthly_income: 0,
  fixed_monthly_income: 0,
  swr_depletion_age: null,
  fixed_income_depletion_age: null,
};

/** The server's echo of a field, in the response's unit. */
function echoedValue(f: FieldSpec, params: ProjectionParams | undefined): number | undefined {
  if (!params) return undefined;
  if (f.kind === "inflation") return params.inflation_pct[f.code];
  return params[f.key];
}

export function ProjectionsPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { data: currencies } = useCurrencies();
  const [overrides, setOverrides] = useState<ProjectionOverrides>(() => readStoredProjectionOverrides(localStorage));
  /** Free-form text while a field is being edited (allows "" mid-edit); committed on change,
   * cleared on blur so the display snaps back to the effective value. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const inflationCodes = useMemo(() => {
    const core = currencies?.currencies.filter((c) => c.tier === "core").map((c) => c.code);
    return core && core.length > 0 ? core : [displayUnit];
  }, [currencies, displayUnit]);
  const fields = useMemo(() => fieldSpecs(inflationCodes), [inflationCodes]);

  // Only in-bounds overrides go to the server; invalid fields show inline errors while the
  // chart keeps rendering with the last valid parameters.
  const validOverrides = useMemo(() => {
    const out: ProjectionOverrides = {};
    for (const f of fields) {
      const key = fieldKey(f);
      const v = overrides[key];
      if (typeof v !== "number" || !Number.isFinite(v) || !isInBounds(f, v)) continue;
      out[key] = v;
      if (f.kind === "money") {
        const ck = projectionMoneyCurrencyKey(f.key);
        const c = overrides[ck];
        if (typeof c === "string") out[ck] = c;
      }
    }
    return out;
  }, [overrides, fields]);
  const { data, error, isPending } = useProjections(displayUnit, validOverrides);
  // The form is inert only until the first response (an edit keeps the previous data on screen);
  // the summary and chart also dim while the other display unit's numbers are held.
  const resultsLoading = isPending || (data != null && data.unit !== displayUnit);

  useEffect(() => {
    writeStoredProjectionOverrides(localStorage, overrides);
  }, [overrides]);

  const setParam = (f: FieldSpec, raw: string) => {
    const key = fieldKey(f);
    setDrafts((prev) => ({ ...prev, [key]: raw }));
    // A draft that isn't a number keeps the last override and shows its message (see render).
    const parsed = parseNumberInput(raw);
    if (!parsed.ok) return;
    setOverrides((prev) => {
      const next = { ...prev };
      const currencyKey = f.kind === "money" ? projectionMoneyCurrencyKey(f.key) : null;
      if (parsed.value == null) {
        delete next[key];
        if (currencyKey) delete next[currencyKey];
      } else {
        next[key] = parsed.value;
        // A money input is typed in the unit on screen.
        if (currencyKey) next[currencyKey] = displayUnit;
      }
      return next;
    });
  };

  const commitParam = (f: FieldSpec) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[fieldKey(f)];
      return next;
    });
  };

  /** What a field shows when not being edited: an override typed in this unit, else the server's echo. */
  const effectiveValue = (f: FieldSpec): number | undefined => {
    const raw = overrides[fieldKey(f)];
    const typedHere =
      f.kind !== "money" || overrides[projectionMoneyCurrencyKey(f.key)] === displayUnit;
    if (typeof raw === "number" && typedHere) return raw;
    // A held response of another unit shows its echo dimmed until this unit's arrives.
    return echoedValue(f, data?.params);
  };

  const fieldLabel = (f: FieldSpec): string => {
    if (f.kind === "inflation") return t("projections.params.inflation_pct", { code: f.code.toUpperCase() });
    if (f.kind === "money") return t(`projections.params.${f.key}`, { unit: displayUnit.toUpperCase() });
    return t(`projections.params.${f.key}`);
  };

  const inflationDefaults = data?.inflation_default_pct;
  const inflationAssumption = inflationDefaults
    ? Object.entries(inflationDefaults)
        .map(([code, pct]) => `${code.toUpperCase()} ${formatPct(pct, 1)}`)
        .join(" · ")
    : null;

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

  if (error) {
    return (
      <main>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }

  const s = data?.summary ?? EMPTY_SUMMARY;

  return (
    <main>
      <h1>{t("projections.title")}</h1>

      {/* Row gap leaves room for a Field's error, which overlays rather than
          reflowing the form when a value goes out of bounds. */}
      <Loadable
        loading={isPending}
        className="flows-filters"
        style={{ display: "flex", flexWrap: "wrap", columnGap: "0.75rem", rowGap: "2.5rem" }}
      >
        {fields.map((f) => {
          const key = fieldKey(f);
          const raw = overrides[key];
          const invalid = typeof raw === "number" && !isInBounds(f, raw);
          const [min, max] = fieldBounds(f);
          const draft = drafts[key];
          const draftParsed = draft != null ? parseNumberInput(draft) : null;
          const draftError = draftParsed != null && !draftParsed.ok ? draftParsed.message : null;
          const effective = effectiveValue(f);
          return (
            <Field
              key={key}
              label={fieldLabel(f)}
              error={
                draftError ?? (invalid ? t("projections.invalidRange", { min, max }) : undefined)
              }
            >
              <Input
                type="text"
                // The decimal keypad has no minus key; fields that allow negatives keep the full one.
                inputMode={min < 0 ? undefined : "decimal"}
                aria-invalid={draftError != null || invalid || undefined}
                value={draft ?? (effective != null ? formatNumberInput(effective) : "")}
                onChange={(e) => setParam(f, e.target.value)}
                onBlur={() => commitParam(f)}
              />
            </Field>
          );
        })}
        <div style={{ alignSelf: "flex-end" }}>
          <Button variant="secondary"
            disabled={Object.keys(overrides).length === 0}
            onClick={() => {
              setOverrides({});
              setDrafts({});
            }}
          >
            {t("projections.reset")}
          </Button>
        </div>
      </Loadable>
      {inflationAssumption ? (
        <p className="muted">{t("projections.inflationAssumption", { list: inflationAssumption })}</p>
      ) : null}

      <PageGridTile id="summary" className={loadableClass(resultsLoading)}>
        <p>
          <strong>{t("projections.summary.balanceAtRetire", { age: data?.retire_age ?? "—" })}:</strong>{" "}
          {t("projections.summary.investedLabel")} {money(s.invested_at_retire)} ·{" "}
          {t("projections.summary.totalLabel")} {money(s.total_at_retire)}{" "}
          <span className="muted">
            ({t("projections.summary.todaysMoney")};{" "}
            {t("projections.summary.potDescription", {
              pot: money(s.balance_at_retire),
              pct: validOverrides.liquidate_other_pct ?? data?.params.liquidate_other_pct ?? "—",
            })}
            )
          </span>
        </p>
        {s.monthly_rent > 0 ? (
          <p className="muted">{t("projections.summary.rentIncluded", { amount: money(s.monthly_rent) })}</p>
        ) : null}
        <p>
          <strong>{t("projections.summary.swr", { pct: validOverrides.swr_pct ?? data?.params.swr_pct ?? "—" })}:</strong>{" "}
          {t("projections.summary.income", { amount: money(s.swr_monthly_income) })}{" "}
          {s.swr_depletion_age != null ? (
            <span className="error">{t("projections.summary.depletes", { age: s.swr_depletion_age })}</span>
          ) : (
            <span className="muted">{t("projections.summary.lasts", { age: validOverrides.end_age ?? data?.params.end_age ?? "—" })}</span>
          )}
        </p>
        <p>
          <strong>
            {t("projections.summary.pctBalance", { pct: validOverrides.pct_balance_pct ?? data?.params.pct_balance_pct ?? "—" })}:
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
            <span className="muted">{t("projections.summary.lasts", { age: validOverrides.end_age ?? data?.params.end_age ?? "—" })}</span>
          )}
        </p>
      </PageGridTile>

      <Loadable loading={resultsLoading} style={{ width: "100%", height: 420 }}>
        <ProjectionsChart
          points={chartPoints}
          namedLines={namedLines}
          milestoneLines={milestoneLines}
          displayUnit={displayUnit}
          loading={resultsLoading}
        />
      </Loadable>
    </main>
  );
}
