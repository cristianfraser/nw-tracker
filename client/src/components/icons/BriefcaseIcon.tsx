import { iconSvgProps, type IconProps } from "./iconProps";

/** A briefcase: work (a payslip's deductions). */
export function BriefcaseIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M3 13h18" />
      <line x1="12" y1="12" x2="12" y2="14" />
    </svg>
  );
}
