import { useEffect, useRef, useState, type ReactNode } from "react";
import { invalidateResources, resources } from "../../queries/resources";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { cn } from "../../cn";
import { formatGroupedDecimalTrimmed, formatMoney } from "../../format";
import { formatCheckingPesos } from "../../formatNative";
import { useMovementMirrorCandidates } from "../../queries/hooks";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { loadableClass } from "../../components/ui/Loadable";
import { Pill } from "../../components/ui/Pill";
import { Button } from "@crfrsr/ui";
import type {
  CcPaymentMirrorCandidateDto,
  CcPaymentMirrorRefDto,
  MirrorLegDto,
  MirrorPairCandidate,
  MirrorPairRef,
  MirrorPairSection,
  MirrorRouteGroup,
} from "../../types";
import styles from "./MirrorPairsPanelPage.module.css";

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

type MirrorPairLegs = { out: MirrorLegDto; in: MirrorLegDto };

const EMPTY_SECTION = { count: 0, routes: [] };

function sectionPairs<P>(section: MirrorPairSection<P>): P[] {
  return section.routes.flatMap((r) => r.pairs);
}

function AccountLink({ id, name }: { id: number; name: string }) {
  return <Link to={`/account/${id}`}>{name}</Link>;
}

/** A pair's flags, worded. Month-precision and linked pairs convert on the real-day checking
 * leg's date, so the bank-window re-import caveat does not apply to them. */
function pairFlags(p: MirrorPairCandidate, t: (k: string, o?: Record<string, unknown>) => string): string[] {
  const flags: string[] = [];
  if (p.linked) flags.push(t("mirrorPairs.badgeLinked"));
  if (p.month_precision) flags.push(t("mirrorPairs.badgeMonthPrecision"));
  if (p.month_straddle) flags.push(t("mirrorPairs.badgeMonthStraddle"));
  if (!p.within_business_day_window && !p.month_precision && !p.linked) {
    flags.push(t("mirrorPairs.badgeWideGap"));
  }
  if (p.out_candidate_count > 1 || p.in_candidate_count > 1) {
    flags.push(
      t("mirrorPairs.badgeMultiCandidate", { n: Math.max(p.out_candidate_count, p.in_candidate_count) })
    );
  }
  return flags;
}

/** A leg's amount, unsigned, in the currency the pair moves. */
function legAmountText(leg: MirrorLegDto): string {
  return formatMoney({ value: Math.abs(leg.amount), currency: leg.currency });
}

/** The import note, one line cut with an ellipsis while the row is on one line; a click shows it whole. */
function NoteText({ text }: { text: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!text) return <span className={cn(styles.note, styles.noteNone)}>—</span>;
  return (
    <button
      type="button"
      className={cn(styles.note, open && styles.noteOpen)}
      aria-expanded={open}
      aria-label={open ? t("mirrorPairs.noteCollapse") : t("mirrorPairs.noteExpand")}
      title={open ? undefined : text}
      onClick={() => setOpen((o) => !o)}
    >
      {text}
    </button>
  );
}

function RouteCheckbox({ keys, unchecked, onSet }: { keys: string[]; unchecked: Set<string>; onSet: (keys: string[], on: boolean) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const selected = keys.filter((k) => !unchecked.has(k)).length;
  const all = selected === keys.length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selected > 0 && !all;
  }, [selected, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={() => onSet(keys, !all)}
      aria-label={t("mirrorPairs.selectRoute")}
    />
  );
}

/** One pair as the list draws it (every field already rendered). */
type PairRowItem = {
  key: string;
  check: ReactNode | null;
  from: string;
  to: string | null;
  amount: ReactNode;
  flags: string[];
  note: string | null;
  actions: ReactNode | null;
  alternatives: ReactNode | null;
};

function PairRow({ item }: { item: PairRowItem }) {
  return (
    <>
      <div role="listitem" className={styles.row}>
        {item.check != null ? <span className={styles.check}>{item.check}</span> : null}
        <span className={cn("mono", styles.dates)}>
          {item.from}
          {item.to != null ? <span className={styles.datesTo}> → {item.to}</span> : null}
        </span>
        <span className={cn("mono", styles.amount)}>{item.amount}</span>
        <span className={styles.info}>
          {item.flags.map((f) => (
            <Pill key={f} size="small" uppercase={false} label={f} />
          ))}
          <NoteText text={item.note} />
        </span>
        {item.actions != null ? <span className={styles.actions}>{item.actions}</span> : null}
      </div>
      {item.alternatives}
    </>
  );
}

