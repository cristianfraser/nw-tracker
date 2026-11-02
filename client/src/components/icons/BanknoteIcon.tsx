import { iconSvgProps, type IconProps } from "./iconProps";

/** A banknote: money received. A note and its centre mark, nothing finer. */
export function BanknoteIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}
