import { iconSvgProps, type IconProps } from "./iconProps";

/** A payment card. */
export function CreditCardIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <line x1="2.5" y1="10" x2="21.5" y2="10" />
      <line x1="6" y1="15" x2="10" y2="15" />
    </svg>
  );
}
