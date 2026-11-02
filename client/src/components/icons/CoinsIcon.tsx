import { iconSvgProps, type IconProps } from "./iconProps";

/**
 * A stack of coins with one leaning on it: money deposited. After the coin stacks of Tabler's
 * «coins» (MIT, https://tabler.io/icons) and Lucide's «coins» (ISC, https://lucide.dev).
 */
export function CoinsIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <ellipse cx="7.5" cy="7" rx="5" ry="2.25" />
      <path d="M2.5 7v10c0 1.25 2.25 2.25 5 2.25s5-1 5-2.25V7" />
      <path d="M2.5 12c0 1.25 2.25 2.25 5 2.25s5-1 5-2.25" />
      <ellipse cx="17" cy="14.75" rx="3.25" ry="5" transform="rotate(-18 17 14.75)" />
    </svg>
  );
}
