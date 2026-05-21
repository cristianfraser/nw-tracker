import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import i18n from "../i18n";
import { hideRedundantGroupRow, retirementAccountNavLabel } from "../navAccountLabels";
import type { AccountListRow } from "../types";

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
  const pad = `calc(0.65rem + ${depth} * 1.15rem)`;
  return (
    <tr className={isGroup ? "hierarchy-nav-group" : "hierarchy-nav-leaf"}>
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

const RETIREMENT_GROUP = () => i18n.t("dashboard.cards.retirement");

function apvAccountRows(
  accounts: AccountListRow[],
  depth: number,
  _retirementLabel: string
) {
  return accounts.map((a) => (
    <HierarchyNavRow
      key={a.id}
      depth={depth}
      isGroup={false}
      nameCell={<Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>}
      categoryCell={a.category_label}
      groupCell={a.group_label}
      notesCell={a.notes ?? "—"}
    />
  ));
}

function apvSubgroupRows(
  label: string,
  route: string,
  accounts: AccountListRow[],
  subgroupDepth: number,
  leafDepth: number,
  retirementLabel: string
) {
  if (!accounts.length) return null;
  const collapse = hideRedundantGroupRow(label, accounts, retirementAccountNavLabel);
  if (collapse) {
    return apvAccountRows(accounts, subgroupDepth, retirementLabel);
  }
  return (
    <>
      <HierarchyNavRow
        depth={subgroupDepth}
        isGroup
        nameCell={<Link to={route}>{label}</Link>}
        categoryCell={<span className="muted">—</span>}
        groupCell={<span className="muted">{retirementLabel}</span>}
        notesCell={<span className="muted">—</span>}
      />
      {apvAccountRows(accounts, leafDepth, retirementLabel)}
    </>
  );
}

/** APV subtree aligned with sidebar: apv → apv-a (principal + fintual) → apv-b. */
export function RetirementApvHierarchyRows({
  apvAccounts,
  apvRowDepth,
}: {
  apvAccounts: AccountListRow[];
  /** Depth of the APV parent row (differs on inversiones root vs retiro tab). */
  apvRowDepth: number;
}) {
  const retirementLabel = RETIREMENT_GROUP();
  const principal = apvAccounts.filter((a) => a.notes === "import:excel|key=apv_a_principal");
  const fintual = apvAccounts.filter((a) => a.notes === "import:excel|key=apv_a");
  const apvB = apvAccounts.filter((a) => a.notes === "import:excel|key=apv_b");
  const subgroupDepth = apvRowDepth + 1;
  const leafDepth = apvRowDepth + 2;

  return (
    <>
      <HierarchyNavRow
        depth={apvRowDepth}
        isGroup
        nameCell={<Link to="/inversiones/retiro/apv">apv</Link>}
        categoryCell={<span className="muted">—</span>}
        groupCell={<span className="muted">{retirementLabel}</span>}
        notesCell={<span className="muted">—</span>}
      />
      {apvSubgroupRows(
        "apv-a",
        "/inversiones/retiro/apv/apv-a",
        [...principal, ...fintual],
        subgroupDepth,
        leafDepth,
        retirementLabel
      )}
      {apvSubgroupRows(
        "apv-b",
        "/inversiones/retiro/apv/apv-b",
        apvB,
        subgroupDepth,
        leafDepth,
        retirementLabel
      )}
    </>
  );
}

/** AFP + AFC: group row then account leaves (no per-category portfolio groups). */
export function RetirementAfpAfcHierarchyRows({
  afpAccounts,
  afcAccounts,
  groupDepth,
}: {
  afpAccounts: AccountListRow[];
  afcAccounts: AccountListRow[];
  groupDepth: number;
}) {
  if (afpAccounts.length === 0 && afcAccounts.length === 0) return null;
  const retirementLabel = RETIREMENT_GROUP();
  const leafDepth = groupDepth + 1;
  const leaves = [...afpAccounts, ...afcAccounts];
  return (
    <>
      <HierarchyNavRow
        depth={groupDepth}
        isGroup
        nameCell={
          <Link to="/inversiones/retiro/afp-afc" title={i18n.t("retirement.afpAfc")}>
            {i18n.t("retirement.afpAfc")}
          </Link>
        }
        categoryCell={<span className="muted">—</span>}
        groupCell={<span className="muted">{retirementLabel}</span>}
        notesCell={<span className="muted">—</span>}
      />
      {leaves.map((a) => (
        <HierarchyNavRow
          key={a.id}
          depth={leafDepth}
          isGroup={false}
          nameCell={<Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>}
          categoryCell={a.category_label}
          groupCell={a.group_label}
          notesCell={a.notes ?? "—"}
        />
      ))}
    </>
  );
}
