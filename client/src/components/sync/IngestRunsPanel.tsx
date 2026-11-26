import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateResources, resources } from "../../queries/resources";
import { Button } from "@crfrsr/ui";
import type { IngestRunSummary, IngestRunsStatusResponse } from "../../types";
import { cn } from "../../cn";
import { DEMO_BUILD } from "../../dashboardPath";
import { useStartIngestRunMutation } from "../../queries/hooks";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows, RowFacts, StatusWord, type StatusTone } from "../ui/OpenRows";
import { formatWhen } from "../../storedInstant";
import styles from "./SyncLogStatusPanel.module.css";

function statusTone(run: IngestRunSummary): StatusTone {
  if (run.status === "done") return "ok";
  if (run.status === "requested") return "active";
  if (run.status === "failed" || run.status === "lost") return "bad";
  return "muted";
}

/**
 * The hosted demo runs no ingest service: its run history is generated from its documents, so
 * there is nothing to start and no next run to wait for.
 */
const LIVE_SCHEDULE = !DEMO_BUILD;

/**
 * The ingest service's two runs (the hourly e-mail poll and the nightly) with a button to start
 * either now instead of waiting for its slot — a statement mail that just landed. The run is
 * queued (docs/job-queue-plan.md) and starts as soon as the ingest service is free; the server
 * decides what it carries. One line per run (when it last ran, its outcome, its next slot) that
 * opens into the latest run's detail.
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
    if (previousInFlight.current != null && inFlightId == null) void invalidateResources(queryClient, resources.everything());
    previousInFlight.current = inFlightId;
  }, [inFlightId, queryClient]);

  const canStart = status != null && status.scheduler_enabled && !startRun.isPending;

  const headline = !LIVE_SCHEDULE
    ? t("importSync.ingest.demoGenerated")
    : !status
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
      <OpenRows>
        {(status?.kinds ?? []).map((row) => {
          const latest = row.latest;
          return (
            <OpenRow
              key={row.kind}
              lead={latest ? formatWhen(latest.finished_at ?? latest.requested_at) : "—"}
              title={t(`importSync.ingest.kinds.${row.kind}`)}
              status={
                latest ? (
                  <StatusWord tone={statusTone(latest)}>{t(`importSync.ingest.status.${latest.status}`)}</StatusWord>
                ) : (
                  <StatusWord tone="muted">{t("importSync.ingest.never")}</StatusWord>
                )
              }
              first={
                latest?.failed_steps
                  ? t("importSync.ingest.failedSteps", { n: latest.failed_steps })
                  : latest?.error
                    ? latest.error
                    : LIVE_SCHEDULE
                      ? t("importSync.ingest.nextAt", { time: formatWhen(row.next_slot_at) })
                      : ""
              }
              action={
                LIVE_SCHEDULE ? (
                  <Button variant="secondary" size="sm" disabled={!canStart} onClick={() => startRun.mutate(row.kind)}>
                    {startRun.isPending && startRun.variables === row.kind
                      ? t("importSync.ingest.runNowPending")
                      : t("importSync.ingest.runNow")}
                  </Button>
                ) : null
              }
            >
              {/* The demo has no next slot: a kind that never ran has nothing to open. */}
              {latest || LIVE_SCHEDULE ? (
                <RowFacts
                  facts={[
                    [t("importSync.ingest.factReason"), latest?.reason],
                    [t("importSync.ingest.factRequested"), latest?.requested_at ? formatWhen(latest.requested_at) : null],
                    [t("importSync.ingest.factFinished"), latest?.finished_at ? formatWhen(latest.finished_at) : null],
                    [
                      t("importSync.ingest.factFailedSteps"),
                      latest?.failed_steps ? t("importSync.ingest.failedSteps", { n: latest.failed_steps }) : null,
                    ],
                    [t("importSync.ingest.factError"), latest?.error],
                    [t("importSync.ingest.colNext"), LIVE_SCHEDULE ? formatWhen(row.next_slot_at) : null],
                  ]}
                />
              ) : null}
            </OpenRow>
          );
        })}
      </OpenRows>
      {startRun.error ? <p className="error">{startRun.error.message}</p> : null}
    </div>
  );
}
