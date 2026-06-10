import type { ReactNode } from "react";

export function TableMobileCardRow({
  label,
  value,
  truncateValue,
  valueTitle,
}: {
  label: string;
  value: ReactNode;
  /** Ellipsis long single-line values (e.g. account names). */
  truncateValue?: boolean;
  valueTitle?: string;
}) {
  return (
    <div
      className={[
        "table-mobile-card__row",
        truncateValue ? "table-mobile-card__row--truncate-value" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="table-mobile-card__label">{label}</span>
      <span
        className={[
          "table-mobile-card__value",
          truncateValue ? "table-mobile-card__value--truncate" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={valueTitle}
      >
        {value}
      </span>
    </div>
  );
}

export function TableMobileCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="table-mobile-card">
      <div className="table-mobile-card__title">{title}</div>
      {children}
    </div>
  );
}

export function TableMobileCardSection({ children }: { children: ReactNode }) {
  return <div className="table-mobile-card__section">{children}</div>;
}
