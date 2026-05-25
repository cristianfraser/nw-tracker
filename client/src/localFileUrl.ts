/** Turn an absolute filesystem path into a `file:` URL for use in `<a href>`. */
export function absolutePathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  return `file:///${encoded}`;
}
