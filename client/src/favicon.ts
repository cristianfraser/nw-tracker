/**
 * Route-driven favicon: the black rounded square from `public/favicon.svg` plus a
 * per-page overlay (bucket/account diagonal color, flows triangles, settings circle).
 * SVG is generated inline and swapped onto the `<link rel="icon">` as a data URI —
 * no build assets, updates instantly on route change.
 */

export type FaviconSpec =
  /** Default: plain black rounded square (same rendering as the static favicon.svg). */
  | { kind: "plain" }
  /** Bucket/account pages: black upper-left half, entity color on the lower-right half. */
  | { kind: "diagonal"; color: string }
  | { kind: "triangle"; direction: "up" | "down" | "up-right"; color: string }
  /** Small square tucked into the top-right corner (wealth percentile). */
  | { kind: "corner-square"; color: string }
  /** Centered circle (settings). */
  | { kind: "circle"; color: string };

function overlayShape(spec: FaviconSpec): string {
  switch (spec.kind) {
    case "plain":
      return "";
    case "diagonal":
      return `<path d="M32 0 V32 H0 Z" fill="${spec.color}"/>`;
    case "triangle": {
      const points =
        spec.direction === "up"
          ? "M16 7 L26 25 L6 25 Z"
          : spec.direction === "down"
            ? "M6 7 L26 7 L16 25 Z"
            : "M25 7 L7 13 L19 25 Z";
      return `<path d="${points}" fill="${spec.color}"/>`;
    }
    case "corner-square":
      return `<rect x="18" y="5" width="9" height="9" rx="1.5" fill="${spec.color}"/>`;
    case "circle":
      return `<circle cx="16" cy="16" r="7.5" fill="${spec.color}"/>`;
  }
}

export function faviconSvg(spec: FaviconSpec): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<clipPath id="r"><rect width="32" height="32" rx="6"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="32" height="32" fill="#000000"/>${overlayShape(spec)}</g>` +
    `</svg>`
  );
}

let appliedHref: string | null = null;

/** Swap the document's icon link to the spec's data URI (no-op when unchanged). */
export function applyFavicon(spec: FaviconSpec): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(spec))}`;
  if (href === appliedHref) return;
  appliedHref = href;
  link.href = href;
}
