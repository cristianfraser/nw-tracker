import type { ThemeOverrides } from "@crfrsr/core";

/**
 * Maps nw-tracker's existing design tokens (see styles/tokens.css) onto the
 * @crfrsr/ui `--crfrsr-*` contract, so design-system components match the app.
 *
 * nw-tracker is a single dark theme, so the same palette is used for both modes.
 */
const palette = {
  primary: "#3d9cf9", // --accent
  primaryDark: "#2563a8", // --accent-dim (hover)
  textOnPrimary: "#0c0f14", // dark text on the bright accent (readable)
  secondary: "#8b98a8", // --muted
  background: "#0c0f14", // --bg
  surface: "#141a22", // --surface
  surfaceHover: "#1c2430", // --surface2
  text: "#e8edf4", // --text
  textSecondary: "#8b98a8", // --muted
  textDisabled: "#5b6675", // dimmed --muted (placeholders, disabled text)
  border: "#2a3544", // --border
  divider: "#2a3544", // --border (also secondary-button hover)
  focusRing: "#3d9cf9", // --accent
  success: "#34d399", // --positive
  error: "#f87171", // --negative
  overlay: "rgb(0 0 0 / 0.7)",
} as const;

export const nwTrackerTheme: ThemeOverrides = {
  colors: { light: palette, dark: palette },
  typography: {
    fontFamily: { base: '"DM Sans", system-ui, sans-serif' },
  },
  radius: { lg: "5px" }, // --card-radius
};
