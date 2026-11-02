import { iconSvgProps, type IconProps } from "./iconProps";

/** A shopping bag: money spent. */
export function ShoppingBagIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M5 8h14l-1 12.5H6L5 8Z" />
      <path d="M9 10.5V6.5a3 3 0 0 1 6 0v4" />
    </svg>
  );
}
