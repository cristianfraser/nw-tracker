import { iconSvgProps, type IconProps } from "./iconProps";

/** A banknote: money received. */
export function BanknoteIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <rect x="2.5" y="6" width="19" height="12" rx="1.5" />
      <circle cx="12" cy="12" r="2.5" />
      <line x1="6" y1="12" x2="6.01" y2="12" />
      <line x1="18" y1="12" x2="18.01" y2="12" />
    </svg>
  );
}
