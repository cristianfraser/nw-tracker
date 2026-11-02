import { iconSvgProps, type IconProps } from "./iconProps";

/**
 * Two banknotes (as in BanknoteIcon) with a coin stack in front of the front note's corner: the
 * cash on hand. The front note's outline stops where the stack covers it, and its mark sits at
 * the note's own centre.
 */
export function CashChangeIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M5 12.5H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H15a1 1 0 0 1 1 1v3" />
      <path d="M13 16H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v5" />
      <circle cx="12.5" cy="11.5" r="2.25" />
      <ellipse cx="17.5" cy="16" rx="4.5" ry="1.75" />
      <path d="M13 16v3.25c0 1 2 1.75 4.5 1.75s4.5-.75 4.5-1.75V16" />
    </svg>
  );
}
