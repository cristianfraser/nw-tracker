import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { formatClp, formatGroupedDecimalTrimmed } from "../../format";
import { useMovementMirrorCandidates } from "../../queries/hooks";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Table } from "../../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../../components/ui/TableMobileCard";
import type {
  CcPaymentMirrorCandidateDto,
  CcPaymentMirrorRefDto,
  MirrorLegDto,
  MirrorPairCandidate,
  MirrorPairRef,
} from "../../types";

function ccPairKey(p: CcPaymentMirrorCandidateDto): string {
  return `cc|${p.out.movement_id}|${p.evidence.statement_line_id ?? ""}|${p.evidence.statement_id ?? ""}`;
}

function ccPairRef(p: CcPaymentMirrorCandidateDto): CcPaymentMirrorRefDto {
  return {
    out_movement_id: p.out.movement_id,
    statement_line_id: p.evidence.statement_line_id,
    statement_id: p.evidence.statement_id,
  };
}

function pairKey(p: { out: MirrorLegDto; in: MirrorLegDto }): string {
  return `${p.out.movement_id}|${p.in.movement_id}`;
}

function pairRef(p: { out: MirrorLegDto; in: MirrorLegDto }): MirrorPairRef {
  return { out_movement_id: p.out.movement_id, in_movement_id: p.in.movement_id };
}

function AccountCell({ leg }: { leg: MirrorLegDto }) {
  return <Link to={`/account/${leg.account_id}`}>{leg.account_name}</Link>;
}

function LegDates({ p }: { p: MirrorPairCandidate }) {
  return (
    <>
      {p.out.occurred_on}
      {p.gap_days > 0 ? <span className="muted"> → {p.in.occurred_on}</span> : null}
    </>
  );
}

function PairBadges({ p }: { p: MirrorPairCandidate }) {
  const { t } = useTranslation();
  const badges: string[] = [];
  if (p.linked) badges.push(t("mirrorPairs.badgeLinked"));
  if (p.month_precision) badges.push(t("mirrorPairs.badgeMonthPrecision"));
  if (p.month_straddle) badges.push(t("mirrorPairs.badgeMonthStraddle"));
  // Month-precision and linked pairs convert on the real-day checking leg's date, so the
  // bank-window re-import caveat does not apply to them.
  if (!p.within_business_day_window && !p.month_precision && !p.linked) {
    badges.push(t("mirrorPairs.badgeWideGap"));
  }
  if (p.out_candidate_count > 1 || p.in_candidate_count > 1) {
    badges.push(
      t("mirrorPairs.badgeMultiCandidate", {
        n: Math.max(p.out_candidate_count, p.in_candidate_count),
      })
    );
  }
  if (badges.length === 0) return null;
  return <span className="muted"> {badges.join(" · ")}</span>;
}

function NotesCell({ p }: { p: { out: MirrorLegDto; in: MirrorLegDto } }) {
  const parts = [p.out.note, p.in.note].filter(Boolean) as string[];
  if (parts.length === 0) return <span className="muted">—</span>;
  return (
    <span className="muted" style={{ fontSize: "0.85em", overflowWrap: "anywhere" }}>
      {parts.join(" · ")}
    </span>
  );
}

function AmountCell({ p }: { p: { out: MirrorLegDto } }) {
  const units = p.out.units_delta;
  return (
    <>
      {formatClp(Math.round(Math.abs(p.out.amount_clp)))}
      {units != null && units !== 0 ? (
        <span className="muted"> ({formatGroupedDecimalTrimmed(units)} cuotas)</span>
      ) : null}
    </>
  );
}

