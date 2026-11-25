import { useCallback, useId, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import { useTranslation } from "../../i18n";
import { readPref, writePref } from "../../usePersistedPref";
import styles from "./NavAccountsTree.module.css";

/**
 * Stored per tree root. v2: the default became «groups of groups open» — choices stored under the
 * earlier depth default are no longer read.
 */
const OPEN_STATE_LS_PREFIX = "nw-tracker.accountsTree.v2.";

/** Explicit open/closed choices by `node_id`; a group without one follows `openByDefault`. */
type OpenChoices = Record<string, boolean>;

/** Tolerant parse of the stored choices (a per-viewer convenience): anything else is no choice. */
function parseOpenChoices(raw: string | null): OpenChoices {
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: OpenChoices = {};
  for (const [id, open] of Object.entries(parsed)) {
    if (typeof open === "boolean") out[id] = open;
  }
  return out;
}

/** A tracked place (`exp.<slug>`) is a leaf like an account: it links to its expenses page. */
function isGroup(node: NavTreeNodeDto): boolean {
  return node.account_id == null && node.expense_account_id == null;
}

/**
 * A group whose children are all groups starts open; a group that holds accounts (a leaf group, or
 * one mixing accounts and sub-groups) starts closed — so the default shows every group down to the
 * ones that list accounts.
 */
function openByDefault(node: NavTreeNodeDto): boolean {
  return node.children.length > 0 && node.children.every(isGroup);
}

function groupNodeIds(node: NavTreeNodeDto, out: string[] = []): string[] {
  if (!isGroup(node)) return out;
  out.push(node.node_id);
  for (const child of node.children) groupNodeIds(child, out);
  return out;
}

type TreeContext = {
  isOpen: (node: NavTreeNodeDto) => boolean;
  toggle: (node: NavTreeNodeDto) => void;
  idPrefix: string;
};

function NavAccountsTreeNode({
  node,
  ctx,
}: {
  node: NavTreeNodeDto;
  ctx: TreeContext;
}) {
  const { t } = useTranslation();
  const label = resolveNavTreeLabel(node);

  if (node.expense_account_id != null) {
    return (
      <li className={styles.leaf}>
        <Link to={node.route_path}>{label}</Link>
      </li>
    );
  }

  if (!isGroup(node)) {
    return (
      <li className={styles.leaf}>
        <Link to={`/account/${node.account_id}`}>
          <span className={styles.id}>#{node.account_id}</span> {label}
        </Link>
      </li>
    );
  }

  const hasChildren = node.children.length > 0;
  const open = hasChildren && ctx.isOpen(node);
  const childrenId = `${ctx.idPrefix}-${node.node_id}`;
  const route = node.route_path?.trim();
  const dotStyle = node.color_rgb
    ? ({ "--node-rgb": node.color_rgb } as CSSProperties)
    : undefined;

  return (
    <li className={styles.group}>
      <div className={styles.row}>
        {hasChildren ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={childrenId}
            aria-label={t(open ? "accountsTree.collapse" : "accountsTree.expand", { name: label })}
            onClick={() => ctx.toggle(node)}
          />
        ) : (
          <span className={styles.toggleSpace} aria-hidden />
        )}
        <span className={node.color_rgb ? styles.dot : styles.dotSpace} style={dotStyle} aria-hidden />
        {route ? (
          <Link to={route} className={styles.groupLink}>
            {label}
          </Link>
        ) : (
          <strong className={styles.groupLabel}>{label}</strong>
        )}
        <span className={styles.slug}>{node.slug}</span>
      </div>
      {hasChildren ? (
        <ul id={childrenId} className={styles.children} hidden={!open}>
          {node.children.map((child) => (
            <NavAccountsTreeNode key={child.node_id} node={child} ctx={ctx} />
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

/**
 * The nav tree as a collapsible nested list: a group opens and closes from its chevron (its name
 * stays the link to its page), guide rails mark each level, accounts read «#id name» and tracked
 * places their name. The root and groups of groups start open, groups holding accounts closed; the
 * viewer's choices are kept per tree root.
 */
export function NavAccountsTree({
  root,
  titleI18nKey,
  emptyI18nKey = "groupPage.accountsTreeEmpty",
}: NavAccountsTreeProps) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const storageKey = `${OPEN_STATE_LS_PREFIX}${root.slug}`;
  const [choices, setChoices] = useState<{ key: string; open: OpenChoices }>(() => ({
    key: storageKey,
    open: parseOpenChoices(readPref(storageKey)),
  }));
  // Another tree root (a different group page) reads its own stored choices.
  const open = choices.key === storageKey ? choices.open : parseOpenChoices(readPref(storageKey));

  const save = useCallback(
    (next: OpenChoices) => {
      setChoices({ key: storageKey, open: next });
      writePref(storageKey, JSON.stringify(next));
    },
    [storageKey]
  );

  const groupIds = useMemo(() => groupNodeIds(root), [root]);
  // The root always starts open (as «collapse all» leaves it), even on a page whose group lists accounts.
  const defaultOpen = (node: NavTreeNodeDto) => node.node_id === root.node_id || openByDefault(node);
  const ctx: TreeContext = {
    isOpen: (node) => open[node.node_id] ?? defaultOpen(node),
    toggle: (node) => {
      const current = open[node.node_id] ?? defaultOpen(node);
      save({ ...open, [node.node_id]: !current });
    },
    idPrefix,
  };
  const setAll = (value: boolean) => {
    const next: OpenChoices = {};
    for (const id of groupIds) next[id] = value;
    // The root stays open, so «collapse all» still shows the first level.
    next[root.node_id] = true;
    save(next);
  };

  const isEmpty = root.account_id == null && root.children.length === 0;

  return (
    <>
      {titleI18nKey ? <h2 className={styles.title}>{t(titleI18nKey)}</h2> : null}
      {isEmpty ? (
        <p className="muted">{t(emptyI18nKey)}</p>
      ) : (
        <div className={styles.frame}>
          <div className={styles.tools}>
            <button type="button" className={styles.tool} onClick={() => setAll(true)}>
              {t("accountsTree.expandAll")}
            </button>
            <button type="button" className={styles.tool} onClick={() => setAll(false)}>
              {t("accountsTree.collapseAll")}
            </button>
          </div>
          <ul className={styles.tree}>
            <NavAccountsTreeNode node={root} ctx={ctx} />
          </ul>
        </div>
      )}
    </>
  );
}
