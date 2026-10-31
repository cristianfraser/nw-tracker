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
  // Refused by the public demo's server (`npm run demo:visits` reads it there).
  { slug: "usage", labelKey: "panel.usageTitle", hiddenOnDemo: true },
  { slug: "settings", labelKey: "panel.settingsTitle" },
] as const;

export type PanelSubrouteSlug = (typeof PANEL_SUBROUTES)[number]["slug"];

/** The subroutes this build shows: a hosted-demo build leaves out the ones the demo refuses. */
export const VISIBLE_PANEL_SUBROUTES = PANEL_SUBROUTES.filter(
  (route) => !(import.meta.env.VITE_DEMO_MODE === "1" && "hiddenOnDemo" in route && route.hiddenOnDemo)
);
