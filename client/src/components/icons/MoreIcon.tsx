import { iconSvgProps, type IconProps } from "./iconProps";

/** Three horizontal dots: more actions. */
export function MoreIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
