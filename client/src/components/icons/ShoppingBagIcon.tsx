import { iconSvgProps, type IconProps } from "./iconProps";

/** A shopping bag: money spent. Two strokes, so it reads at row size. */
export function ShoppingBagIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M4.5 8.5h15V20h-15Z" />
      <path d="M8.5 8.5V7a3.5 3.5 0 0 1 7 0v1.5" />
    </svg>
  );
}
