import type { GroupGlanceRowDto } from "../../types";

type RowShape = Pick<GroupGlanceRowDto, "kind"> & { members?: readonly RowShape[] };

/**
 * A child row starts open while it holds something and every row under it is a group (a group of
 * groups); one holding accounts — a basket, a leaf group, a group mixing accounts and sub-groups —
 * or a sold-out one starts closed. Same rule as the accounts tree: the rows a liquidated row folds
 * count as if they stood in the list (folded accounts keep the group closed), though a list of
 * nothing but the liquidated row never opens. A liquidated row itself starts closed (it holds nothing).
 */
export function openByDefault(row: Pick<GroupGlanceRowDto, "held"> & { members: readonly RowShape[] }): boolean {
  const listed = row.members.flatMap((m) => (m.kind === "liquidated" ? (m.members ?? []) : [m]));
  return (
    row.held && row.members.some((m) => m.kind !== "liquidated") && listed.every((m) => m.kind === "group")
  );
}

/** A row's key among its siblings (and, joined along its path, of its stored open / closed choice). */
export function rowKey(row: Pick<GroupGlanceRowDto, "kind" | "slug" | "account_id">): string {
  if (row.kind === "account") return `a:${row.account_id}`;
  if (row.kind === "group") return `g:${row.slug}`;
  // A liquidated row is keyed by the group whose list it folds.
  return row.kind === "liquidated" ? `l:${row.slug}` : `c:${row.slug}`;
}
