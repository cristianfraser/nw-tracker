import i18n from "./i18n";
import type { NavTreeNodeDto, SidebarNavResponse } from "./types";
import type { SidebarNavNode } from "./sidebarNavTree";

export function resolveNavTreeLabel(dto: NavTreeNodeDto): string {
  if (dto.label_i18n_key) {
    const translated = i18n.t(dto.label_i18n_key);
    if (translated !== dto.label_i18n_key) return translated;
  }
  return dto.label;
}

function mapNode(dto: NavTreeNodeDto): SidebarNavNode {
  const children = dto.children.length > 0 ? dto.children.map(mapNode) : undefined;
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

/** Build sidebar nodes from `GET /api/meta/sidebar-nav` (same layout sections as legacy builder). */
export function buildSidebarNavFromApi(payload: SidebarNavResponse): SidebarNavNode[] {
  const out: SidebarNavNode[] = [];
  if (payload.dashboard) out.push(mapNode(payload.dashboard));
  for (const n of payload.main) out.push(mapNode(n));
  if (payload.flows) out.push(mapNode(payload.flows));
  if (payload.rates) out.push(mapNode(payload.rates));
  return out;
}
