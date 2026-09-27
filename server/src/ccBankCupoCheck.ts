import { db } from "./db.js";
import { chileWallClockAt } from "./chileDate.js";
import { ccOwedByCurrency, type CcOwedByCurrency } from "./ccOwedByCurrency.js";

/**
 * The bank's cupo utilizado per card and currency (`santanderBankCupo.ts`) against what the app
 * says the card owes in that currency (`ccOwedByCurrency.ts`), judged once per snapshot, right
 * after the import that recorded it — `check:cc-bank-cupo`, a nightly step that fails on a
 * mismatch.
 *
 * The two sides share the bank's identity (utilizado = SALDO INICIAL + saldo capital cuotas +
 * unbilled feed rows), so they agree to the cent in dollars and within a peso per unbilled cuota
 * in pesos — the app splits a plan's unbilled cuotas with the remainder on the last one, the bank
 * rounds each; everything else is a real difference. A snapshot whose feed states another close
 * than the app's latest is not comparable (`indeterminate`): the two sides would frame the debt
 * across different facturaciones.
 */
export type BankCupoCheckStatus = "ok" | "mismatch" | "indeterminate";

export type BankCupoSnapshot = {
  id: number;
  account_id: number;
  currency: "clp" | "usd";
  observed_at: string;
  plastic_last4: string;
  cupo_total: number;
  cupo_utilizado: number;
  cupo_disponible: number;
  feed_close_iso: string | null;
};

export type BankCupoJudgement = {
  status: BankCupoCheckStatus;
  app_owed: number | null;
  diff: number | null;
  tolerance: number | null;
  reason: string | null;
};

export type BankCupoVerdict = BankCupoJudgement & {
  snapshot: BankCupoSnapshot;
  owed: CcOwedByCurrency | null;
  /** Judged by this run (false: an earlier run's verdict on the same snapshot). */
  fresh: boolean;
};

export function judgeBankCupo(snapshot: BankCupoSnapshot, owed: CcOwedByCurrency): BankCupoJudgement {
  if (snapshot.feed_close_iso != null && owed.close_iso !== snapshot.feed_close_iso) {
    return {
      status: "indeterminate",
      app_owed: null,
      diff: null,
      tolerance: null,
      reason:
        `the feed states the close ${snapshot.feed_close_iso} but the app's latest is ` +
        `${owed.close_iso ?? "none"}`,
    };
  }
  if (snapshot.currency === "clp") {
    const diff = Math.round(owed.clp.total - snapshot.cupo_utilizado);
    const tolerance = owed.clp.remaining_cuotas;
    return {
      status: Math.abs(diff) <= tolerance ? "ok" : "mismatch",
      app_owed: owed.clp.total,
      diff,
      tolerance,
      reason: null,
    };
  }
  const diff = Math.round((owed.usd.total - snapshot.cupo_utilizado) * 100) / 100;
  return {
    status: diff === 0 ? "ok" : "mismatch",
    app_owed: owed.usd.total,
    diff,
    tolerance: 0,
    reason: null,
  };
}

type CaptureRow = {
  id: number;
  source_file: string;
  observed_at: string | null;
  error: string | null;
  checked_at: string | null;
};

const selLatestCapture = db.prepare(
  `SELECT id, source_file, observed_at, error, checked_at FROM cc_bank_cupo_captures ORDER BY id DESC LIMIT 1`
);
const markCaptureChecked = db.prepare(`UPDATE cc_bank_cupo_captures SET checked_at = datetime('now') WHERE id = ?`);
const selCaptureSnapshots = db.prepare(
  `SELECT s.id, s.account_id, s.currency, c.observed_at, s.plastic_last4, s.cupo_total, s.cupo_utilizado,
          s.cupo_disponible, s.feed_close_iso
   FROM cc_bank_cupo_snapshots s
   JOIN cc_bank_cupo_captures c ON c.id = s.capture_id
   WHERE s.capture_id = ?
   ORDER BY s.account_id, s.currency`
);
const selCheck = db.prepare(
  `SELECT status, app_owed, diff, tolerance, detail FROM cc_bank_cupo_checks WHERE snapshot_id = ?`
);
const upsertCheck = db.prepare(
  `INSERT INTO cc_bank_cupo_checks (snapshot_id, status, app_owed, diff, tolerance, detail)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(snapshot_id) DO UPDATE SET
     checked_at = datetime('now'), status = excluded.status, app_owed = excluded.app_owed,
     diff = excluded.diff, tolerance = excluded.tolerance, detail = excluded.detail`
);
const selPreviousCheck = db.prepare(
  `SELECT k.status, k.diff
   FROM cc_bank_cupo_checks k
   JOIN cc_bank_cupo_snapshots s ON s.id = k.snapshot_id
   WHERE s.account_id = ? AND s.currency = ? AND s.id < ?
   ORDER BY s.id DESC LIMIT 1`
);

