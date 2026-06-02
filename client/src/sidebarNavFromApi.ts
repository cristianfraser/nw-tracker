import i18n from "./i18n";
import type { NavTreeNodeDto, SidebarNavResponse } from "./types";
import { sortNavTreeLeavesFirst, type SidebarNavNode } from "./sidebarNavTree";
import type { EntityColorTarget } from "./entityColor";

export function resolveNavTreeLabel(dto: NavTreeNodeDto): string {
  if (dto.label_i18n_key) {
    const translated = i18n.t(dto.label_i18n_key);
    if (translated !== dto.label_i18n_key) return translated;
  }
  return dto.label;
}

/** Persistable color target for a nav tree node (account or portfolio group). */
export function navColorTargetFromDto(dto: NavTreeNodeDto): EntityColorTarget | undefined {
  if (dto.account_id != null && dto.account_id > 0) {
    return { kind: "account", accountId: dto.account_id };
  }
  if (dto.expense_account_id != null || dto.portfolio_group_id == null) return undefined;
  return { kind: "portfolio_group", slug: dto.slug };
}

function mapNode(dto: NavTreeNodeDto): SidebarNavNode {
  const childDtos =
    dto.children.length > 0 ? sortNavTreeLeavesFirst(dto.children).map(mapNode) : undefined;
  const children = childDtos && childDtos.length > 0 ? childDtos : undefined;
  return {
    id: dto.node_id,
    label: resolveNavTreeLabel(dto),
    to: dto.route_path,
    end: dto.nav_end ? true : undefined,
    activePrefix: dto.active_prefix ?? undefined,
    showLeafHyphen: dto.show_leaf_hyphen,
    children,
  };
}

/** Home page / sidebar root label from `net_worth` portfolio group (falls back to dashboard link node). */
export function resolveNetWorthGroupLabel(payload: SidebarNavResponse | null | undefined): string {
  if (payload?.net_worth) return resolveNavTreeLabel(payload.net_worth);
  if (payload?.dashboard) return resolveNavTreeLabel(payload.dashboard);
  return i18n.t("dashboard.cards.netWorth");
}

/** Build sidebar nodes from `GET /api/meta/sidebar-nav` (same layout sections as legacy builder). */
export function buildSidebarNavFromApi(payload: SidebarNavResponse): SidebarNavNode[] {
  const out: SidebarNavNode[] = [];
  if (payload.dashboard) {
    const homeLabel = resolveNetWorthGroupLabel(payload);
    out.push({ ...mapNode(payload.dashboard), label: homeLabel });
  }
  for (const n of payload.main) out.push(mapNode(n));
  if (payload.flows) out.push(mapNode(payload.flows));
  if (payload.rates) out.push(mapNode(payload.rates));
  return out;
}
