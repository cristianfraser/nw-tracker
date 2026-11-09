import { useTranslation } from "../../i18n";
import { formatNumberInput, parseNumberInputOrThrow } from "../../format";
import { Field, Input } from "@crfrsr/ui";

/** The DFL-2 declaration as typed: the flag, the built area and the building's reception year. */
export type Dfl2Draft = { dfl2: boolean; builtM2: string; receptionYear: string };

export const EMPTY_DFL2_DRAFT: Dfl2Draft = { dfl2: false, builtM2: "", receptionYear: "" };

export function dfl2DraftFromPlace(p: {
  dfl2: boolean;
  dfl2_built_m2: number | null;
  dfl2_reception_year: number | null;
}): Dfl2Draft {
  return {
    dfl2: p.dfl2,
    builtM2: p.dfl2_built_m2 == null ? "" : formatNumberInput(p.dfl2_built_m2),
    receptionYear: p.dfl2_reception_year == null ? "" : String(p.dfl2_reception_year),
  };
}

/**
 * The declaration as the API takes it; throws on a typed number the app cannot read (the server
 * checks the rest: both fields with the flag, at most 140 m²).
 */
export function dfl2BodyFromDraft(d: Dfl2Draft): {
  dfl2: boolean;
  dfl2_built_m2: number | null;
  dfl2_reception_year: number | null;
} {
  if (!d.dfl2) return { dfl2: false, dfl2_built_m2: null, dfl2_reception_year: null };
  return {
    dfl2: true,
    dfl2_built_m2: parseNumberInputOrThrow(d.builtM2),
    dfl2_reception_year: parseNumberInputOrThrow(d.receptionYear),
  };
}

/** The DFL-2 inputs of the place forms (add and edit). */
export function RealEstateDfl2Fields({ value, onChange }: { value: Dfl2Draft; onChange: (next: Dfl2Draft) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <label className="radio-pill" style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
        <input type="checkbox" checked={value.dfl2} onChange={(e) => onChange({ ...value, dfl2: e.target.checked })} />
        {t("expenses.realEstate.dfl2Field")}
      </label>
      {value.dfl2 ? (
        <>
          <p className="muted">{t("expenses.realEstate.dfl2Explain")}</p>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <Field label={t("expenses.realEstate.dfl2BuiltM2Field")} style={{ flex: 1 }}>
              <Input
                type="text"
                inputMode="decimal"
                value={value.builtM2}
                onChange={(e) => onChange({ ...value, builtM2: e.target.value })}
              />
            </Field>
            <Field label={t("expenses.realEstate.dfl2ReceptionYearField")} style={{ flex: 1 }}>
              <Input
                type="text"
                inputMode="numeric"
                value={value.receptionYear}
                onChange={(e) => onChange({ ...value, receptionYear: e.target.value })}
              />
            </Field>
          </div>
        </>
      ) : null}
    </>
  );
}
