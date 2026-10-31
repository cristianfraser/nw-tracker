import type { SVGProps } from "react";

/** Shared props for the inline SVG icons: sized by `size` (px, default 16), stroked in currentColor. */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

export function iconSvgProps({ size = 16, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": rest["aria-label"] ? undefined : true,
    focusable: false,
    ...rest,
  };
}
