/**
 * Master list of control-panel subroutes. The /panel router (App.tsx), the panel
 * subnav tabs (ControlPanelLayout), and the sidebar's Control panel children
 * (AppSidebar) all derive from this list so they can never drift.
 */
export const PANEL_SUBROUTES = [
  { slug: "notifications", labelKey: "panel.notificationsTitle" },
  { slug: "accounts", labelKey: "panel.accountsTitle" },
  { slug: "import-sync", labelKey: "panel.importSyncTitle" },
  { slug: "mirror-pairs", labelKey: "panel.mirrorPairsTitle" },
  { slug: "settings", labelKey: "panel.settingsTitle" },
] as const;

export type PanelSubrouteSlug = (typeof PANEL_SUBROUTES)[number]["slug"];
