import { formatDateTimeLabel } from "./formatDateLabel";

/** An ISO instant, or SQLite's «YYYY-MM-DD HH:MM:SS» (UTC, as `app_messages.created_at` stores it). */
export function parseStoredInstant(iso: string): Date {
  return new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
}

/** A stored instant on the viewer's clock («—» for none; the text itself when it is no date). */
export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = parseStoredInstant(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTimeLabel(d);
}
