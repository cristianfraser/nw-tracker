import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { formatClp, formatClpUfDay, formatUfUnits, formatUfUnitsFine } from "../../format";
import { queryKeys, type DisplayUnit } from "../../queries/keys";
import type {
  AccountSummaryResponse,
  MortgagePaymentPreviewResponse,
} from "../../types";
import {
  brokerageMovementFieldLabelStyle,
  brokerageMovementFieldRowStyle,
} from "../panel/BrokerageMovementsSection";
import styles from "../../pages/AccountDetailPage.module.css";
import { cn } from "../../cn";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
  schema: NonNullable<AccountSummaryResponse["mortgage_payment_create"]>;
};

function parseClpInput(raw: string): number | null {
  const normalized = raw.trim().replace(/\./g, "").replace(",", ".");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function buildBody(
  occurredOn: string,
  pagoClp: string,
  interesClp: string,
  incendioClp: string,
  desgravamenClp: string,
  cuota: string,
  useDesgravamenOverride: boolean
): Record<string, unknown> | null {
  const pago_clp = parseClpInput(pagoClp);
  const interes_clp = parseClpInput(interesClp);
  const incendio_clp = parseClpInput(incendioClp);
  if (pago_clp == null || interes_clp == null || incendio_clp == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn.trim())) return null;
  const body: Record<string, unknown> = {
    occurred_on: occurredOn.trim(),
    pago_clp,
    interes_clp,
    incendio_clp,
  };
  if (cuota.trim()) body.cuota = cuota.trim();
  if (useDesgravamenOverride) {
    const des = parseClpInput(desgravamenClp);
    if (des == null) return null;
    body.desgravamen_clp = des;
  }
  return body;
}

export function MortgagePaymentForm({
  accountId,
  displayUnit,
  extraCcOffsetsKey,
  schema,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [occurredOn, setOccurredOn] = useState("");
  const [pagoClp, setPagoClp] = useState("");
  const [interesClp, setInteresClp] = useState("");
  const [incendioClp, setIncendioClp] = useState(
    schema.default_incendio_clp != null ? String(schema.default_incendio_clp) : ""
  );
  const [desgravamenClp, setDesgravamenClp] = useState("");
  const [useDesgravamenOverride, setUseDesgravamenOverride] = useState(false);
  const [cuota, setCuota] = useState(schema.next_cuota);
  const [preview, setPreview] = useState<MortgagePaymentPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const previewBody = useMemo(
    () =>
      buildBody(
        occurredOn,
        pagoClp,
        interesClp,
        incendioClp,
        desgravamenClp,
        cuota,
        useDesgravamenOverride
      ),
    [
      occurredOn,
      pagoClp,
      interesClp,
      incendioClp,
      desgravamenClp,
      cuota,
      useDesgravamenOverride,
    ]
  );

  useEffect(() => {
    if (!previewBody) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .previewMortgagePayment(accountId, previewBody)
        .then((res) => {
          if (!cancelled) {
            setPreview(res);
            setPreviewError(null);
            if (!useDesgravamenOverride) {
              setDesgravamenClp(String(res.desgravamen_default_clp));
            }
          }
        })
        .catch((err: Error) => {
          if (!cancelled) {
            setPreview(null);
            setPreviewError(err.message);
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountId, previewBody, useDesgravamenOverride]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!previewBody) throw new Error(t("accountDetail.mortgagePayment.invalid"));
      return api.commitMortgagePayment(accountId, previewBody);
    },
    onSuccess: async () => {
      setFormError(null);
      setSaved(true);
      setOccurredOn("");
      setPagoClp("");
      setInteresClp("");
      setPreview(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly", extraCcOffsetsKey),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(displayUnit) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboardNav(displayUnit) }),
      ]);
    },
    onError: (err: Error) => {
      setFormError(err.message);
      setSaved(false);
    },
  });

  return (
    <section className={styles.marginTopBase} style={{ marginBottom: "1.5rem" }}>
      <h2 className={styles.sectionTitle}>{t("accountDetail.mortgagePayment.sectionTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>
        {t("accountDetail.mortgagePayment.sectionHint")}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem", maxWidth: "28rem" }}>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.mortgagePayment.cuotaLabel")}</span>
          <input className="mono" value={cuota} onChange={(e) => setCuota(e.target.value)} />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.dateLabel")}</span>
          <input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.mortgagePayment.pagoClpLabel")}</span>
          <input className="mono" value={pagoClp} onChange={(e) => setPagoClp(e.target.value)} inputMode="numeric" />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.mortgagePayment.interesClpLabel")}</span>
          <input className="mono" value={interesClp} onChange={(e) => setInteresClp(e.target.value)} inputMode="numeric" />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.mortgagePayment.incendioClpLabel")}</span>
          <input className="mono" value={incendioClp} onChange={(e) => setIncendioClp(e.target.value)} inputMode="numeric" />
        </label>
        <label style={{ ...brokerageMovementFieldRowStyle(), alignItems: "flex-start" }}>
          <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.mortgagePayment.desgravamenClpLabel")}</span>
          <span style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: 1 }}>
            <input
              className="mono"
              value={desgravamenClp}
              onChange={(e) => setDesgravamenClp(e.target.value)}
              inputMode="numeric"
              disabled={!useDesgravamenOverride}
            />
            <label style={{ fontSize: "0.85rem" }}>
              <input
                type="checkbox"
                checked={useDesgravamenOverride}
                onChange={(e) => setUseDesgravamenOverride(e.target.checked)}
              />{" "}
              {t("accountDetail.mortgagePayment.desgravamenOverride")}
            </label>
          </span>
        </label>
      </div>

      {previewError ? (
        <p className={cn("error", styles.errorText)} style={{ marginTop: "0.75rem" }}>
          {previewError}
        </p>
      ) : null}

      {preview ? (
        <div className={cn("cards", styles.cardsBelow)}>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewAmort")}</div>
            <div className="value mono">{formatClp(preview.sheet.amortizacion_clp ?? 0)}</div>
          </div>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewAmortExt")}</div>
            <div className="value mono">
              {preview.sheet.amortizacion_ext_clp != null
                ? formatClp(preview.sheet.amortizacion_ext_clp)
                : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewUfDay")}</div>
            <div className="value mono">
              {preview.sheet.uf_clp_day != null ? formatClpUfDay(preview.sheet.uf_clp_day) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewCreditoUf")}</div>
            <div className="value mono">
              {preview.sheet.credito_restante_uf != null
                ? formatUfUnits(preview.sheet.credito_restante_uf)
                : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewMortgageClp")}</div>
            <div className="value mono">{formatClp(preview.mortgage_balance_clp)}</div>
          </div>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewNetClp")}</div>
            <div className="value mono">{formatClp(preview.property_net_clp)}</div>
          </div>
          <div className="card">
            <div className="label">{t("accountDetail.mortgagePayment.previewPagoUf")}</div>
            <div className="value mono">
              {preview.sheet.pago_uf != null ? formatUfUnitsFine(preview.sheet.pago_uf) : "—"}
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: "0.75rem" }}>
        <button
          type="button"
          disabled={saveMutation.isPending || !previewBody || preview == null}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? t("common.loading") : t("accountDetail.mortgagePayment.saveBtn")}
        </button>
      </div>

      {formError ? (
        <p className="error" style={{ marginTop: "0.75rem" }}>
          {formError}
        </p>
      ) : null}
      {saved ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("accountDetail.mortgagePayment.saveSuccess")}
        </p>
      ) : null}
    </section>
  );
}
