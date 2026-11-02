import { iconSvgProps, type IconProps } from "./iconProps";

/** A line going up, its end over a peso sign: the change in net worth. */
export function NetWorthUpIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="m1.5 13 5-5 3.5 3.5 6-6" />
      <path d="M11.5 5.5h4.5V10" />
      <path d="M21.25 12.25c-.5-1.1-1.75-1.9-3.25-1.9-1.9 0-3.25 1-3.25 2.5 0 3.4 6.5 1.8 6.5 5.3 0 1.4-1.4 2.6-3.25 2.6-1.55 0-2.85-.75-3.4-1.95" />
      <path d="M18 8.75v13.75" />
    </svg>
  );
}
