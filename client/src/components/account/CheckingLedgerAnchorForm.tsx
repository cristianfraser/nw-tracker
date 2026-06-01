import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { formatClp } from "../../format";
import { useTranslation } from "../../i18n";
import { queryKeys, type DisplayUnit } from "../../queries/keys";
import type { CartolaDerivedAnchorDto, CheckingLedgerAnchorDto } from "../../types";
import { formatYmEs } from "../../pages/accountDetail/shared";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
  ledgerAnchor: CheckingLedgerAnchorDto | null;
  cartolaDerivedAnchor: CartolaDerivedAnchorDto | null;
};

export function CheckingLedgerAnchorForm({
  accountId,
  displayUnit,
  extraCcOffsetsKey,
  ledgerAnchor,
  cartolaDerivedAnchor,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (ledgerAnchor) {
      setAmount(String(ledgerAnchor.amount_clp));
      setOccurredOn(ledgerAnchor.occurred_on);
    } else if (cartolaDerivedAnchor) {
      setAmount(String(cartolaDerivedAnchor.amount_clp));
      setOccurredOn(cartolaDerivedAnchor.occurred_on);
    } else {
      setAmount("");
      setOccurredOn("");
    }
  }, [ledgerAnchor, cartolaDerivedAnchor]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly", extraCcOffsetsKey),
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const amount_clp = Number(amount);
      if (!Number.isFinite(amount_clp)) {
        throw new Error(t("accountDetail.checking.ledgerAnchorAmount"));
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
        throw new Error(t("accountDetail.checking.ledgerAnchorDate"));
      }
      return api.putCheckingLedgerAnchor(accountId, { amount_clp: Math.round(amount_clp), occurred_on: occurredOn });
    },
    onSuccess: async () => {
      setStatus(t("accountDetail.checking.ledgerAnchorSaved"));
      await invalidate();
    },
    onError: (err: Error) => setStatus(err.message),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.putCheckingLedgerAnchor(accountId, { clear: true }),
    onSuccess: async () => {
      setStatus(t("accountDetail.checking.ledgerAnchorCleared"));
      await invalidate();
    },
    onError: (err: Error) => setStatus(err.message),
  });

  if (!cartolaDerivedAnchor && !ledgerAnchor) {
    return (
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.75rem" }}>
        {t("accountDetail.checking.ledgerAnchorNoCartola")}
      </p>
    );
  }

  return (
    <section style={{ marginBottom: "1rem" }}>
      <h3 style={{ fontSize: "var(--font-size-ui)", margin: "0 0 0.35rem" }}>
        {t("accountDetail.checking.ledgerAnchorTitle")}
      </h3>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", margin: "0 0 0.75rem" }}>
        {t("accountDetail.checking.ledgerAnchorHint")}
      </p>
      {cartolaDerivedAnchor ? (
        <p className="muted" style={{ fontSize: "var(--font-size-ui)", margin: "0 0 0.75rem" }}>
          {t("accountDetail.checking.ledgerAnchorDerived", {
            month: formatYmEs(cartolaDerivedAnchor.period_month),
            amount: formatClp(cartolaDerivedAnchor.amount_clp),
            date: cartolaDerivedAnchor.occurred_on,
          })}
        </p>
      ) : null}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "flex-end",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span className="muted" style={{ fontSize: "var(--font-size-ui)" }}>
            {t("accountDetail.checking.ledgerAnchorAmount")}
          </span>
          <input
            type="number"
            className="mono"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setStatus(null);
            }}
            style={{ width: "10rem" }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span className="muted" style={{ fontSize: "var(--font-size-ui)" }}>
            {t("accountDetail.checking.ledgerAnchorDate")}
          </span>
          <input
            type="date"
            className="mono"
            value={occurredOn}
            onChange={(e) => {
              setOccurredOn(e.target.value);
              setStatus(null);
            }}
          />
        </label>
        <button
          type="button"
          disabled={saveMutation.isPending || clearMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t("accountDetail.checking.ledgerAnchorSave")}
        </button>
        {ledgerAnchor ? (
          <button
            type="button"
            disabled={saveMutation.isPending || clearMutation.isPending}
            onClick={() => clearMutation.mutate()}
          >
            {t("accountDetail.checking.ledgerAnchorClear")}
          </button>
        ) : null}
      </div>
      {status ? (
        <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginTop: "0.5rem" }}>
          {status}
        </p>
      ) : null}
    </section>
  );
}
