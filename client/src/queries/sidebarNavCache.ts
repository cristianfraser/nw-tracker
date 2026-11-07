import type { SidebarNavResponse } from "../types";
import {
  hasSchemaVersion,
  persistedPayload,
  readPersistedPayload,
  writePersistedPayload,
} from "./persistedPayloadCache";

const SIDEBAR_NAV = persistedPayload(
  "sidebar_nav",
  (v): v is SidebarNavResponse =>
    hasSchemaVersion(v, "sidebar_nav") && Array.isArray((v as SidebarNavResponse).main)
);

export function readSidebarNavCache(): SidebarNavResponse | undefined {
  return readPersistedPayload(SIDEBAR_NAV);
}

export function writeSidebarNavCache(data: SidebarNavResponse): void {
  writePersistedPayload(SIDEBAR_NAV, [], data);
}
