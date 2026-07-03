import { Link } from "react-router-dom";
import { useTranslation } from "../i18n";
import { Table } from "../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { formatClp, formatOrDash, formatUsd } from "../format";
import { useCreditCards } from "../queries/hooks";
import type { OperationalCreditCardRow } from "../types";

function cupoValue(card: OperationalCreditCardRow, currency: "clp" | "usd"): number | null {
  return card.cupo.find((c) => c.currency === currency)?.value ?? null;
}

/** Operational Tarjetas de crédito page (`/credit-cards`): cards + config, outside Pasivos. */
export function CreditCardsPage() {
  const { t } = useTranslation();
  const { data, error, isPending } = useCreditCards();

  if (isPending) {
    return (
      <main>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }
  if (error) {
    return (
      <main>
        <p className="error">
          {error instanceof Error ? error.message : t("creditCards.loadFailed")}
        </p>
      </main>
    );
  }

  const cards = data?.cards ?? [];

  const cycleLabel = (card: OperationalCreditCardRow) =>
    t("creditCards.cycleDays", {
      start: card.billing_cycle_start_day,
      end: card.billing_cycle_end_day ?? 20,
    });

  const cardTitle = (card: OperationalCreditCardRow) => (
    <>
      <Link to={`/account/${card.account_id}`}>{card.name}</Link>
      {card.card_last4 ? <span className="muted mono"> ·{card.card_last4}</span> : null}
    </>
  );

  return (
    <main>
      <h1>{t("creditCards.pageTitle")}</h1>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        {t("creditCards.pageHint")}
      </p>
      <p className="muted" style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
        {t("creditCards.manageHint")}
      </p>

      <Table
        header={
          <thead>
            <tr>
              <th className="desktop-only">{t("creditCards.colCard")}</th>
              <th className="desktop-only">{t("creditCards.colCupoClp")}</th>
              <th className="desktop-only">{t("creditCards.colCupoUsd")}</th>
              <th className="desktop-only">{t("creditCards.colCycle")}</th>
              <th className="desktop-only">{t("creditCards.colBalance")}</th>
              <th className="desktop-only">{t("creditCards.colActions")}</th>
              <th className="mobile-only" aria-hidden="true" />
            </tr>
          </thead>
        }
      >
        {cards.length === 0 ? (
          <tr>
            <td colSpan={6} className="muted">
              {t("creditCards.empty")}
            </td>
          </tr>
        ) : (
          cards.map((card) => (
            <tr key={card.account_id}>
              <td className="desktop-only">{cardTitle(card)}</td>
              <td className="mono desktop-only">
                {formatOrDash(cupoValue(card, "clp"), formatClp)}
              </td>
              <td className="mono desktop-only">
                {formatOrDash(cupoValue(card, "usd"), formatUsd)}
              </td>
              <td className="desktop-only">{cycleLabel(card)}</td>
              <td className="mono desktop-only">{formatOrDash(card.balance_clp, formatClp)}</td>
              <td className="desktop-only">
                <Link to={`/account/${card.account_id}`}>{t("creditCards.manageLink")}</Link>
              </td>
              <td className="mobile-only">
                <TableMobileCard title={cardTitle(card)}>
                  <TableMobileCardRow
                    label={t("creditCards.colCupoClp")}
                    value={<span className="mono">{formatOrDash(cupoValue(card, "clp"), formatClp)}</span>}
                  />
                  <TableMobileCardRow
                    label={t("creditCards.colCupoUsd")}
                    value={<span className="mono">{formatOrDash(cupoValue(card, "usd"), formatUsd)}</span>}
                  />
                  <TableMobileCardRow
                    label={t("creditCards.colCycle")}
                    value={cycleLabel(card)}
                  />
                  <TableMobileCardRow
                    label={t("creditCards.colBalance")}
                    value={<span className="mono">{formatOrDash(card.balance_clp, formatClp)}</span>}
                  />
                  <TableMobileCardRow
                    label={t("creditCards.colActions")}
                    value={
                      <Link to={`/account/${card.account_id}`}>
                        {t("creditCards.manageLink")}
                      </Link>
                    }
                  />
                </TableMobileCard>
              </td>
            </tr>
          ))
        )}
      </Table>
    </main>
  );
}
