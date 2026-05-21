import type { ReactNode } from "react";
import { cn } from "../cn";

export function HierarchyNavRow({
  depth,
  isGroup,
  nameCell,
  categoryCell,
  groupCell,
  notesCell,
}: {
  depth: number;
  isGroup: boolean;
  nameCell: ReactNode;
  categoryCell: ReactNode;
  groupCell: ReactNode;
  notesCell: ReactNode;
}) {
  const pad = `calc(var(--space-sm) + ${depth} * var(--space-lg))`;
  return (
    <tr className={cn(isGroup && "hierarchy-nav-group", !isGroup && "hierarchy-nav-leaf")}>
      <td
        style={{
          paddingLeft: pad,
          boxShadow: depth >= 1 && !isGroup ? "inset 3px 0 0 var(--border)" : undefined,
        }}
      >
        {nameCell}
      </td>
      <td>{categoryCell}</td>
      <td className="muted">{groupCell}</td>
      <td className="muted">{notesCell}</td>
    </tr>
  );
}
