import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { SyncSourceDisplayStatus, SyncStatusResponse } from "../../types";
import { cn } from "../../cn";
import { useSyncForceStaleMutation } from "../../queries/hooks";
import { Table } from "../ui/Table";
import { formatDayKindLabel, formatNextSyncLabel } from "./formatSyncSchedule";
import styles from "./SyncLogStatusPanel.module.css";

function formatWhenEs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

function parseCreatedAtMs(iso: string): number {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return d.getTime();
}

function formatRemainingEs(ms: number): string {
  if (ms <= 0) return "ahora";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${h} h ${remMin} min` : `${h} h`;
}

function formatAgoEs(msAgo: number): string {
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

function statusLabel(
  t: (key: string) => string,
  status: SyncSourceDisplayStatus
): string {
  if (status === "stale") return t("importSync.sync.statusStale");
  if (status === "disabled") return t("importSync.sync.statusDisabled");
  return t("importSync.sync.statusOk");
}

export function SyncLogStatusPanel({ status }: { status: SyncStatusResponse }) {
  const { t } = useTranslation();
  const forceStale = useSyncForceStaleMutation();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const lastLine = useMemo(() => {
    if (!status.last_sync_at) return t("importSync.sync.lastSyncNever");
    const atMs = parseCreatedAtMs(status.last_sync_at);
    if (Number.isNaN(atMs)) return t("importSync.sync.lastSyncNever");
    return t("importSync.sync.lastSync", {
      time: formatWhenEs(status.last_sync_at),
      ago: formatAgoEs(nowMs - atMs),
    });
  }, [status.last_sync_at, nowMs, t]);

  const nextLine = useMemo(() => {
    const sched = status.scheduler;
    if (!sched.enabled) return t("importSync.sync.schedulerOff");
    if (sched.in_flight) return t("importSync.sync.inFlight");
    if (!sched.next_check_at) return t("importSync.sync.nextCheckUnknown");
    const at = parseCreatedAtMs(sched.next_check_at);
    const remaining = formatRemainingEs(at - nowMs);
    return t("importSync.sync.nextCheck", {
      time: formatWhenEs(sched.next_check_at),
      remaining,
    });
  }, [status.scheduler, nowMs, t]);

  return (
    <div className={styles.panel}>
      <p className={cn("muted", styles.scheduleLine)}>{lastLine}</p>
      <p className={cn("muted", styles.scheduleLine)}>{nextLine}</p>
      <div className={styles.tableWrap}>
        <Table
          header={
            <thead>
              <tr>
                <th>{t("importSync.sync.colSource")}</th>
                <th>{t("importSync.sync.colNextSync")}</th>
                <th>{t("importSync.sync.colHolidayToday")}</th>
                <th>{t("importSync.sync.colStatus")}</th>
                <th className={styles.colActions} />
              </tr>
            </thead>
          }
        >
          {status.sources.map((row) => (
            <tr key={row.source}>
              <td>{t(`importSync.sync.sources.${row.source}`)}</td>
              <td className="muted">{formatNextSyncLabel(row, t)}</td>
              <td className="muted">{formatDayKindLabel(row.today_day_kind, t)}</td>
              <td>
                <span
                  className={cn(
                    row.status === "stale" && styles.badgeStale,
                    row.status === "ok" && styles.badgeOk,
                    row.status !== "stale" && row.status !== "ok" && styles.badgeMuted
                  )}
                >
                  {statusLabel(t, row.status)}
                </span>
              </td>
              <td className={styles.colActions}>
                {row.status === "ok" ? (
                  <button
                    type="button"
                    className={cn("btn", styles.forceStaleBtn)}
                    disabled={forceStale.isPending}
                    onClick={() => forceStale.mutate(row.source)}
                  >
                    {forceStale.isPending && forceStale.variables === row.source
                      ? t("importSync.sync.forceStalePending")
                      : t("importSync.sync.forceStale")}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}
