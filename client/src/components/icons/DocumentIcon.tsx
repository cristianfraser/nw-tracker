import { iconSvgProps, type IconProps } from "./iconProps";

/** A document with lines: a printed document (payslip). */
export function DocumentIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <line x1="8.5" y1="13" x2="15.5" y2="13" />
      <line x1="8.5" y1="16.5" x2="13" y2="16.5" />
    </svg>
  );
}
