import { db } from "../db.js";

/** Empty the job queue (and unlink the ingest runs that point at it) before a test. */
export function clearJobs(): void {
  db.prepare(`UPDATE ingest_runs SET job_id = NULL WHERE job_id IS NOT NULL`).run();
  db.prepare(`DELETE FROM jobs`).run();
}
