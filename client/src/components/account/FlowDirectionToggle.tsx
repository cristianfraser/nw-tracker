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
            style={{
              flex: 1,
              padding: "0.4rem 0.5rem",
              borderRadius: 6,
              border: "1px solid var(--border-subtle, #333)",
              background: active ? "var(--accent-soft, #2b3a55)" : "transparent",
              color: active ? "var(--text, #fff)" : "var(--text-muted, #aaa)",
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
