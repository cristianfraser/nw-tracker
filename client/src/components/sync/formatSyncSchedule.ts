import type { SyncSourceDayKind, SyncSourceStatusRow } from "../../types";

function calendarYmdInTimeZone(timeZone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) return "";
  return `${y}-${m}-${d}`;
}

function addCalendarDaysYmd(ymd: string, delta: number): string {
  const [ys, ms, ds] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(ys!, ms! - 1, ds! + delta));
  return dt.toISOString().slice(0, 10);
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatNextSyncLabel(
  row: SyncSourceStatusRow,
  t: (key: string, opts?: Record<string, string>) => string
): string {
  if (row.status === "disabled") return t("importSync.sync.nextSyncDash");
  if (row.next_sync_imminent) return t("importSync.sync.nextSyncNow");
  if (!row.next_sync) return t("importSync.sync.nextSyncDash");

  const { ymd, hour, minute, timeZone } = row.next_sync;
  const time = formatClock(hour, minute);
  const today = calendarYmdInTimeZone(timeZone);
  const tomorrow = addCalendarDaysYmd(today, 1);
  if (ymd === today) return t("importSync.sync.nextSyncToday", { time });
  if (ymd === tomorrow) return t("importSync.sync.nextSyncTomorrow", { time });
  const [, mm, dd] = ymd.split("-");
  return t("importSync.sync.nextSyncDate", { date: `${dd}-${mm}`, time });
}

export function formatDayKindLabel(
  kind: SyncSourceDayKind,
  t: (key: string) => string
): string {
  return t(`importSync.sync.dayKind.${kind}`);
}
