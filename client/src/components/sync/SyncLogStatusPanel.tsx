import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { SyncSourceStatusRow, SyncStatusResponse } from "../../types";
import { cn } from "../../cn";
import { useSyncForceStaleMutation } from "../../queries/hooks";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows, RowFacts, StatusWord, type StatusTone } from "../ui/OpenRows";
import { formatWhen, parseStoredInstant } from "../../storedInstant";
import { formatDayKindLabel, formatNextSyncLabel } from "./formatSyncSchedule";
import styles from "./SyncLogStatusPanel.module.css";
import { Button } from "@crfrsr/ui";

function formatRemaining(ms: number): string {
  if (ms <= 0) return i18n.t("importSync.sync.agoNow");
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${h} h ${remMin} min` : `${h} h`;
}

function formatAgo(msAgo: number): string {
  if (msAgo < 0) return i18n.t("importSync.sync.agoNow");
  const totalSec = Math.max(1, Math.floor(msAgo / 1000));
  if (totalSec < 60) return i18n.t("importSync.sync.agoSeconds", { n: totalSec });
  const min = Math.floor(totalSec / 60);
  if (min < 60) return i18n.t("importSync.sync.agoMinutes", { n: min });
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  const day = Math.floor(h / 24);
  if (day >= 1) {
    return day === 1 ? i18n.t("importSync.sync.agoDay") : i18n.t("importSync.sync.agoDays", { n: day });
  }
  return remMin > 0
    ? i18n.t("importSync.sync.agoHoursMinutes", { h, m: remMin })
    : i18n.t("importSync.sync.agoHours", { n: h });
}

/** Stale only because the publisher has not released the expected day yet reads as waiting, not as a fault. */
function statusTone(row: SyncSourceStatusRow): StatusTone {
  if (row.publisher_lag) return "active";
  if (row.status === "stale") return "bad";
  return row.status === "ok" ? "ok" : "muted";
}

/**
 * The market-data sources of the global sync: one line per source (its state, its next sync, and
 * the day when it is not a trading day) that opens into the rest, with «Mark stale» on an
 * up-to-date source.
 */
export function SyncLogStatusPanel({
  status,
  loading,
}: {
  status: SyncStatusResponse | undefined;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const forceStale = useSyncForceStaleMutation();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // No status yet: dashes, never «never synced» or «scheduler off» (those are answers, not loading).
  // Worded at render: both lines follow the clock and the language.
  const lastAtMs = status?.last_sync_at ? parseStoredInstant(status.last_sync_at).getTime() : Number.NaN;
  const lastLine = !status
    ? "—"
    : !status.last_sync_at || Number.isNaN(lastAtMs)
      ? t("importSync.sync.lastSyncNever")
      : t("importSync.sync.lastSync", { time: formatWhen(status.last_sync_at), ago: formatAgo(nowMs - lastAtMs) });

  const sched = status?.scheduler;
  const nextLine = !sched
    ? "—"
    : !sched.enabled
      ? t("importSync.sync.schedulerOff")
      : sched.in_flight
        ? t("importSync.sync.inFlight")
        : !sched.next_check_at
          ? t("importSync.sync.nextCheckUnknown")
          : t("importSync.sync.nextCheck", {
              time: formatWhen(sched.next_check_at),
              remaining: formatRemaining(parseStoredInstant(sched.next_check_at).getTime() - nowMs),
            });

  return (
    <div className={loadableClass(loading, styles.panel)}>
      <p className={cn("muted", styles.scheduleLine)}>{lastLine}</p>
      <p className={cn("muted", styles.scheduleLine)}>{nextLine}</p>
      <OpenRows>
        {(status?.sources ?? []).map((row) => {
          const next = formatNextSyncLabel(row, t);
          const dayKind = formatDayKindLabel(row.today_day_kind, t);
          const lag = row.publisher_lag
            ? t("importSync.sync.publisherLagDetail", {
                published: row.publisher_lag.published_ymd,
                expected: row.publisher_lag.expected_ymd,
                checked: formatWhen(row.publisher_lag.last_checked_at),
              })
            : null;
          const firstParts = [
            row.next_sync_imminent || row.next_sync ? t("importSync.sync.nextLine", { when: next }) : null,
            row.today_day_kind !== "open" ? t("importSync.sync.todayIs", { kind: dayKind }) : null,
          ].filter((p): p is string => p != null);
          return (
            <OpenRow
              key={row.source}
              title={t(`importSync.sync.sources.${row.source}`)}
              status={
                <StatusWord tone={statusTone(row)}>
                  {row.publisher_lag
                    ? t("importSync.sync.statusWaitingPublisher")
                    : row.status === "stale"
                      ? t("importSync.sync.statusStale")
                      : row.status === "disabled"
                        ? t("importSync.sync.statusDisabled")
                        : t("importSync.sync.statusOk")}
                </StatusWord>
              }
              first={lag ?? firstParts.join(" · ")}
              action={
                row.status === "ok" ? (
                  <Button variant="secondary" size="sm" disabled={forceStale.isPending} onClick={() => forceStale.mutate(row.source)}>
                    {forceStale.isPending && forceStale.variables === row.source
                      ? t("importSync.sync.forceStalePending")
                      : t("importSync.sync.forceStale")}
                  </Button>
                ) : null
              }
            >
              <RowFacts
                facts={[
                  [t("importSync.sync.colNextSync"), next],
                  [t("importSync.sync.colHolidayToday"), dayKind],
                  [t("importSync.sync.factPublisher"), lag],
                ]}
              />
            </OpenRow>
          );
        })}
      </OpenRows>
      {forceStale.error ? <p className="error">{forceStale.error.message}</p> : null}
    </div>
  );
}
