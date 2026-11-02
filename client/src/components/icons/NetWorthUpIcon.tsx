import { iconSvgProps, type IconProps } from "./iconProps";

/** A line going up with a peso sign below its end: the change in net worth. */
export function NetWorthUpIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="m2 12 4-4 3 3 4.5-4.5" />
      <path d="M10.5 6.5h3V9.5" />
      <path d="M20.75 14.25c-.4-.9-1.35-1.5-2.5-1.5-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4.1 0 1.1-1.1 2-2.5 2-1.2 0-2.2-.6-2.6-1.5" />
      <path d="M18.25 11.25v11" />
    </svg>
  );
}
