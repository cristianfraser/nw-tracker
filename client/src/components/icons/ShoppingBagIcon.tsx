import { iconSvgProps, type IconProps } from "./iconProps";

/** A shopping bag: money spent. A tapered body and a handle reaching into it (straight sides read as a suitcase). */
export function ShoppingBagIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M4.5 8h15l-1.2 12.5H5.7L4.5 8Z" />
      <path d="M8.75 11V6.75a3.25 3.25 0 0 1 6.5 0V11" />
    </svg>
  );
}
