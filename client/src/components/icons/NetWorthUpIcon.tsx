import { iconSvgProps, type IconProps } from "./iconProps";

/** A line going up over a coin stack: the change in net worth. */
export function NetWorthUpIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="m2.5 13 4.5-4.5 3 3 5.5-5.5" />
      <path d="M12 5.5h4v4" />
      <ellipse cx="16.5" cy="14" rx="4.5" ry="1.75" />
      <path d="M12 14v4.5c0 1 2 1.75 4.5 1.75s4.5-.75 4.5-1.75V14" />
    </svg>
  );
}
