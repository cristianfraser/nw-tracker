import { iconSvgProps, type IconProps } from "./iconProps";

/** A peso sign: the cash on hand. */
export function CashChangeIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M16.5 7.5c-.7-1.5-2.4-2.5-4.5-2.5-2.6 0-4.5 1.4-4.5 3.4 0 4.6 9 2.6 9 7.2 0 2-1.9 3.4-4.5 3.4-2.1 0-3.9-1-4.6-2.6" />
      <path d="M12 2.5v19" />
    </svg>
  );
}
