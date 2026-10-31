import { iconSvgProps, type IconProps } from "./iconProps";

/** A bank building: a bank account. */
export function BankIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M3 9.5 12 4l9 5.5" />
      <line x1="4" y1="20" x2="20" y2="20" />
      <line x1="6" y1="10.5" x2="6" y2="17" />
      <line x1="10" y1="10.5" x2="10" y2="17" />
      <line x1="14" y1="10.5" x2="14" y2="17" />
      <line x1="18" y1="10.5" x2="18" y2="17" />
    </svg>
  );
}
