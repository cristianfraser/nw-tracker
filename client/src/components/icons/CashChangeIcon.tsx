import { iconSvgProps, type IconProps } from "./iconProps";

/** A banknote with a coin stack in front of it: the cash on hand. */
export function CashChangeIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M11 14H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 4h13a1.5 1.5 0 0 1 1.5 1.5V9" />
      <circle cx="10" cy="9" r="1.75" />
      <ellipse cx="17" cy="13" rx="4.5" ry="1.75" />
      <path d="M12.5 13v5.25c0 1 2 1.75 4.5 1.75s4.5-.75 4.5-1.75V13" />
      <path d="M12.5 15.75c0 1 2 1.75 4.5 1.75s4.5-.75 4.5-1.75" />
    </svg>
  );
}
