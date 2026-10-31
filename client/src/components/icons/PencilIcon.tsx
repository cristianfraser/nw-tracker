import { iconSvgProps, type IconProps } from "./iconProps";

/** A pencil: something entered by hand. */
export function PencilIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      <line x1="14.5" y1="5.5" x2="18.5" y2="9.5" />
    </svg>
  );
}
