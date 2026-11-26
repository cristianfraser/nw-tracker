import { useEffect, useId, useState } from "react";
import { Button } from "@crfrsr/ui";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatGroupedDecimalTrimmed, formatMoney, formatNumberInput, parseNumberInput } from "../../format";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import { PageGridTile } from "../layout/PageGridTile";
import { loadableClass } from "../ui/Loadable";
import {
  projectionFieldBounds,
  projectionFieldInBounds,
  projectionFieldKey,
  projectionFieldValue,
  type ProjectionField,
  type ProjectionFieldGroup,
} from "../../projectionsFields";
import type { ProjectionOverrides } from "../../projectionsOverrides";
import type { ProjectionParams } from "../../types";
import form from "../panel/PanelForm.module.css";
import styles from "./ProjectionsAssumptions.module.css";

function pct(n: number | undefined): string {
  return n == null ? "—" : `${formatGroupedDecimalTrimmed(n)}%`;
}

/**
 * The /projections inputs, in the settings forms' layout (a label over each control), in three
 * groups: growth to retirement, inflation, drawdown. From 880 the groups sit side by side, open;
 * below it each is a line that reads its current values and opens in place (a group holding a
 * rejected value stays open).
 */
export function ProjectionsAssumptions({
  groups,
  overrides,
  drafts,
  params,
  paramsUnit,
  displayUnit,
  retireAge,
  inflationDefaults,
  loading,
  onChange,
  onBlur,
  onReset,
}: {
  groups: readonly ProjectionFieldGroup[];
  overrides: ProjectionOverrides;
  /** Free text of the fields being edited, by field key. */
  drafts: Readonly<Record<string, string>>;
  /** The server's echo (undefined until the first response). */
  params: ProjectionParams | undefined;
  /** The unit `params` is in (a held response of another unit keeps its own). */
  paramsUnit: string;
  displayUnit: string;
  retireAge: number | undefined;
  /** The default inflation per currency, named as assumptions under the inflation fields. */
  inflationDefaults: Readonly<Record<string, number>> | undefined;
  /** The first response is pending: the form is inert. */
  loading: boolean;
  onChange: (field: ProjectionField, raw: string) => void;
  onBlur: (field: ProjectionField) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const narrow = useIsNarrowViewport();
  const baseId = useId();
  const [opened, setOpened] = useState<Readonly<Record<string, boolean>>>({});
  const unitCode = displayUnit.toUpperCase();
  const age = retireAge ?? "";

  const valueOf = (f: ProjectionField) => projectionFieldValue(f, overrides, displayUnit, params);
  const fieldError = (f: ProjectionField): string | null => {
    const key = projectionFieldKey(f);
    const draft = drafts[key];
    const parsed = draft != null ? parseNumberInput(draft) : null;
    if (parsed != null && !parsed.ok) return parsed.message;
    const raw = overrides[key];
    if (typeof raw === "number" && !projectionFieldInBounds(f, raw)) {
      const [min, max] = projectionFieldBounds(f);
      return t("projections.invalidRange", { min, max });
    }
    return null;
  };
  const fieldLabel = (f: ProjectionField): string => {
    if (f.kind === "inflation") return t("projections.fields.inflation_pct", { code: f.code.toUpperCase() });
    return t(`projections.fields.${f.key}`, { unit: unitCode, age });
  };
  /** A closed group's line: its current values. */
  const summary = (group: ProjectionFieldGroup): string => {
    const num = (key: string) => {
      const f = group.fields.find((x) => projectionFieldKey(x) === key);
      return f ? valueOf(f) : undefined;
    };
    const money = (key: string) => {
      const v = num(key);
      if (v == null) return "—";
      // An override typed here is in the unit on screen; an echo is in the response's.
      const f = group.fields.find((x) => projectionFieldKey(x) === key);
      const typedHere = f != null && typeof overrides[key] === "number" && valueOf(f) === overrides[key];
      return formatMoney({ value: v, currency: typedHere ? displayUnit : paramsUnit });
    };
    switch (group.id) {
      case "growth":
        return t("projections.groupSummary.growth", { pct: pct(num("real_return_pct")), amount: money("monthly_aporte") });
      case "inflation":
        return group.fields
          .map((f) => (f.kind === "inflation" ? `${f.code.toUpperCase()} ${pct(valueOf(f))}` : ""))
          .join(" · ");
      case "drawdown":
        return t("projections.groupSummary.drawdown", {
          pct: pct(num("retire_return_pct")),
          age: num("end_age") ?? "—",
          swr: pct(num("swr_pct")),
          balance: pct(num("pct_balance_pct")),
        });
    }
  };

  // A group a rejected value opened stays open once the value is fixed: closing it would take
  // the field away mid-typing.
  const errorGroups = groups.filter((g) => g.fields.some((f) => fieldError(f) != null)).map((g) => g.id).join(",");
  useEffect(() => {
    if (errorGroups === "") return;
    setOpened((prev) => {
      const next = { ...prev };
      for (const id of errorGroups.split(",")) next[id] = true;
      return next;
    });
  }, [errorGroups]);

  return (
    <PageGridTile id="assumptions" className={cn("page-grid", styles.tile)}>
      <div className={styles.head}>
        <h2>{t("projections.assumptions")}</h2>
        <Button variant="secondary" disabled={Object.keys(overrides).length === 0} onClick={onReset}>
          {t("projections.reset")}
        </Button>
      </div>
      {groups.map((group) => {
        const hasError = group.fields.some((f) => fieldError(f) != null);
        const open = !narrow || hasError || (opened[group.id] ?? false);
        const bodyId = `${baseId}-${group.id}`;
        const title = t(`projections.groups.${group.id}`, { age });
        return (
          <section key={group.id} className={styles.group} aria-labelledby={`${bodyId}-title`}>
            {narrow ? (
              <h3 id={`${bodyId}-title`} className={styles.groupTitle}>
                <button
                  type="button"
                  className={styles.toggle}
                  aria-expanded={open}
                  aria-controls={bodyId}
                  // A rejected value keeps its group open: closing would hide the message.
                  disabled={hasError}
                  onClick={() => setOpened((prev) => ({ ...prev, [group.id]: !open }))}
                >
                  <span className={styles.toggleTitle}>{title}</span>
                  {open ? null : <span className={styles.summary}>{summary(group)}</span>}
                  <span className={styles.chevron} aria-hidden="true">
                    {open ? "⌄" : "›"}
                  </span>
                </button>
              </h3>
            ) : (
              <h3 id={`${bodyId}-title`} className={styles.groupTitle}>
                {title}
              </h3>
            )}
            <div id={bodyId} hidden={!open} className={loadableClass(loading, form.form, styles.form)}>
              {group.fields.map((f) => {
                const key = projectionFieldKey(f);
                const error = fieldError(f);
                const value = valueOf(f);
                const [min] = projectionFieldBounds(f);
                const errorId = `${bodyId}-${key}-error`;
                return (
                  <label key={key} className={cn(form.field, f.kind !== "money" && key !== "liquidate_other_pct" && form.fieldNarrow)}>
                    <span className="muted">{fieldLabel(f)}</span>
                    <input
                      type="text"
                      // The decimal keypad has no minus key; fields that allow negatives keep the full one.
                      inputMode={min < 0 ? undefined : "decimal"}
                      aria-invalid={error != null || undefined}
                      aria-describedby={error != null ? errorId : undefined}
                      value={drafts[key] ?? (value != null ? formatNumberInput(value) : "")}
                      onChange={(e) => onChange(f, e.target.value)}
                      onBlur={() => onBlur(f)}
                    />
                    {error != null ? (
                      <span id={errorId} className={cn("error", styles.fieldError)}>
                        {error}
                      </span>
                    ) : null}
                  </label>
                );
              })}
              {group.id === "inflation" && inflationDefaults ? (
                <p className={cn(form.line, "muted", styles.hint)}>
                  {t("projections.hints.inflation", {
                    list: Object.entries(inflationDefaults)
                      .map(([code, v]) => `${code.toUpperCase()} ${pct(v)}`)
                      .join(" · "),
                  })}
                </p>
              ) : null}
              {group.id === "drawdown" ? <p className={cn(form.line, "muted", styles.hint)}>{t("projections.hints.fixedIncome")}</p> : null}
            </div>
          </section>
        );
      })}
    </PageGridTile>
  );
}
