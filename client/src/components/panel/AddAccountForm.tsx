import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { listLeafPortfolioGroupBuckets } from "../../panelAccounts/portfolioNavBuckets";
import {
  PANEL_ACCOUNT_BUCKETS,
  PANEL_ACCOUNT_KINDS,
  buildPanelAccountCreatePreview,
  defaultPanelAccountFormDraft,
  flowKindsForPanelAccountKind,
  isEquityPanelAccountKind,
  type PanelAccountFormDraft,
  type PanelAccountKind,
} from "../../panelAccounts/panelAccountFormTypes";
import type { NavTreeNodeDto } from "../../types";
import { BrokerageMovementsSection } from "./BrokerageMovementsSection";

const ACCOUNT_KIND_LABEL_KEYS: Record<PanelAccountKind, string> = {
  stocks_nyse: "panelAccounts.addAccount.accountKind.stocksNyse",
  crypto_eod: "panelAccounts.addAccount.accountKind.cryptoEod",
  usd_cash: "panelAccounts.addAccount.accountKind.usdCash",
};

type Props = {
  netWorthRoot: NavTreeNodeDto | null;
};

function fieldLabelStyle(): CSSProperties {
  return { display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" };
}

function fieldRowStyle(): CSSProperties {
  return { marginBottom: "0.75rem" };
}

export function AddAccountForm({ netWorthRoot }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PanelAccountFormDraft>(() =>
    defaultPanelAccountFormDraft("stocks_nyse")
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<number | null>(null);

  const allowedBucketSlugs = useMemo(
    () => new Set(PANEL_ACCOUNT_BUCKETS[draft.accountKind]),
    [draft.accountKind]
  );
  const leafBuckets = useMemo(
    () =>
      listLeafPortfolioGroupBuckets(netWorthRoot).filter((b) => allowedBucketSlugs.has(b.slug)),
    [netWorthRoot, allowedBucketSlugs]
  );

  const createMutation = useMutation({
    mutationFn: async (payload: NonNullable<ReturnType<typeof buildPanelAccountCreatePreview>>) => {
      if ("kind" in payload.account && payload.account.kind === "usd_cash") {
        return api.createUsdCashAccount(payload);
      }
      return api.createStockAccount(payload);
    },
    onSuccess: async (result) => {
      setCreatedAccountId(result.account_id);
      setFormError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panelNetWorthTree() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarNav() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("clp") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("usd") }),
      ]);
    },
    onError: (err: Error) => {
      setFormError(err.message);
      setCreatedAccountId(null);
    },
  });

  function updateDraft(patch: Partial<PanelAccountFormDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setFormError(null);
    setCreatedAccountId(null);
  }

  function onAccountKindChange(kind: PanelAccountKind) {
    setDraft(defaultPanelAccountFormDraft(kind));
    setFormError(null);
    setCreatedAccountId(null);
  }

  function onTickerChange(ticker: string) {
    updateDraft({ tickerSymbol: ticker.toUpperCase() });
  }

  function resetForm() {
    setDraft(defaultPanelAccountFormDraft(draft.accountKind));
    setFormError(null);
    setCreatedAccountId(null);
    createMutation.reset();
  }

  function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreatedAccountId(null);
    const payload = buildPanelAccountCreatePreview(draft);
    if (!payload) {
      setFormError(t("panelAccounts.addAccount.previewInvalid"));
      return;
    }
    createMutation.mutate(payload);
  }

  const isEquity = isEquityPanelAccountKind(draft.accountKind);
  const displayNamePlaceholder = isEquity
    ? t("panelAccounts.addAccount.displayNamePlaceholder")
    : t("panelAccounts.addUsdAccount.displayNamePlaceholder");

  return (
    <form onSubmit={onCreateSubmit} style={{ maxWidth: "52rem", marginBottom: "2rem" }}>
      <label style={fieldRowStyle()}>
        <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.accountKind")}</span>
        <select
          value={draft.accountKind}
          onChange={(e) => onAccountKindChange(e.target.value as PanelAccountKind)}
        >
          {PANEL_ACCOUNT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(ACCOUNT_KIND_LABEL_KEYS[kind])}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldRowStyle()}>
        <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.displayName")}</span>
        <input
          type="text"
          value={draft.displayName}
          onChange={(e) => updateDraft({ displayName: e.target.value })}
          placeholder={displayNamePlaceholder}
          required
        />
      </label>

      {isEquity ? (
        <label style={fieldRowStyle()}>
          <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.tickerSymbol")}</span>
          <input
            type="text"
            className="mono"
            value={draft.tickerSymbol}
            onChange={(e) => onTickerChange(e.target.value)}
            placeholder="QQQ"
            required
          />
        </label>
      ) : null}

      <label style={fieldRowStyle()}>
        <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.bucket")}</span>
        <select
          value={draft.bucketSlug}
          onChange={(e) => updateDraft({ bucketSlug: e.target.value })}
        >
          {leafBuckets.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.label} ({b.slug})
            </option>
          ))}
        </select>
      </label>

      <label style={{ ...fieldRowStyle(), display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.excludeFromGroupTotals}
          onChange={(e) => updateDraft({ excludeFromGroupTotals: e.target.checked })}
        />
        <span>{t("panelAccounts.addAccount.excludeFromTotals")}</span>
      </label>

      <BrokerageMovementsSection
        movements={draft.initialMovements}
        onChange={(initialMovements) => {
          setDraft((prev) => ({ ...prev, initialMovements }));
          setFormError(null);
          setCreatedAccountId(null);
        }}
        flowKinds={flowKindsForPanelAccountKind(draft.accountKind)}
        legend="optional"
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1.25rem" }}>
        <button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending
            ? t("common.loading")
            : t("panelAccounts.addAccount.createBtn")}
        </button>
        <button type="button" onClick={resetForm} disabled={createMutation.isPending}>
          {t("panelAccounts.addAccount.resetBtn")}
        </button>
      </div>

      {formError ? (
        <p className="error" style={{ marginTop: "1rem" }}>
          {formError}
        </p>
      ) : null}
      {createdAccountId != null ? (
        <p style={{ marginTop: "1rem" }}>
          {t("panelAccounts.addAccount.createSuccess", { id: createdAccountId })}
        </p>
      ) : null}
    </form>
  );
}
