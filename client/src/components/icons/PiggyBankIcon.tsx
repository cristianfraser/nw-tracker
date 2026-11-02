import { iconSvgProps, type IconProps } from "./iconProps";

/** A piggy bank: money put aside into savings and investments. */
export function PiggyBankIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M19 10.5c0-3.3-3.1-5.5-7-5.5-3.6 0-6.6 1.9-7 4.8H3.5v3.4h1.6c.5 1.4 1.5 2.5 2.9 3.2V19h2.5v-1.9c.5.1 1 .1 1.5.1s1 0 1.5-.1V19H16v-2.6c1.9-1 3-2.7 3-4.4Z" />
      <path d="M19 10.5h1.5" />
      <line x1="15.5" y1="9.5" x2="15.51" y2="9.5" />
      <path d="M10 7.5h3" />
    </svg>
  );
}
