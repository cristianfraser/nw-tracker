import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@crfrsr/ui";
import type { JobQueueResponse, JobView, JobWaitView } from "../../types";
import { cn } from "../../cn";
import { DEMO_BUILD } from "../../dashboardPath";
import { useJobActionMutation } from "../../queries/hooks";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows, RowFacts, StatusWord, type StatusTone } from "../ui/OpenRows";
import { formatWhen } from "../../storedInstant";
import styles from "./SyncLogStatusPanel.module.css";

/** Finished jobs shown before «Show more…» (running and waiting jobs always show). */
const COLLAPSED_FINISHED = 5;

function statusTone(job: JobView): StatusTone {
  if (job.status === "done") return "ok";
  if (job.status === "running" || job.status === "queued") return "active";
  if (job.status === "failed" || job.status === "lost") return "bad";
  return "muted";
}

function kindLabel(t: TFunction, slug: string): string {
  return t(`importSync.jobs.kinds.${slug}`);
}

/** The server says why a job waits; the page only words it. */
function waitingLabel(t: TFunction, w: JobWaitView): string {
  switch (w.code) {
    case "not_before":
      return t("importSync.jobs.waiting.notBefore", { time: formatWhen(w.at) });
    case "resource":
      return t("importSync.jobs.waiting.resource", {
        resource: t(`importSync.jobs.resources.${w.resource}`),
        kind: kindLabel(t, w.held_by.kind_slug),
        id: w.held_by.id,
      });
    case "exclusive":
      return t("importSync.jobs.waiting.exclusive", { kind: kindLabel(t, w.held_by.kind_slug), id: w.held_by.id });
    case "draining":
      return t("importSync.jobs.waiting.draining", { kind: kindLabel(t, w.for_job.kind_slug), id: w.for_job.id });
  }
}

function detail(t: TFunction, job: JobView): string | null {
  if (job.status === "queued") return job.waiting ? waitingLabel(t, job.waiting) : t("importSync.jobs.waiting.next");
  if (job.status === "running") {
    return t("importSync.jobs.runningDetail", {
      worker: job.worker ?? "—",
      heartbeat: formatWhen(job.heartbeat_at),
      lease: formatWhen(job.lease_expires_at),
    });
  }
  if (job.ingest_run?.failed_steps) return t("importSync.ingest.failedSteps", { n: job.ingest_run.failed_steps });
  return job.error;
}

/** The hosted demo runs no queue: its history is generated, so there is nothing to cancel or retry. */
const JOB_ACTIONS_SHOWN = !DEMO_BUILD;

/**
 * The job queue (docs/job-queue-plan.md): what runs, what waits and why, and the latest finished
 * jobs, with Cancel for a queued job and Retry for a failed or lost run. One line per job — when,
 * what, its state, and why it waits or what went wrong — that opens into the rest. Everything
 * shown is the server's: this component only words it.
 */
export function JobQueuePanel({ queue, loading }: { queue: JobQueueResponse | undefined; loading?: boolean }) {
  const { t } = useTranslation();
  const action = useJobActionMutation();
  const [expanded, setExpanded] = useState(false);
  const live = queue ? [...queue.running, ...queue.queued] : [];
  const finished = queue?.recent ?? [];
  const hasHidden = finished.length > COLLAPSED_FINISHED;
  const rows = [...live, ...(hasHidden && !expanded ? finished.slice(0, COLLAPSED_FINISHED) : finished)];
  const pending = (job: JobView, kind: "cancel" | "retry") => action.isPending && action.variables?.id === job.id && action.variables.action === kind;
  const actionFor = (job: JobView) => {
    if (!JOB_ACTIONS_SHOWN) return null;
    if (job.can_cancel) {
      return (
        <Button variant="secondary" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: job.id, action: "cancel" })}>
          {pending(job, "cancel") ? t("importSync.jobs.cancelPending") : t("importSync.jobs.cancel")}
        </Button>
      );
    }
    if (job.can_retry) {
      return (
        <Button variant="secondary" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: job.id, action: "retry" })}>
          {pending(job, "retry") ? t("importSync.jobs.retryPending") : t("importSync.jobs.retry")}
        </Button>
      );
    }
    return null;
  };

  return (
    <div className={loadableClass(loading, styles.panel)}>
      <p className={cn("muted", styles.scheduleLine)}>
        {queue
          ? t("importSync.jobs.summary", { running: queue.running.length, queued: queue.queued.length })
          : "—"}
      </p>
      <OpenRows empty={queue && rows.length === 0 ? t("importSync.jobs.empty") : undefined}>
        {rows.map((job) => (
          <OpenRow
            key={job.id}
            lead={formatWhen(job.finished_at ?? job.started_at ?? job.not_before ?? job.created_at)}
            title={
              <>
                {kindLabel(t, job.kind_slug)} <span className="muted">#{job.id}</span>
              </>
            }
            status={<StatusWord tone={statusTone(job)}>{t(`importSync.jobs.status.${job.status}`)}</StatusWord>}
            first={detail(t, job) ?? job.reason}
            action={actionFor(job)}
          >
            <RowFacts
              facts={[
                [t("importSync.jobs.factReason"), job.reason],
                [t("importSync.jobs.factEnqueuedBy"), job.enqueued_by],
                [t("importSync.jobs.colDetail"), detail(t, job)],
                [t("importSync.jobs.factResources"), job.resources.map((r) => t(`importSync.jobs.resources.${r}`)).join(", ")],
                [t("importSync.jobs.factWorker"), job.worker],
                [t("importSync.jobs.factCreated"), formatWhen(job.created_at)],
                [t("importSync.jobs.factNotBefore"), job.not_before ? formatWhen(job.not_before) : null],
                [t("importSync.jobs.factStarted"), job.started_at ? formatWhen(job.started_at) : null],
                [t("importSync.jobs.factFinished"), job.finished_at ? formatWhen(job.finished_at) : null],
                [t("importSync.jobs.factError"), job.error],
              ]}
            />
          </OpenRow>
        ))}
      </OpenRows>
      {hasHidden ? (
        <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
          {expanded ? t("importSync.showLess") : t("importSync.showMore")}
        </Button>
      ) : null}
      {action.error ? <p className="error">{action.error.message}</p> : null}
    </div>
  );
}
