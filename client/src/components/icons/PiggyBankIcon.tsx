import { iconSvgProps, type IconProps } from "./iconProps";

/** A piggy bank: money put aside. Body with snout and legs in one outline, an ear; no detail. */
export function PiggyBankIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M20 12.5c0-3.9-3.6-6.5-8-6.5S4 8.6 4 12.5c0 2 .9 3.6 2.5 4.6V20h3v-2c.8.2 1.6.3 2.5.3s1.7-.1 2.5-.3v2h3v-2.9c.8-.5 1.4-1.1 1.8-1.8H21v-3.8Z" />
      <path d="M9 6.5 8 3.5l3 2.6" />
    </svg>
  );
}
