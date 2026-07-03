import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreditCardConfig, usePatchCreditCardConfigMutation } from "../../queries/hooks";
import type { CcCupoEntry, CreditCardConfigPatchBody } from "../../types";
import {
  brokerageMovementFieldLabelStyle,
  brokerageMovementFieldRowStyle,
} from "../panel/BrokerageMovementsSection";

type Props = {
  accountId: number;
};

/** "1.234.567" / "1234,5" style input → number (dot thousands, comma decimal). */
function parseAmountInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function parseCycleDayInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 31) return undefined;
  return n;
}

/** Edit form for `credit_card_account_config` (cupo + billing cycle). */
export function CreditCardConfigSection({ accountId }: Props) {
  const { t } = useTranslation();
  const { data, error } = useCreditCardConfig(String(accountId));
  const patchMutation = usePatchCreditCardConfigMutation(String(accountId));

  const [cupoClp, setCupoClp] = useState("");
  const [cupoUsd, setCupoUsd] = useState("");
  const [cycleStart, setCycleStart] = useState("");
  const [cycleEnd, setCycleEnd] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const config = data?.config;

  useEffect(() => {
    if (!config) return;
    const clp = config.cupo.find((c) => c.currency === "clp")?.value;
    const usd = config.cupo.find((c) => c.currency === "usd")?.value;
    setCupoClp(clp != null ? String(clp) : "");
    setCupoUsd(usd != null ? String(usd) : "");
    setCycleStart(String(config.billing_cycle_start_day));
    setCycleEnd(config.billing_cycle_end_day != null ? String(config.billing_cycle_end_day) : "");
  }, [config]);

  if (error instanceof Error) {
    return (
      <section style={{ margin: "1.5rem 0" }}>
        <h2 className="flow-section-title">{t("accountDetail.creditCard.configTitle")}</h2>
        <p className="error">{error.message}</p>
      </section>
    );
  }
  if (!config) return null;

  const onSave = () => {
    setSaved(false);
    const clp = parseAmountInput(cupoClp);
    const usd = parseAmountInput(cupoUsd);
    if (clp === undefined || usd === undefined || (clp != null && (clp < 0 || !Number.isInteger(clp))) || (usd != null && usd < 0)) {
      setFormError(t("accountDetail.creditCard.configInvalidCupo"));
      return;
    }
    const start = parseCycleDayInput(cycleStart);
    const end = parseCycleDayInput(cycleEnd);
    if (start === undefined || start === null || end === undefined) {
      setFormError(t("accountDetail.creditCard.configInvalidCycleDay"));
      return;
    }
    setFormError(null);
    const cupo: CcCupoEntry[] = [
      { currency: "clp", value: clp },
      { currency: "usd", value: usd },
    ];
    const body: CreditCardConfigPatchBody = {
      billing_cycle_start_day: start,
      billing_cycle_end_day: end,
      cupo,
    };
    patchMutation.mutate(body, {
      onSuccess: () => setSaved(true),
      onError: (err: Error) => setFormError(err.message),
    });
  };

  const onFieldChange = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setSaved(false);
    setFormError(null);
  };

  return (
    <section style={{ margin: "1.5rem 0" }}>
      <h2 className="flow-section-title">{t("accountDetail.creditCard.configTitle")}</h2>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        {t("accountDetail.creditCard.configHint")}
        {config.card_last4 ? (
          <>
            {" "}
            · {t("accountDetail.creditCard.configCardLabel")}{" "}
            <span className="mono">·{config.card_last4}</span>
          </>
        ) : null}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
          gap: "0.5rem 0.75rem",
          alignItems: "end",
          maxWidth: "40rem",
        }}
      >
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("accountDetail.creditCard.configCupoClpLabel")}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={cupoClp}
            placeholder="5000000"
            onChange={(e) => onFieldChange(setCupoClp)(e.target.value)}
          />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("accountDetail.creditCard.configCupoUsdLabel")}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={cupoUsd}
            placeholder="3000"
            onChange={(e) => onFieldChange(setCupoUsd)(e.target.value)}
          />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("accountDetail.creditCard.configCycleStartLabel")}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={cycleStart}
            placeholder="21"
            onChange={(e) => onFieldChange(setCycleStart)(e.target.value)}
          />
        </label>
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("accountDetail.creditCard.configCycleEndLabel")}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={cycleEnd}
            placeholder="20"
            onChange={(e) => onFieldChange(setCycleEnd)(e.target.value)}
          />
        </label>
        <div style={{ ...brokerageMovementFieldRowStyle(), display: "flex", alignItems: "flex-end" }}>
          <button type="button" disabled={patchMutation.isPending} onClick={onSave}>
            {patchMutation.isPending
              ? t("common.loading")
              : t("accountDetail.creditCard.configSaveBtn")}
          </button>
        </div>
      </div>

      {formError ? (
        <p className="error" style={{ marginTop: "0.75rem" }}>
          {formError}
        </p>
      ) : null}
      {saved ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("accountDetail.creditCard.configSaved")}
        </p>
      ) : null}
    </section>
  );
}
