import { iconSvgProps, type IconProps } from "./iconProps";

/** A Δ: a change in value (the market's part, P/L). */
export function DeltaIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M12 4 21 20H3Z" />
    </svg>
  );
}
