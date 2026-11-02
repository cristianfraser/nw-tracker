import { iconSvgProps, type IconProps } from "./iconProps";

/** A line going up: the change in investments. After Lucide's «trending-up» (ISC, https://lucide.dev). */
export function TrendingUpIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="m2.5 17 6.5-6.5 4.5 4.5 8-8" />
      <path d="M15.5 7h6v6" />
    </svg>
  );
}
