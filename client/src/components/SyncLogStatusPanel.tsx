import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SyncSourceDisplayStatus, SyncStatusResponse } from "../types";
import { cn } from "../cn";
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
  if (msAgo < 0) return "ahora";
  const totalSec = Math.max(1, Math.floor(msAgo / 1000));
  if (totalSec < 60) return `hace ${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  const day = Math.floor(h / 24);
  if (day >= 1) return day === 1 ? "hace 1 día" : `hace ${day} días`;
  return remMin > 0 ? `hace ${h} h ${remMin} min` : `hace ${h} h`;
}

function statusLabel(
  t: (key: string) => string,
  status: SyncSourceDisplayStatus
): string {
  if (status === "stale") return t("messages.sync.statusStale");
  if (status === "disabled") return t("messages.sync.statusDisabled");
  return t("messages.sync.statusOk");
}

export function SyncLogStatusPanel({ status }: { status: SyncStatusResponse }) {
  const { t } = useTranslation();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const lastLine = useMemo(() => {
    if (!status.last_sync_at) return t("messages.sync.lastSyncNever");
    const atMs = parseCreatedAtMs(status.last_sync_at);
    if (Number.isNaN(atMs)) return t("messages.sync.lastSyncNever");
    return t("messages.sync.lastSync", {
      time: formatWhenEs(status.last_sync_at),
      ago: formatAgoEs(nowMs - atMs),
    });
  }, [status.last_sync_at, nowMs, t]);

  const nextLine = useMemo(() => {
    const sched = status.scheduler;
    if (!sched.enabled) return t("messages.sync.schedulerOff");
    if (sched.in_flight) return t("messages.sync.inFlight");
    if (!sched.next_check_at) return t("messages.sync.nextCheckUnknown");
    const at = parseCreatedAtMs(sched.next_check_at);
    const remaining = formatRemainingEs(at - nowMs);
    return t("messages.sync.nextCheck", {
      time: formatWhenEs(sched.next_check_at),
      remaining,
    });
  }, [status.scheduler, nowMs, t]);

  return (
    <div className={styles.panel}>
      <p className={cn("muted", styles.scheduleLine)}>{lastLine}</p>
      <p className={cn("muted", styles.scheduleLine)}>{nextLine}</p>
      <ul className={styles.sourceList}>
        {status.sources.map((row) => (
          <li key={row.source} className={styles.sourceRow}>
            <span className={styles.sourceName}>{t(`messages.sync.sources.${row.source}`)}</span>
            <span
              className={cn(
                row.status === "stale" && styles.badgeStale,
                row.status === "ok" && styles.badgeOk,
                row.status !== "stale" && row.status !== "ok" && styles.badgeMuted
              )}
            >
              {statusLabel(t, row.status)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
