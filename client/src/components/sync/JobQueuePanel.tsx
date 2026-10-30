import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@crfrsr/ui";
import type { JobQueueResponse, JobView, JobWaitView } from "../../types";
import { cn } from "../../cn";
import { formatDateTimeLabel } from "../../formatDateLabel";
import { useJobActionMutation } from "../../queries/hooks";
import { loadableClass } from "../ui/Loadable";
import { Table } from "../ui/Table";
import styles from "./SyncLogStatusPanel.module.css";

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTimeLabel(d);
}

function statusClass(job: JobView): string {
  if (job.status === "done") return styles.badgeOk;
  if (job.status === "running" || job.status === "queued") return styles.badgeWaiting;
  if (job.status === "failed" || job.status === "lost") return styles.badgeStale;
  return styles.badgeMuted;
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

/**
 * The job queue (docs/job-queue-plan.md): what runs, what waits and why, and the latest finished
 * jobs, with Cancel for a queued job and Retry for a failed or lost run. Everything shown is the
 * server's: this component only words it.
 */
export function JobQueuePanel({ queue, loading }: { queue: JobQueueResponse | undefined; loading?: boolean }) {
  const { t } = useTranslation();
  const action = useJobActionMutation();
  const rows = queue ? [...queue.running, ...queue.queued, ...queue.recent] : [];
  const pending = (job: JobView, kind: "cancel" | "retry") => action.isPending && action.variables?.id === job.id && action.variables.action === kind;

  return (
    <div className={loadableClass(loading, styles.panel)}>
      <p className={cn("muted", styles.scheduleLine)}>
        {queue
          ? t("importSync.jobs.summary", { running: queue.running.length, queued: queue.queued.length })
          : "—"}
      </p>
      <div className={styles.tableWrap}>
        <Table
          header={
            <thead>
              <tr>
                <th>{t("importSync.jobs.colJob")}</th>
                <th>{t("importSync.jobs.colStatus")}</th>
                <th>{t("importSync.jobs.colWhen")}</th>
                <th>{t("importSync.jobs.colDetail")}</th>
                <th className={styles.colActions} />
              </tr>
            </thead>
          }
        >
          {rows.map((job) => (
            <tr key={job.id}>
              <td>
                {kindLabel(t, job.kind_slug)} <span className="muted">#{job.id}</span>
                <div className={cn("muted", styles.lagDetail)}>{job.reason}</div>
              </td>
              <td>
                <span className={statusClass(job)}>{t(`importSync.jobs.status.${job.status}`)}</span>
              </td>
              <td className="muted">{formatWhen(job.finished_at ?? job.started_at ?? job.not_before ?? job.created_at)}</td>
              <td className={cn("muted", styles.lagDetail)}>{detail(t, job)}</td>
              <td className={styles.colActions}>
                {job.can_cancel ? (
                  <Button variant="secondary" disabled={action.isPending} onClick={() => action.mutate({ id: job.id, action: "cancel" })}>
                    {pending(job, "cancel") ? t("importSync.jobs.cancelPending") : t("importSync.jobs.cancel")}
                  </Button>
                ) : null}
                {job.can_retry ? (
                  <Button variant="secondary" disabled={action.isPending} onClick={() => action.mutate({ id: job.id, action: "retry" })}>
                    {pending(job, "retry") ? t("importSync.jobs.retryPending") : t("importSync.jobs.retry")}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </div>
      {queue && rows.length === 0 ? <p className="muted">{t("importSync.jobs.empty")}</p> : null}
      {action.error ? <p className="error">{action.error.message}</p> : null}
    </div>
  );
}
