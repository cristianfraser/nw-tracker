import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRightIcon } from "../icons/ArrowUpRightIcon";

/** A section title that opens its page: reads as the heading it sits in, underlines on hover, arrow after it. */
export function HeadingLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="heading-link">
      <span className="heading-link__text">{children}</span>
      <ArrowUpRightIcon size={14} className="heading-link__icon" />
    </Link>
  );
}
