import { iconSvgProps, type IconProps } from "./iconProps";

/** An arrow pointing up and right: a title that opens its own page. After Lucide's «arrow-up-right» (ISC, https://lucide.dev). */
export function ArrowUpRightIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}