type CheckDetail = { reason: string | null; owed: CcOwedByCurrency | null };

export type BankCupoRun = {
  capture: {
    id: number;
    source_file: string;
    observed_at: string | null;
    /** An earlier run already reported this capture. */
    already_checked: boolean;
  } | null;
  /** The fetcher's reason when the latest feed carried no summary. */
  capture_error: string | null;
  verdicts: BankCupoVerdict[];
};

/**
 * Judge the latest capture's snapshots — only the latest: an older one describes a ledger state
 * that later imports have moved on from. A snapshot is judged once; `recheck` judges it again
 * against the ledger as it stands now.
 */
export function judgeLatestBankCupoCapture(opts?: {
  recheck?: boolean;
  owedFor?: (accountId: number, asOfIso: string) => CcOwedByCurrency;
}): BankCupoRun {
  const owedFor = opts?.owedFor ?? ccOwedByCurrency;
  const capture = selLatestCapture.get() as CaptureRow | undefined;
  if (!capture) return { capture: null, capture_error: null, verdicts: [] };
  const header = {
    id: capture.id,
    source_file: capture.source_file,
    observed_at: capture.observed_at,
    already_checked: capture.checked_at != null && !opts?.recheck,
  };
  markCaptureChecked.run(capture.id);
  if (capture.error != null) return { capture: header, capture_error: capture.error, verdicts: [] };

  const verdicts: BankCupoVerdict[] = [];
  for (const snapshot of selCaptureSnapshots.all(capture.id) as BankCupoSnapshot[]) {
    const stored = selCheck.get(snapshot.id) as
      | { status: BankCupoCheckStatus; app_owed: number | null; diff: number | null; tolerance: number | null; detail: string }
      | undefined;
    if (stored && !opts?.recheck) {
      const detail = JSON.parse(stored.detail) as CheckDetail;
      verdicts.push({
        snapshot,
        status: stored.status,
        app_owed: stored.app_owed,
        diff: stored.diff,
        tolerance: stored.tolerance,
        reason: detail.reason,
        owed: detail.owed,
        fresh: false,
      });
      continue;
    }
    const owed = owedFor(snapshot.account_id, chileWallClockAt(new Date(snapshot.observed_at)).ymd);
    const judgement = judgeBankCupo(snapshot, owed);
    const detail: CheckDetail = { reason: judgement.reason, owed };
    upsertCheck.run(
      snapshot.id,
      judgement.status,
      judgement.app_owed,
      judgement.diff,
      judgement.tolerance,
      JSON.stringify(detail)
    );
    verdicts.push({ ...judgement, snapshot, owed, fresh: true });
  }
  return { capture: header, capture_error: null, verdicts };
}

/**
 * Whether this run's verdicts deserve a notification: a new or changed mismatch, or a mismatch
 * that cleared (the notifications tab lists notifications only, so a resolved one would otherwise
 * sit there unresolved). Anything else is a log.
 */
export function bankCupoMessageKind(verdicts: readonly BankCupoVerdict[]): "notification" | "log" {
  for (const v of verdicts) {
    if (!v.fresh) continue;
    const prev = selPreviousCheck.get(v.snapshot.account_id, v.snapshot.currency, v.snapshot.id) as
      | { status: BankCupoCheckStatus; diff: number | null }
      | undefined;
    if (v.status === "mismatch" && (prev?.status !== "mismatch" || prev.diff !== v.diff)) return "notification";
    if (v.status !== "mismatch" && prev?.status === "mismatch") return "notification";
  }
  return "log";
}

function fmtAmount(n: number, currency: "clp" | "usd"): string {
  return currency === "clp"
    ? `$${Math.round(n).toLocaleString("es-CL")}`
    : `US$${n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSigned(n: number, currency: "clp" | "usd"): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmtAmount(Math.abs(n), currency)}`;
}

