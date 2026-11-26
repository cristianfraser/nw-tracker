import { useCallback, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
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

/** An account as a row extra receives it: a tree leaf, or an account listed outside the tree. */
export type AccountsTreeAccount = {
  id: number;
  name: string;
  colorRgb: string | null;
  /** Unique per row: an account held by two groups is two rows. */
  rowKey: string;
};

/**
 * What a page adds to the tree's rows (the control panel: colour pickers, the basket toggle, an
 * account's actions). Every part is optional; without `rowExtras` the tree is the plain list.
 */
export type NavAccountsTreeRowExtras = {
  /** Takes the place of a group's colour square; null keeps the square. */
  groupSwatch?: (node: NavTreeNodeDto) => ReactNode;
  /** The grey monospace text after a group's name, in place of its slug. */
  groupMeta?: (node: NavTreeNodeDto) => string;
  /** At the end of a group's row. */
  groupEnd?: (node: NavTreeNodeDto) => ReactNode;
  /** Before an account's name. */
  accountSwatch?: (account: AccountsTreeAccount) => ReactNode;
  /** A text mark after an account's name; cut with «…» before the name gives way. */
  accountTag?: (account: AccountsTreeAccount) => ReactNode;
  /** At the end of an account's row: controls, which keep their width. */
  accountEnd?: (account: AccountsTreeAccount) => ReactNode;
  /** On a line of its own under an account's row (what its row opened); null when closed. */
  accountBelow?: (account: AccountsTreeAccount) => ReactNode;
};

type TreeContext = {
  isOpen: (node: NavTreeNodeDto) => boolean;
  toggle: (node: NavTreeNodeDto) => void;
  idPrefix: string;
  rowExtras?: NavAccountsTreeRowExtras;
};

/** An account leaf: «#id name» linked to its page, with the page's row extras around it. */
function AccountLeaf({
  account,
  rowExtras,
}: {
  account: AccountsTreeAccount;
  rowExtras: NavAccountsTreeRowExtras | undefined;
}) {
  const link = (
    <>
      <span className={styles.id}>#{account.id}</span> {account.name}
    </>
  );
  if (!rowExtras) {
    return (
      <li className={styles.leaf}>
        <Link to={`/account/${account.id}`}>{link}</Link>
      </li>
    );
  }
  const tag = rowExtras.accountTag?.(account);
  const end = rowExtras.accountEnd?.(account);
  return (
    <li>
      <div className={styles.leafRow}>
        {rowExtras.accountSwatch?.(account)}
        <Link to={`/account/${account.id}`} className={styles.leafLink}>
          {link}
        </Link>
        {tag ? <span className={styles.tagSlot}>{tag}</span> : null}
        {end ? <span className={styles.end}>{end}</span> : null}
      </div>
      {rowExtras.accountBelow?.(account)}
    </li>
  );
}

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

  if (node.account_id != null) {
    return (
      <AccountLeaf
        account={{ id: node.account_id, name: label, colorRgb: node.color_rgb ?? null, rowKey: node.node_id }}
        rowExtras={ctx.rowExtras}
      />
    );
  }

  const hasChildren = node.children.length > 0;
  const open = hasChildren && ctx.isOpen(node);
  const childrenId = `${ctx.idPrefix}-${node.node_id}`;
  const route = node.route_path?.trim();
  const dotStyle = node.color_rgb
    ? ({ "--node-rgb": node.color_rgb } as CSSProperties)
    : undefined;
  const swatch = ctx.rowExtras?.groupSwatch?.(node);
  const end = ctx.rowExtras?.groupEnd?.(node);

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
        {swatch ?? (
          <span className={node.color_rgb ? styles.dot : styles.dotSpace} style={dotStyle} aria-hidden />
        )}
        {route ? (
          <Link to={route} className={styles.groupLink}>
            {label}
          </Link>
        ) : (
          <strong className={styles.groupLabel}>{label}</strong>
        )}
        <span className={styles.slug}>{ctx.rowExtras?.groupMeta?.(node) ?? node.slug}</span>
        {end ? <span className={styles.end}>{end}</span> : null}
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

/**
 * Accounts that sit in no group of the tree, as the tree's own account rows under a title. The
 * tree renders it under itself (`looseAccounts`); a page with no tree renders it alone, and
 * without a title it is the bare list (a page's accounts while its tree is still loading).
 */
export function AccountsTreeLooseAccounts({
  title,
  accounts,
  rowExtras,
  standalone = false,
}: {
  title?: string;
  accounts: Omit<AccountsTreeAccount, "rowKey">[];
  rowExtras?: NavAccountsTreeRowExtras;
  /** Outside a tree: brings the tree's own frame. */
  standalone?: boolean;
}) {
  const titleId = useId();
  if (accounts.length === 0) return null;
  const rows = (
    <ul className={styles.tree}>
      {accounts.map((a) => (
        <AccountLeaf key={a.id} account={{ ...a, rowKey: `loose-${a.id}` }} rowExtras={rowExtras} />
      ))}
    </ul>
  );
  const list =
    title == null ? (
      rows
    ) : (
      <section className={styles.loose} aria-labelledby={titleId}>
        <p id={titleId} className={styles.looseTitle}>
          {title}
        </p>
        {rows}
      </section>
    );
  return standalone ? <div className={styles.frame}>{list}</div> : list;
}

export type NavAccountsTreeProps = {
  root: NavTreeNodeDto;
  /** When set, renders a section heading above the tree. */
  titleI18nKey?: string;
  emptyI18nKey?: string;
  /** Controls a page adds to the rows; the tree itself is unchanged without it. */
  rowExtras?: NavAccountsTreeRowExtras;
  /** Accounts in no group of the tree, listed under it with the same rows. */
  looseAccounts?: { title: string; accounts: Omit<AccountsTreeAccount, "rowKey">[] };
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
  rowExtras,
  looseAccounts,
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
    rowExtras,
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
        <>
          <p className="muted">{t(emptyI18nKey)}</p>
          {looseAccounts ? (
            <AccountsTreeLooseAccounts
              title={looseAccounts.title}
              accounts={looseAccounts.accounts}
              rowExtras={rowExtras}
              standalone
            />
          ) : null}
        </>
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
          {looseAccounts ? (
            <AccountsTreeLooseAccounts
              title={looseAccounts.title}
              accounts={looseAccounts.accounts}
              rowExtras={rowExtras}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
