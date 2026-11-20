/**
 * The open / close chevron (points down: open). The sidebar's group toggle and the investment
 * group table's basket rows draw this one; a closed state rotates it −90° in the caller's CSS.
 */
export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M3 4.5 6 7.5l3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
