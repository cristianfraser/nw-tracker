import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadableClass } from "../ui/Loadable";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { formatNumberInput, parseNumberInput } from "../../format";
import { useCreditCardConfig, usePatchCreditCardConfigMutation } from "../../queries/hooks";
import type { CcCupoEntry, CreditCardConfigPatchBody } from "../../types";
import { Button, Field, Input } from "@crfrsr/ui";
import {
  brokerageMovementFieldRowStyle,
} from "../panel/BrokerageMovementsSection";

type Props = {
  accountId: number;
};

/** Whole day of month 1–31; null when empty, undefined when out of range. */
function cycleDayFromInput(parsed: number | null): number | null | undefined {
  if (parsed == null) return null;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) return undefined;
  return parsed;
}

/** Edit form for `credit_card_account_config` (cupo + billing cycle). */
export function CreditCardConfigSection({ accountId }: Props) {
  const { t } = useTranslation();
  const { decimalSeparator } = useDisplayPreferences();
  const { data, error } = useCreditCardConfig(String(accountId));
  const patchMutation = usePatchCreditCardConfigMutation(String(accountId));

  const [cupoClp, setCupoClp] = useState("");
  const [cupoUsd, setCupoUsd] = useState("");
  const [cycleStart, setCycleStart] = useState("");
  const [cycleEnd, setCycleEnd] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const config = data?.config;

  // Prefills are written in the separator setting's convention, so a setting change re-derives them.
  useEffect(() => {
    if (!config) return;
    const clp = config.cupo.find((c) => c.currency === "clp")?.value;
    const usd = config.cupo.find((c) => c.currency === "usd")?.value;
    setCupoClp(clp != null ? formatNumberInput(clp) : "");
    setCupoUsd(usd != null ? formatNumberInput(usd) : "");
    setCycleStart(formatNumberInput(config.billing_cycle_start_day));
    setCycleEnd(
      config.billing_cycle_end_day != null ? formatNumberInput(config.billing_cycle_end_day) : ""
    );
  }, [config, decimalSeparator]);

  if (error instanceof Error) {
    return (
      <section style={{ margin: "1.5rem 0" }}>
        <h2 className="flow-section-title">{t("accountDetail.creditCard.configTitle")}</h2>
        <p className="error">{error.message}</p>
      </section>
    );
  }
  // The config is always present once loaded (the server defaults a missing row): `!config` only
  // means pending, so the form frames itself empty, dimmed and inert until it arrives.
  const pending = !config;

  const onSave = () => {
    setSaved(false);
    const inputs = [cupoClp, cupoUsd, cycleStart, cycleEnd].map((raw) => parseNumberInput(raw));
    for (const input of inputs) {
      if (!input.ok) {
        setFormError(input.message);
        return;
      }
    }
    const [clp, usd, startValue, endValue] = inputs.map((input) => (input.ok ? input.value : null));
    if ((clp != null && (clp < 0 || !Number.isInteger(clp))) || (usd != null && usd < 0)) {
      setFormError(t("accountDetail.creditCard.configInvalidCupo"));
      return;
    }
    const start = cycleDayFromInput(startValue);
    const end = cycleDayFromInput(endValue);
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
    <section className={loadableClass(pending)} style={{ margin: "1.5rem 0" }}>
      <h2 className="flow-section-title">{t("accountDetail.creditCard.configTitle")}</h2>
      {config?.card_last4 ? (
        <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
          {t("accountDetail.creditCard.configCardLabel")} <span className="mono">·{config.card_last4}</span>
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
          gap: "0.5rem 0.75rem",
          alignItems: "end",
          maxWidth: "40rem",
        }}
      >
        <Field label={t("accountDetail.creditCard.configCupoClpLabel")}>
          <Input
            type="text"
            inputMode="decimal"
            value={cupoClp}
            disabled={pending}
            placeholder="5000000"
            onChange={(e) => onFieldChange(setCupoClp)(e.target.value)}
          />
        </Field>
        <Field label={t("accountDetail.creditCard.configCupoUsdLabel")}>
          <Input
            type="text"
            inputMode="decimal"
            value={cupoUsd}
            disabled={pending}
            placeholder="3000"
            onChange={(e) => onFieldChange(setCupoUsd)(e.target.value)}
          />
        </Field>
        <Field label={t("accountDetail.creditCard.configCycleStartLabel")}>
          <Input
            type="text"
            inputMode="numeric"
            value={cycleStart}
            disabled={pending}
            placeholder="21"
            onChange={(e) => onFieldChange(setCycleStart)(e.target.value)}
          />
        </Field>
        <Field label={t("accountDetail.creditCard.configCycleEndLabel")}>
          <Input
            type="text"
            inputMode="numeric"
            value={cycleEnd}
            disabled={pending}
            placeholder="20"
            onChange={(e) => onFieldChange(setCycleEnd)(e.target.value)}
          />
        </Field>
        <div style={{ ...brokerageMovementFieldRowStyle(), display: "flex", alignItems: "flex-end" }}>
          <Button disabled={pending || patchMutation.isPending} onClick={onSave}>
            {patchMutation.isPending
              ? t("common.loading")
              : t("accountDetail.creditCard.configSaveBtn")}
          </Button>
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
