import { iconSvgProps, type IconProps } from "./iconProps";

/** A peso sign: the cash on hand. */
export function CashChangeIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M15.75 8.25c-.6-1.35-2.1-2.25-3.75-2.25-2.3 0-4 1.25-4 3 0 4.1 8 2.3 8 6.4 0 1.8-1.7 3.1-4 3.1-1.85 0-3.45-.9-4.1-2.3" />
      <path d="M12 3.75v16.5" />
    </svg>
  );
}
