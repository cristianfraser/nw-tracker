import { useCallback, useId, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import { useTranslation } from "../../i18n";
import { readPref, writePref } from "../../usePersistedPref";
import styles from "./NavAccountsTree.module.css";

/** Groups shallower than this start open; the viewer's own choices (stored per tree root) win. */
const DEFAULT_OPEN_DEPTH = 2;

const OPEN_STATE_LS_PREFIX = "nw-tracker.accountsTree.";

/** Explicit open/closed choices by `node_id`; a group without one follows its depth's default. */
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

function isGroup(node: NavTreeNodeDto): boolean {
  return node.account_id == null;
}

function groupNodeIds(node: NavTreeNodeDto, out: string[] = []): string[] {
  if (!isGroup(node)) return out;
  out.push(node.node_id);
  for (const child of node.children) groupNodeIds(child, out);
  return out;
}

type TreeContext = {
  isOpen: (node: NavTreeNodeDto, depth: number) => boolean;
  toggle: (node: NavTreeNodeDto, depth: number) => void;
  idPrefix: string;
};

function NavAccountsTreeNode({
  node,
  depth,
  ctx,
}: {
  node: NavTreeNodeDto;
  depth: number;
  ctx: TreeContext;
}) {
  const { t } = useTranslation();
  const label = resolveNavTreeLabel(node);

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
  const open = hasChildren && ctx.isOpen(node, depth);
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
            onClick={() => ctx.toggle(node, depth)}
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
            <NavAccountsTreeNode key={child.node_id} node={child} depth={depth + 1} ctx={ctx} />
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
 * stays the link to its page), guide rails mark each level, accounts read «#id name». Groups
 * shallower than `DEFAULT_OPEN_DEPTH` start open; the viewer's choices are kept per tree root.
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
  const ctx: TreeContext = {
    isOpen: (node, depth) => open[node.node_id] ?? depth < DEFAULT_OPEN_DEPTH,
    toggle: (node, depth) => {
      const current = open[node.node_id] ?? depth < DEFAULT_OPEN_DEPTH;
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
            <NavAccountsTreeNode node={root} depth={0} ctx={ctx} />
          </ul>
        </div>
      )}
    </>
  );
}