function RouteBlock<P>({
  route,
  check,
  actions,
  rows,
}: {
  route: MirrorRouteGroup<P>;
  check: ReactNode | null;
  actions: boolean;
  rows: PairRowItem[];
}) {
  return (
    <div className={cn(styles.route, actions ? styles.routeActions : styles.routeChecks)}>
      <div className={styles.routeHead}>
        {check}
        <AccountLink id={route.from.account_id} name={route.from.account_name} />
        <span className={styles.arrow}>→</span>
        <AccountLink id={route.to.account_id} name={route.to.account_name} />
        <span className={styles.routeCount}>· {route.pairs.length}</span>
      </div>
      <div
        role="list"
        className={cn(styles.list, check != null && styles.listCheck, actions && styles.listActions)}
      >
        {rows.map((r) => (
          <PairRow key={r.key} item={r} />
        ))}
      </div>
    </div>
  );
}

export function MirrorPairsPanelPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, error, isPending } = useMovementMirrorCandidates();
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [ccUnchecked, setCcUnchecked] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [confirmCcBatch, setConfirmCcBatch] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState<MirrorPairLegs | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Conversion rewrites movements — balances, flows, reconciliation, and dashboards all shift.
  const invalidateAll = () => invalidateResources(queryClient, resources.everything());

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
      invalidateResources(queryClient, resources.movementMirrors());
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });
  const unreject = useMutation({
    mutationFn: (pairs: MirrorPairRef[]) => api.unrejectMovementMirrors(pairs),
    onSuccess: () => invalidateResources(queryClient, resources.movementMirrors()),
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

  if (error) {
    return <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>;
  }

  const high: MirrorPairSection<MirrorPairCandidate> = data?.high ?? EMPTY_SECTION;
  const ambiguous: MirrorPairSection<MirrorPairCandidate> = data?.ambiguous ?? EMPTY_SECTION;
  const cc: MirrorPairSection<CcPaymentMirrorCandidateDto> = data?.cc_payments ?? EMPTY_SECTION;
  const rejected = data?.rejected ?? [];

  const selectedHigh = sectionPairs(high).filter((p) => !unchecked.has(pairKey(p)));
  const selectedCc = sectionPairs(cc).filter((p) => !ccUnchecked.has(ccPairKey(p)));
  const busy = convert.isPending || reject.isPending || unreject.isPending || convertCc.isPending;

  const setKeys =
    (set: (f: (prev: Set<string>) => Set<string>) => void) => (keys: string[], on: boolean) =>
      set((prev) => {
        const next = new Set(prev);
        for (const k of keys) {
          if (on) next.delete(k);
          else next.add(k);
        }
        return next;
      });
  const setHigh = setKeys(setUnchecked);
  const setCc = setKeys(setCcUnchecked);

  const pairCheckbox = (key: string, set: Set<string>, onSet: (keys: string[], on: boolean) => void) => (
    <input
      type="checkbox"
      checked={!set.has(key)}
      onChange={() => onSet([key], set.has(key))}
      aria-label={t("mirrorPairs.selectPair")}
    />
  );

  const legAmount = (p: MirrorPairCandidate) => {
    const units = p.out.units_delta;
    return (
      <>
        {legAmountText(p.out)}
        {units != null && units !== 0 ? (
          <span className={styles.units}> {t("mirrorPairs.units", { n: formatGroupedDecimalTrimmed(units) })}</span>
        ) : null}
      </>
    );
  };

  const legNote = (p: MirrorPairLegs) => {
    const parts = [p.out.note, p.in.note].filter(Boolean) as string[];
    return parts.length === 0 ? null : parts.join(" · ");
  };

  const legRow = (p: MirrorPairCandidate, mode: "high" | "ambiguous"): PairRowItem => {
    const alts = [
      ...p.out_alternatives.map((a) => ({ alt: a, side: "out" as const })),
      ...p.in_alternatives.map((a) => ({ alt: a, side: "in" as const })),
    ];
    return {
      key: pairKey(p),
      check: mode === "high" ? pairCheckbox(pairKey(p), unchecked, setHigh) : null,
      from: p.out.occurred_on,
      to: p.gap_days > 0 ? p.in.occurred_on : null,
      amount: legAmount(p),
      flags: pairFlags(p, t),
      note: legNote(p),
      actions:
        mode === "ambiguous" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => setConfirmSingle(p)}>
              {t("mirrorPairs.approve")}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => reject.mutate([pairRef(p)])}>
              {t("mirrorPairs.reject")}
            </Button>
          </>
        ) : null,
      alternatives:
        alts.length === 0
          ? null
          : alts.map(({ alt, side }) => (
              <div key={`${side}|${alt.leg.movement_id}`} className={styles.alt}>
                <span className={styles.altLabel}>
                  {t(side === "out" ? "mirrorPairs.altOut" : "mirrorPairs.altIn")}
                </span>
                <span className="mono">{alt.leg.occurred_on}</span>
                <AccountLink id={alt.leg.account_id} name={alt.leg.account_name} />
                <NoteText text={alt.leg.note} />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    setConfirmSingle(side === "out" ? { out: alt.leg, in: p.in } : { out: p.out, in: alt.leg })
                  }
                >
                  {t("mirrorPairs.useAlternative")}
                </Button>
              </div>
            )),
    };
  };

  const ccRow = (p: CcPaymentMirrorCandidateDto): PairRowItem => ({
    key: ccPairKey(p),
    check: pairCheckbox(ccPairKey(p), ccUnchecked, setCc),
    from: p.out.occurred_on,
    to: p.skew_days !== 0 ? p.evidence.pago_iso : null,
    amount: formatCheckingPesos(p.evidence.amount_clp),
    flags: p.skew_days !== 0 ? [t("mirrorPairs.badgeSkew", { n: Math.abs(p.skew_days) })] : [],
    note: p.out.note ? `${p.out.note} · ${p.evidence.label}` : p.evidence.label,
    actions: null,
    alternatives: null,
  });

  return (
    <PageGridTile id="mirror-pairs" className={loadableClass(isPending)}>
      <h2>{t("mirrorPairs.title")}</h2>
      {actionError ? <p className="error">{actionError}</p> : null}

      <h3>{t("mirrorPairs.highTitle", { n: high.count })}</h3>
      {high.count === 0 && !isPending ? (
        <p className="muted">{t("mirrorPairs.emptyHigh")}</p>
      ) : (
        <>
          {high.routes.map((route) => (
            <RouteBlock
              key={`${route.from.account_id}|${route.to.account_id}`}
              route={route}
              check={<RouteCheckbox keys={route.pairs.map(pairKey)} unchecked={unchecked} onSet={setHigh} />}
              actions={false}
              rows={route.pairs.map((p) => legRow(p, "high"))}
            />
          ))}
          <p>
            <Button disabled={busy || selectedHigh.length === 0} onClick={() => setConfirmBatch(true)}>
              {t("mirrorPairs.convertSelected", { n: selectedHigh.length })}
            </Button>
          </p>
        </>
      )}

      <h3>{t("mirrorPairs.ambiguousTitle", { n: ambiguous.count })}</h3>
      {ambiguous.count === 0 && !isPending ? (
        <p className="muted">{t("mirrorPairs.emptyAmbiguous")}</p>
      ) : (
        ambiguous.routes.map((route) => (
          <RouteBlock
            key={`${route.from.account_id}|${route.to.account_id}`}
            route={route}
            check={null}
            actions
            rows={route.pairs.map((p) => legRow(p, "ambiguous"))}
          />
        ))
      )}

      <h3>{t("mirrorPairs.ccTitle", { n: cc.count })}</h3>
      {cc.count === 0 && !isPending ? (
        <p className="muted">{t("mirrorPairs.emptyCc")}</p>
      ) : (
        <>
          {cc.routes.map((route) => (
            <RouteBlock
              key={`${route.from.account_id}|${route.to.account_id}`}
              route={route}
              check={<RouteCheckbox keys={route.pairs.map(ccPairKey)} unchecked={ccUnchecked} onSet={setCc} />}
              actions={false}
              rows={route.pairs.map(ccRow)}
            />
          ))}
          <p>
            <Button disabled={busy || selectedCc.length === 0} onClick={() => setConfirmCcBatch(true)}>
              {t("mirrorPairs.convertSelected", { n: selectedCc.length })}
            </Button>
          </p>
        </>
      )}

      {rejected.length > 0 ? (
        <>
          <h3>{t("mirrorPairs.rejectedTitle", { n: rejected.length })}</h3>
          <ul className={styles.rejected}>
            {rejected.map((p) => (
              <li key={pairKey(p)}>
                <span className="mono">{p.out.occurred_on}</span>
                <span>
                  {p.out.account_name} → {p.in.account_name}
                </span>
                <span className="mono">{legAmountText(p.out)}</span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => unreject.mutate([pairRef(p)])}>
                  {t("mirrorPairs.restore")}
                </Button>
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
                amount: legAmountText(confirmSingle.out),
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
    </PageGridTile>
  );
}
