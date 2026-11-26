import type { TFunction } from "i18next";

/** «3 sales» / «1 sale»: the app has no plural suffixes, so a count picks its own key at 1. */
export function countLabel(t: TFunction, key: string, oneKey: string, count: number): string {
  return t(count === 1 ? oneKey : key, { count });
}
