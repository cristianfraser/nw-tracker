import { parseColor, type Color } from "react-aria-components";
import { api } from "./api";
import { rgbTripletToHex } from "./chartColors";

export type EntityColorTarget =
  | { kind: "account"; accountId: number }
  | { kind: "portfolio_group"; slug: string };

export function parseEntityColorRgb(colorRgb: string | null | undefined) {
  return parseColor(rgbTripletToHex(colorRgb));
}

export function colorToRgbTriplet(color: Color): string {
  const rgb = color.toFormat("rgb");
  const r = Math.round(rgb.getChannelValue("red"));
  const g = Math.round(rgb.getChannelValue("green"));
  const b = Math.round(rgb.getChannelValue("blue"));
  return `${r},${g},${b}`;
}

export type EntityColorPatchResult = { color_rgb: string | null; color: string };

export async function persistEntityColor(
  target: EntityColorTarget,
  colorRgb: string
): Promise<EntityColorPatchResult> {
  if (target.kind === "account") {
    return api.updateAccountColor(target.accountId, colorRgb);
  }
  return api.updatePortfolioGroupColor(target.slug, colorRgb);
}

/** Clears explicit `color_rgb` in DB; charts fall back to auto-resolved color. */
export async function clearEntityColor(target: EntityColorTarget): Promise<EntityColorPatchResult> {
  if (target.kind === "account") {
    return api.updateAccountColor(target.accountId, null);
  }
  return api.updatePortfolioGroupColor(target.slug, null);
}
