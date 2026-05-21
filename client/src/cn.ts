type ClassValue = string | false | null | undefined;

/** Join class names; falsy values are omitted. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
