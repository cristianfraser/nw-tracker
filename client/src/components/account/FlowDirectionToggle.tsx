import { useTranslation } from "react-i18next";

export type FlowDirection = "in" | "out";

/**
 * Explicit Ingreso / Retiro toggle for manual flows. Direction is chosen here — the amount is
 * always entered as a positive magnitude — so the sign/`counterpart_role` is never inferred from
 * the number the user typed.
 */
export function FlowDirectionToggle({
  value,
  onChange,
}: {
  value: FlowDirection;
  onChange: (next: FlowDirection) => void;
}) {
  const { t } = useTranslation();
  const options: { key: FlowDirection; label: string }[] = [
    { key: "in", label: t("accountDetail.flowDirection.in") },
    { key: "out", label: t("accountDetail.flowDirection.out") },
  ];
  return (
    <div role="radiogroup" style={{ display: "flex", gap: "0.25rem" }}>
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.key)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
