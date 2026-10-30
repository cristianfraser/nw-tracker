import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@crfrsr/ui";
import type { IngestRunSummary, IngestRunsStatusResponse } from "../../types";
import { cn } from "../../cn";
import { formatDateTimeLabel } from "../../formatDateLabel";
import { useStartIngestRunMutation } from "../../queries/hooks";
import { loadableClass } from "../ui/Loadable";
import { Table } from "../ui/Table";
import styles from "./SyncLogStatusPanel.module.css";

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTimeLabel(d);
}

function statusClass(run: IngestRunSummary): string {
  if (run.status === "done") return styles.badgeOk;
  if (run.status === "requested") return styles.badgeWaiting;
  if (run.status === "failed" || run.status === "lost") return styles.badgeStale;
  return styles.badgeMuted;
}

/**
 * The ingest service's two runs (the hourly e-mail poll and the nightly) with a button to start
 * either now instead of waiting for its slot — a statement mail that just landed. The run is
 * queued (docs/job-queue-plan.md) and starts as soon as the ingest service is free; the server
 * decides what it carries.
 */
export function IngestRunsPanel({
  status,
  loading,
}: {
  status: IngestRunsStatusResponse | undefined;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const startRun = useStartIngestRunMutation();

  // A run that finishes has imported data: refetch every page's queries, as on the day rollover.
  const inFlightId = status?.in_flight?.id ?? null;
  const previousInFlight = useRef<number | null>(null);
  useEffect(() => {
    if (previousInFlight.current != null && inFlightId == null) void queryClient.invalidateQueries();
    previousInFlight.current = inFlightId;
  }, [inFlightId, queryClient]);

  const canStart = status != null && status.scheduler_enabled && !startRun.isPending;

  const headline = !status
    ? "—"
    : !status.scheduler_enabled
      ? t("importSync.ingest.schedulerOff")
      : status.in_flight
        ? t("importSync.ingest.inFlight", {
            kind: t(`importSync.ingest.kinds.${status.in_flight.kind}`),
            time: formatWhen(status.in_flight.requested_at),
          })
        : t("importSync.ingest.idle");

  return (
    <div className={loadableClass(loading, styles.panel)}>
      <p className={cn("muted", styles.scheduleLine)}>{headline}</p>
      <div className={styles.tableWrap}>
        <Table
          header={
            <thead>
              <tr>
                <th>{t("importSync.ingest.colRun")}</th>
                <th>{t("importSync.ingest.colLatest")}</th>
                <th>{t("importSync.ingest.colNext")}</th>
                <th className={styles.colActions} />
              </tr>
            </thead>
          }
        >
          {(status?.kinds ?? []).map((row) => (
            <tr key={row.kind}>
              <td>{t(`importSync.ingest.kinds.${row.kind}`)}</td>
              <td>
                {row.latest ? (
                  <>
                    <span className={statusClass(row.latest)}>{t(`importSync.ingest.status.${row.latest.status}`)}</span>{" "}
                    <span className="muted">{formatWhen(row.latest.finished_at ?? row.latest.requested_at)}</span>
                    {row.latest.failed_steps ? (
                      <div className={cn("muted", styles.lagDetail)}>
                        {t("importSync.ingest.failedSteps", { n: row.latest.failed_steps })}
                      </div>
                    ) : null}
                    {row.latest.error ? <div className={cn("muted", styles.lagDetail)}>{row.latest.error}</div> : null}
                  </>
                ) : (
                  <span className="muted">{t("importSync.ingest.never")}</span>
                )}
              </td>
              <td className="muted">{formatWhen(row.next_slot_at)}</td>
              <td className={styles.colActions}>
                <Button variant="secondary" disabled={!canStart} onClick={() => startRun.mutate(row.kind)}>
                  {startRun.isPending && startRun.variables === row.kind
                    ? t("importSync.ingest.runNowPending")
                    : t("importSync.ingest.runNow")}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </div>
      {startRun.error ? <p className="error">{startRun.error.message}</p> : null}
    </div>
  );
}
