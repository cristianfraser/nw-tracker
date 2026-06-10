import type { SidebarNavResponse } from "../types";

const SIDEBAR_NAV_STORAGE_KEY = "nw:sidebar-nav-v2";

export function readSidebarNavCache(): SidebarNavResponse | undefined {
  try {
    const raw = localStorage.getItem(SIDEBAR_NAV_STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as SidebarNavResponse;
  } catch {
    return undefined;
  }
}

export function writeSidebarNavCache(data: SidebarNavResponse): void {
  try {
    localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // quota / private mode
  }
}