export function MirrorPairsPanelPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, error, isPending } = useMovementMirrorCandidates();
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState<MirrorPairCandidate | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Conversion rewrites movements — balances, flows, reconciliation, and dashboards all shift.
  const invalidateAll = () => queryClient.invalidateQueries();

  const convert = useMutation({
    mutationFn: (pairs: MirrorPairRef[]) => api.convertMovementMirrors(pairs),
    onSuccess: () => {
      setActionError(null);
      invalidateAll();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });
  const reject = useMutation({
    mutationFn: (pairs: MirrorPairRef[]) => api.rejectMovementMirrors(pairs),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["movementMirrorCandidates"] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });
  const unreject = useMutation({
    mutationFn: (pairs: MirrorPairRef[]) => api.unrejectMovementMirrors(pairs),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["movementMirrorCandidates"] }),
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });
  const convertCc = useMutation({
    mutationFn: (pairs: CcPaymentMirrorRefDto[]) => api.convertCcPaymentMirrors(pairs),
    onSuccess: () => {
      setActionError(null);
      invalidateAll();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });

  const high = useMemo(() => (data?.pairs ?? []).filter((p) => p.confidence === "high"), [data]);
  const ambiguous = useMemo(
    () => (data?.pairs ?? []).filter((p) => p.confidence === "ambiguous" && !p.blocked),
    [data]
  );
  const blocked = useMemo(() => (data?.pairs ?? []).filter((p) => p.blocked), [data]);
  const rejected = data?.rejected ?? [];

  const ccPairs = useMemo(() => (data?.cc_payment_pairs ?? []).filter((p) => !p.blocked), [data]);
  const [ccUnchecked, setCcUnchecked] = useState<Set<string>>(new Set());
  const [confirmCcBatch, setConfirmCcBatch] = useState(false);
  const selectedCc = ccPairs.filter((p) => !ccUnchecked.has(ccPairKey(p)));

  const selectedHigh = high.filter((p) => !unchecked.has(pairKey(p)));
  const busy = convert.isPending || reject.isPending || unreject.isPending || convertCc.isPending;

  if (isPending) return <p className="muted">{t("common.loading")}</p>;
  if (error) {
    return <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>;
  }

  const toggle = (key: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const allChecked = high.length > 0 && selectedHigh.length === high.length;
  const toggleAll = () => {
    setUnchecked(allChecked ? new Set(high.map(pairKey)) : new Set());
  };

  const rowActions = (p: MirrorPairCandidate) => (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => setConfirmSingle(p)}
      >
        {t("mirrorPairs.approve")}
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => reject.mutate([pairRef(p)])}>
        {t("mirrorPairs.reject")}
      </button>
    </>
  );

  return (
    <section>
      <h2>{t("mirrorPairs.title")}</h2>
      <p className="muted">{t("mirrorPairs.intro")}</p>
      {actionError ? <p className="error">{actionError}</p> : null}

      <h3>{t("mirrorPairs.highTitle", { n: high.length })}</h3>
      {high.length === 0 ? (
        <p className="muted">{t("mirrorPairs.emptyHigh")}</p>
      ) : (
        <>
          <Table
            header={
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    aria-label={t("mirrorPairs.selectAll")}
                  />
                </th>
                <th className="desktop-only">{t("mirrorPairs.colDates")}</th>
                <th className="desktop-only">{t("mirrorPairs.colFrom")}</th>
                <th className="desktop-only">{t("mirrorPairs.colTo")}</th>
                <th className="desktop-only">{t("mirrorPairs.colAmount")}</th>
                <th className="desktop-only">{t("mirrorPairs.colFlags")}</th>
                <th className="desktop-only">{t("mirrorPairs.colNotes")}</th>
              </tr>
            }
          >
            {high.map((p) => {
              const key = pairKey(p);
              const checkbox = (
                <input
                  type="checkbox"
                  checked={!unchecked.has(key)}
                  onChange={() => toggle(key)}
                  aria-label={t("mirrorPairs.selectPair")}
                />
              );
              return (
                <tr key={key}>
                  <td>{checkbox}</td>
                  <td className="desktop-only">
                    <LegDates p={p} />
                  </td>
                  <td className="desktop-only">
                    <AccountCell leg={p.out} />
                  </td>
                  <td className="desktop-only">
                    <AccountCell leg={p.in} />
                  </td>
                  <td className="desktop-only">
                    <AmountCell p={p} />
                  </td>
                  <td className="desktop-only">
                    <PairBadges p={p} />
                  </td>
                  <td className="desktop-only">
                    <NotesCell p={p} />
                  </td>
                  <td className="mobile-only">
                    <TableMobileCard
                      title={
                        <>
                          <AccountCell leg={p.out} /> → <AccountCell leg={p.in} />
                        </>
                      }
                    >
                      <TableMobileCardRow label={t("mirrorPairs.colDates")} value={<LegDates p={p} />} />
                      <TableMobileCardRow label={t("mirrorPairs.colAmount")} value={<AmountCell p={p} />} />
                      <TableMobileCardRow label={t("mirrorPairs.colFlags")} value={<PairBadges p={p} />} />
                      <TableMobileCardRow label={t("mirrorPairs.colNotes")} value={<NotesCell p={p} />} />
                    </TableMobileCard>
                  </td>
                </tr>
              );
            })}
          </Table>
          <p>
            <button
              type="button"
              disabled={busy || selectedHigh.length === 0}
              onClick={() => setConfirmBatch(true)}
            >
              {t("mirrorPairs.convertSelected", { n: selectedHigh.length })}
            </button>
          </p>
        </>
      )}

      <h3>{t("mirrorPairs.ambiguousTitle", { n: ambiguous.length })}</h3>
      {ambiguous.length === 0 ? (
        <p className="muted">{t("mirrorPairs.emptyAmbiguous")}</p>
      ) : (
        <Table
          header={
            <tr>
              <th className="desktop-only">{t("mirrorPairs.colDates")}</th>
              <th className="desktop-only">{t("mirrorPairs.colFrom")}</th>
              <th className="desktop-only">{t("mirrorPairs.colTo")}</th>
              <th className="desktop-only">{t("mirrorPairs.colAmount")}</th>
              <th className="desktop-only">{t("mirrorPairs.colFlags")}</th>
              <th className="desktop-only">{t("mirrorPairs.colNotes")}</th>
              <th className="desktop-only">{t("mirrorPairs.colActions")}</th>
            </tr>
          }
        >
          {ambiguous.map((p) => (
            <tr key={pairKey(p)}>
              <td className="desktop-only">
                <LegDates p={p} />
              </td>
              <td className="desktop-only">
                <AccountCell leg={p.out} />
              </td>
              <td className="desktop-only">
                <AccountCell leg={p.in} />
              </td>
              <td className="desktop-only">
                <AmountCell p={p} />
              </td>
              <td className="desktop-only">
                <PairBadges p={p} />
              </td>
              <td className="desktop-only">
                <NotesCell p={p} />
              </td>
              <td className="desktop-only">{rowActions(p)}</td>
              <td className="mobile-only">
                <TableMobileCard
                  title={
                    <>
                      <AccountCell leg={p.out} /> → <AccountCell leg={p.in} />
                    </>
                  }
                >
                  <TableMobileCardRow label={t("mirrorPairs.colDates")} value={<LegDates p={p} />} />
                  <TableMobileCardRow label={t("mirrorPairs.colAmount")} value={<AmountCell p={p} />} />
                  <TableMobileCardRow label={t("mirrorPairs.colFlags")} value={<PairBadges p={p} />} />
                  <TableMobileCardRow label={t("mirrorPairs.colNotes")} value={<NotesCell p={p} />} />
                  <TableMobileCardRow label={t("mirrorPairs.colActions")} value={rowActions(p)} />
                </TableMobileCard>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <h3>{t("mirrorPairs.ccTitle", { n: ccPairs.length })}</h3>
      <p className="muted">{t("mirrorPairs.ccIntro")}</p>
      {ccPairs.length === 0 ? (
        <p className="muted">{t("mirrorPairs.emptyCc")}</p>
      ) : (
        <>
          <Table
            header={
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={ccPairs.length > 0 && selectedCc.length === ccPairs.length}
                    onChange={() =>
                      setCcUnchecked(
                        selectedCc.length === ccPairs.length
                          ? new Set(ccPairs.map(ccPairKey))
                          : new Set()
                      )
                    }
                    aria-label={t("mirrorPairs.selectAll")}
                  />
                </th>
                <th className="desktop-only">{t("mirrorPairs.colDates")}</th>
                <th className="desktop-only">{t("mirrorPairs.colFrom")}</th>
                <th className="desktop-only">{t("mirrorPairs.colTo")}</th>
                <th className="desktop-only">{t("mirrorPairs.colAmount")}</th>
                <th className="desktop-only">{t("mirrorPairs.colFlags")}</th>
                <th className="desktop-only">{t("mirrorPairs.colNotes")}</th>
              </tr>
            }
          >
            {ccPairs.map((p) => {
              const key = ccPairKey(p);
              const dates = (
                <>
                  {p.out.occurred_on}
                  {p.skew_days !== 0 ? (
                    <span className="muted"> → {p.evidence.pago_iso}</span>
                  ) : null}
                </>
              );
              const flags =
                p.skew_days !== 0 ? (
                  <span className="muted">
                    {t("mirrorPairs.badgeSkew", { n: Math.abs(p.skew_days) })}
                  </span>
                ) : null;
              const note = p.out.note ? (
                <span className="muted" style={{ fontSize: "0.85em", overflowWrap: "anywhere" }}>
                  {p.out.note} · {p.evidence.label}
                </span>
              ) : (
                <span className="muted">{p.evidence.label}</span>
              );
              const checkbox = (
                <input
                  type="checkbox"
                  checked={!ccUnchecked.has(key)}
                  onChange={() =>
                    setCcUnchecked((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  aria-label={t("mirrorPairs.selectPair")}
                />
              );
              return (
                <tr key={key}>
                  <td>{checkbox}</td>
                  <td className="desktop-only">{dates}</td>
                  <td className="desktop-only">
                    <Link to={`/account/${p.out.account_id}`}>{p.out.account_name}</Link>
                  </td>
                  <td className="desktop-only">
                    <Link to={`/account/${p.evidence.cc_account_id}`}>
                      {p.evidence.cc_account_name}
                    </Link>
                  </td>
                  <td className="desktop-only">{formatClp(p.evidence.amount_clp)}</td>
                  <td className="desktop-only">{flags}</td>
                  <td className="desktop-only">{note}</td>
                  <td className="mobile-only">
                    <TableMobileCard
                      title={
                        <>
                          <Link to={`/account/${p.out.account_id}`}>{p.out.account_name}</Link> →{" "}
                          <Link to={`/account/${p.evidence.cc_account_id}`}>
                            {p.evidence.cc_account_name}
                          </Link>
                        </>
                      }
                    >
                      <TableMobileCardRow label={t("mirrorPairs.colDates")} value={dates} />
                      <TableMobileCardRow
                        label={t("mirrorPairs.colAmount")}
                        value={formatClp(p.evidence.amount_clp)}
                      />
                      <TableMobileCardRow label={t("mirrorPairs.colFlags")} value={flags} />
                      <TableMobileCardRow label={t("mirrorPairs.colNotes")} value={note} />
                    </TableMobileCard>
                  </td>
                </tr>
              );
            })}
          </Table>
          <p>
            <button
              type="button"
              disabled={busy || selectedCc.length === 0}
              onClick={() => setConfirmCcBatch(true)}
            >
              {t("mirrorPairs.convertSelected", { n: selectedCc.length })}
            </button>
          </p>
        </>
      )}

      {blocked.length > 0 ? (
        <>
          <h3>{t("mirrorPairs.blockedTitle", { n: blocked.length })}</h3>
          <p className="muted">{t("mirrorPairs.blockedIntro")}</p>
          <ul>
            {blocked.map((p) => (
              <li key={pairKey(p)} className="muted">
                <LegDates p={p} /> — {p.out.account_name} → {p.in.account_name},{" "}
                {formatClp(Math.round(Math.abs(p.out.amount_clp)))} (
                {t("mirrorPairs.blockedReasonCheckingStraddle")})
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {rejected.length > 0 ? (
        <>
          <h3>{t("mirrorPairs.rejectedTitle", { n: rejected.length })}</h3>
          <ul>
            {rejected.map((p) => (
              <li key={pairKey(p)} className="muted">
                {p.out.occurred_on} — {p.out.account_name} → {p.in.account_name},{" "}
                {formatClp(Math.round(Math.abs(p.out.amount_clp)))}{" "}
                <button type="button" disabled={busy} onClick={() => unreject.mutate([pairRef(p)])}>
                  {t("mirrorPairs.restore")}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmCcBatch}
        title={t("mirrorPairs.confirmCcBatchTitle")}
        message={t("mirrorPairs.confirmCcBatchMessage", { n: selectedCc.length })}
        confirmLabel={t("mirrorPairs.confirmConvert")}
        cancelLabel={t("mirrorPairs.confirmCancel")}
        confirmDisabled={busy}
        onConfirm={() => {
          setConfirmCcBatch(false);
          convertCc.mutate(selectedCc.map(ccPairRef));
        }}
        onCancel={() => setConfirmCcBatch(false)}
      />
      <ConfirmDialog
        open={confirmBatch}
        title={t("mirrorPairs.confirmBatchTitle")}
        message={t("mirrorPairs.confirmBatchMessage", { n: selectedHigh.length })}
        confirmLabel={t("mirrorPairs.confirmConvert")}
        cancelLabel={t("mirrorPairs.confirmCancel")}
        confirmDisabled={busy}
        onConfirm={() => {
          setConfirmBatch(false);
          convert.mutate(selectedHigh.map(pairRef));
        }}
        onCancel={() => setConfirmBatch(false)}
      />
      <ConfirmDialog
        open={confirmSingle != null}
        title={t("mirrorPairs.confirmSingleTitle")}
        message={
          confirmSingle
            ? t("mirrorPairs.confirmSingleMessage", {
                from: confirmSingle.out.account_name,
                to: confirmSingle.in.account_name,
                amount: formatClp(Math.round(Math.abs(confirmSingle.out.amount_clp))),
              })
            : ""
        }
        confirmLabel={t("mirrorPairs.confirmConvert")}
        cancelLabel={t("mirrorPairs.confirmCancel")}
        confirmDisabled={busy}
        onConfirm={() => {
          if (confirmSingle) convert.mutate([pairRef(confirmSingle)]);
          setConfirmSingle(null);
        }}
        onCancel={() => setConfirmSingle(null)}
      />
    </section>
  );
}
