import { iconSvgProps, type IconProps } from "./iconProps";

/**
 * Two banknotes (as in BanknoteIcon) with a peso sign at the front note's corner: the cash on
 * hand. The front note's outline stops where the sign stands, and its mark sits at the note's
 * own centre.
 */
export function CashChangeIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M5 12.5H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H15a1 1 0 0 1 1 1v3" />
      <path d="M14 16H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v2" />
      <circle cx="12.5" cy="11.5" r="2" />
      <path d="M20.75 14.25c-.4-.9-1.35-1.5-2.5-1.5-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4.1 0 1.1-1.1 2-2.5 2-1.2 0-2.2-.6-2.6-1.5" />
      <path d="M18.25 11.25v11" />
    </svg>
  );
}
