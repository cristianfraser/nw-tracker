import { Link } from "react-router-dom";
import type { NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import { useTranslation } from "../../i18n";

function treeGuidePrefix(depth: number): string {
  if (depth <= 0) return "";
  return "└─ ";
}

function NavAccountsTreeNode({ node, depth = 0 }: { node: NavTreeNodeDto; depth?: number }) {
  const label = resolveNavTreeLabel(node);
  const indentPx = 32;
  const prefix = treeGuidePrefix(depth);

  if (node.account_id != null) {
    return (
      <li style={{ marginLeft: `${indentPx}px` }}>
        {prefix ? <span className="muted mono">{prefix}</span> : null}
        <Link to={`/account/${node.account_id}`}>
          <span className="mono">#{node.account_id}</span> {label}
        </Link>
      </li>
    );
  }

  const route = node.route_path?.trim();
  const labelNode = route ? (
    <Link to={route}>
      <strong>{label}</strong>
    </Link>
  ) : (
    <strong>{label}</strong>
  );

  return (
    <li style={{ marginLeft: `${indentPx}px` }}>
      {prefix ? <span className="muted mono">{prefix}</span> : null}
      {labelNode} <span className="muted mono">({node.slug})</span>
      {node.children.length > 0 ? (
        <ul style={{ marginTop: "0.35rem", marginLeft: 0, paddingLeft: 0, listStyle: "none" }}>
          {node.children.map((child) => (
            <NavAccountsTreeNode key={child.node_id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export type NavAccountsTreeProps = {
  root: NavTreeNodeDto;
  /** When set, renders a section heading above the tree. */
  titleI18nKey?: string;
  emptyI18nKey?: string;
};

export function NavAccountsTree({
  root,
  titleI18nKey,
  emptyI18nKey = "groupPage.accountsTreeEmpty",
}: NavAccountsTreeProps) {
  const { t } = useTranslation();
  const isEmpty = root.account_id == null && root.children.length === 0;

  return (
    <>
      {titleI18nKey ? (
        <h2 style={{ marginTop: "2rem", fontSize: "1.15rem" }}>{t(titleI18nKey)}</h2>
      ) : null}
      {isEmpty ? (
        <p className="muted">{t(emptyI18nKey)}</p>
      ) : (
        <ul style={{ marginLeft: 0, paddingLeft: 0, listStyle: "none" }}>
          <NavAccountsTreeNode node={root} />
        </ul>
      )}
    </>
  );
}
