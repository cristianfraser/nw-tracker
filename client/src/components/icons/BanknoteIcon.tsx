import { iconSvgProps, type IconProps } from "./iconProps";

/**
 * Two stacked banknotes: money received. Drawn after Tabler Icons' «cash» (MIT,
 * https://tabler.io/icons): a second note behind the first keeps it from reading as a plain box.
 */
export function BanknoteIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M7 15H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
      <rect x="7" y="9" width="14" height="10" rx="1" />
      <circle cx="14" cy="14" r="2" />
    </svg>
  );
}