/** Plain-text report, one block per card: the bank, the app, the gap and the app's terms. */
export function formatBankCupoReport(
  verdicts: readonly BankCupoVerdict[],
  accountName: (accountId: number) => string
): string {
  const lines: string[] = [];
  let lastAccount: number | null = null;
  for (const v of verdicts) {
    const s = v.snapshot;
    if (s.account_id !== lastAccount) {
      const at = chileWallClockAt(new Date(s.observed_at));
      const hhmm = `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
      lines.push(`${accountName(s.account_id)} (·${s.plastic_last4}) — bank ${at.ymd} ${hhmm} Chile`);
      lastAccount = s.account_id;
    }
    const cur = s.currency.toUpperCase();
    const bank = fmtAmount(s.cupo_utilizado, s.currency);
    if (v.status === "indeterminate" || v.app_owed == null || v.diff == null) {
      lines.push(`  ${cur}: bank ${bank} · not comparable — ${v.reason ?? "no app figure"}`);
      continue;
    }
    const verdict = v.status === "ok" ? "ok" : "MISMATCH";
    const tolerance = s.currency === "clp" && v.tolerance ? ` (tolerance ${fmtAmount(v.tolerance, "clp")})` : "";
    lines.push(
      `  ${cur}: bank ${bank} · app ${fmtAmount(v.app_owed, s.currency)} · ${fmtSigned(v.diff, s.currency)}${tolerance} ${verdict}`
    );
    const o = v.owed;
    if (!o) continue;
    const month = o.last_closed_billing_month ? `${o.last_closed_billing_month}, close ${o.close_iso}` : "no close yet";
    lines.push(
      s.currency === "clp"
        ? `     app = facturado ${fmtAmount(o.clp.facturado, "clp")} (${month}) + cuotas por facturar ` +
            `${fmtAmount(o.clp.installment_remainder, "clp")} (${o.clp.remaining_cuotas}) + later lines ` +
            `${fmtAmount(o.clp.open_cycle_lines, "clp")}`
        : `     app = facturado ${fmtAmount(o.usd.facturado, "usd")} (${month}) + later lines ` +
            `${fmtAmount(o.usd.open_cycle_lines, "usd")}`
    );
  }
  return lines.join("\n");
}

/** The card page's view of the latest snapshot per currency and its verdict. */
export type CcBankCupoStatus = {
  observed_at: string;
  currencies: {
    currency: "clp" | "usd";
    cupo_total: number;
    cupo_utilizado: number;
    cupo_disponible: number;
    app_owed: number | null;
    diff: number | null;
    /** Null until the check has judged the snapshot. */
    status: BankCupoCheckStatus | null;
    reason: string | null;
  }[];
};

const selLatestAccountSnapshots = db.prepare(
  `SELECT s.id, s.currency, c.observed_at, s.cupo_total, s.cupo_utilizado, s.cupo_disponible,
          k.status, k.app_owed, k.diff, k.detail
   FROM cc_bank_cupo_snapshots s
   JOIN cc_bank_cupo_captures c ON c.id = s.capture_id
   LEFT JOIN cc_bank_cupo_checks k ON k.snapshot_id = s.id
   WHERE s.account_id = ?
     AND s.capture_id = (SELECT MAX(capture_id) FROM cc_bank_cupo_snapshots WHERE account_id = ?)
   ORDER BY s.currency`
);

export function latestBankCupoForAccount(accountId: number): CcBankCupoStatus | null {
  const rows = selLatestAccountSnapshots.all(accountId, accountId) as {
    id: number;
    currency: "clp" | "usd";
    observed_at: string;
    cupo_total: number;
    cupo_utilizado: number;
    cupo_disponible: number;
    status: BankCupoCheckStatus | null;
    app_owed: number | null;
    diff: number | null;
    detail: string | null;
  }[];
  if (rows.length === 0) return null;
  return {
    observed_at: rows[0]!.observed_at,
    currencies: rows.map((r) => ({
      currency: r.currency,
      cupo_total: r.cupo_total,
      cupo_utilizado: r.cupo_utilizado,
      cupo_disponible: r.cupo_disponible,
      app_owed: r.app_owed,
      diff: r.diff,
      status: r.status,
      reason: r.detail ? ((JSON.parse(r.detail) as CheckDetail).reason ?? null) : null,
    })),
  };
}
