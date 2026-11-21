import type { ReactNode } from "react";
import { cn } from "../../cn";
import { shownNameText, useTranslation } from "../../i18n";
import type { FlowCcExpenseLineRow } from "../../types";
import { HoverPopover } from "../ui/HoverPopover";
import { InfoIcon } from "../icons/InfoIcon";
import { MoreIcon } from "../icons/MoreIcon";
import { paymentReceiptDetailLines } from "../flows/PaymentReceiptLine";
import { transferCounterpartyDetailLines } from "../flows/TransferCounterpartyLine";
import styles from "./ExpenseVendorLabel.module.css";

/**
 * What a vendor label reads: the one name the server built (`name`), the bank's text behind it for
 * the ⓘ card (`name_detail`) and the links behind it. An expense line carries all of it; a card plan
 * the fields its lines carry.
 */
export type ExpenseVendorSource = Pick<FlowCcExpenseLineRow, "name"> &
  Partial<
    Pick<
      FlowCcExpenseLineRow,
      | "name_detail"
      | "link_label"
      | "payment_receipt"
      | "transfer_counterparty"
      | "expense_deposit_links"
      | "line_role"
      | "nro_cuota_total"
      | "annulled"
      | "annulment"
      | "refund_of"
    >
  >;

/** What the ⓘ card and the link label read: everything about a source but its name. */
export type ExpenseVendorLinks = Omit<ExpenseVendorSource, "name">;

export type ExpenseVendorLinkLabel = { parts: string[]; inline: boolean };

export function Sep() {
  return (
    <span className={styles.sep} aria-hidden>
      ·
    </span>
  );
}

/** Text parts with a separator between each («Lisboa», «3 nights» → Lisboa · 3 nights). */
export function Joined({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? <Sep /> : null}
          {part}
        </span>
      ))}
    </>
  );
}

function InfoBlock({ lines }: { lines: readonly string[] }) {
  return (
    <div className={styles.infoBlock}>
      {lines.map((text, i) => (
        <div key={i} className={i === 0 ? undefined : "muted"}>
          {text}
        </div>
      ))}
    </div>
  );
}

/**
 * The ⓘ card: the merchant as the bank prints it (when the row shows another name), a plan's
 * cuota count on its full-price row, and what the source is linked to (transfer counterparty,
 * payment receipt, deposit), in full.
 */
export function useExpenseVendorInfo(source: ExpenseVendorLinks): ReactNode[] {
  const { t } = useTranslation();
  const blocks: ReactNode[] = [];
  const detail = source.name_detail;
  if (detail) {
    // The row shows another name: the store's name (when a payment's or refund's took its place) and the bank's text go here.
    const bank = detail.store_name != null ? [detail.store_name, detail.bank_text] : [detail.bank_text];
    if (detail.processor) bank.push(t("expenses.creditCard.lineRow.viaProcessor", { processor: detail.processor }));
    blocks.push(<InfoBlock key="bank" lines={bank} />);
  }
  if (source.line_role === "installment_purchase_total") {
    blocks.push(
      <InfoBlock
        key="cuotas"
        lines={[t("expenses.creditCard.installmentPurchaseTotalLabel", { count: source.nro_cuota_total ?? 0 })]}
      />
    );
  }
  if (source.annulled) {
    blocks.push(
      <InfoBlock
        key="annulled"
        lines={[
          t("expenses.creditCard.lineRow.annulled.decided", {
            date: source.annulled.annulled_on,
            basis: t(`expenses.creditCard.lineRow.annulled.basis.${source.annulled.basis}`),
          }),
        ]}
      />
    );
  }
  if (source.annulment) {
    blocks.push(
      <InfoBlock
        key="annulment"
        lines={[t("expenses.creditCard.lineRow.annulled.annulmentOf", { date: source.annulment.purchase_date })]}
      />
    );
  }
  // A refund of a known purchase: the purchase's day (an annulment's own block already says it) and,
  // below, the purchase's receipt.
  if (source.refund_of && !source.annulment) {
    blocks.push(
      <InfoBlock
        key="refundOf"
        lines={[t("expenses.creditCard.lineRow.refundOfPurchase", { date: source.refund_of.purchase_date })]}
      />
    );
  }
  const c = source.transfer_counterparty;
  if (c) blocks.push(<InfoBlock key="counterparty" lines={transferCounterpartyDetailLines(c)} />);
  const r = source.payment_receipt ?? source.refund_of?.payment_receipt;
  if (r) {
    const lines = paymentReceiptDetailLines(r);
    lines[0] = `${r.guess ? "≈" : "→"} ${lines[0]}`;
    blocks.push(<InfoBlock key="receipt" lines={lines} />);
  }
  const mortgageLink = source.expense_deposit_links?.find((l) => l.depto_cuota != null);
  if (mortgageLink) {
    blocks.push(
      <InfoBlock
        key="deposit"
        lines={[t("expenses.creditCard.mortgageDepositLinkCuota", { cuota: mortgageLink.depto_cuota })]}
      />
    );
  } else if ((source.expense_deposit_links?.length ?? 0) > 0) {
    blocks.push(<InfoBlock key="deposit" lines={[t("expenses.creditCard.investmentDepositLink")]} />);
  }
  return blocks;
}

/**
 * The short label of what the source is linked to, as parts the row separates — «Streat Burger
 * (Isidora)», «Lisboa» + «3 nights», «DAME» + «2026-09-12», «← Ana Perez» — or the deposit it pairs with; null when it has none.
 */
export function useExpenseVendorLinkLabel(source: ExpenseVendorLinks): ExpenseVendorLinkLabel | null {
  const { t } = useTranslation();
  const l = source.link_label ?? source.refund_of?.link_label;
  if (l) {
    // «→» (paid to) is what a link on an expense means; only the other directions are shown.
    const parts = [l.arrow === "→" ? l.text : `${l.arrow} ${l.text}`];
    if (l.nights != null) {
      parts.push(
        t(l.nights === 1 ? "expenses.creditCard.lineRow.nightsOne" : "expenses.creditCard.lineRow.nightsMany", {
          count: l.nights,
        })
      );
    }
    if (l.event_on) parts.push(l.event_on);
    return { parts, inline: l.inline };
  }
  const mortgageLink = source.expense_deposit_links?.find((d) => d.depto_cuota != null);
  if (mortgageLink) {
    return { parts: [t("expenses.creditCard.mortgageDepositLinkCuota", { cuota: mortgageLink.depto_cuota })], inline: true };
  }
  if ((source.expense_deposit_links?.length ?? 0) > 0) {
    return { parts: [t("expenses.creditCard.investmentDepositLink")], inline: true };
  }
  return null;
}

/** `merchant · note · link ⓘ` — the vendor cell of an expense row and of a card plan. */
export function ExpenseVendorLabel({
  source,
  note,
  className,
  inline = false,
}: {
  source: ExpenseVendorSource;
  note: string | null | undefined;
  className?: string;
  /** Inside a line of text (the cuotas-por-facturación detail) rather than a block of its own. */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const info = useExpenseVendorInfo(source);
  const linkLabel = useExpenseVendorLinkLabel(source);
  const trimmedNote = note?.trim() ?? "";
  const Root = inline ? "span" : "div";
  return (
    <Root className={cn(styles.vendor, inline && styles.inline, className)}>
      <span className={styles.merchant}>{shownNameText(source.name)}</span>
      {trimmedNote ? (
        <>
          <Sep />
          <span className={styles.note}>{trimmedNote}</span>
        </>
      ) : null}
      {linkLabel?.inline ? (
        <>
          <Sep />
          <span className={styles.linkLabel}>
            <Joined parts={linkLabel.parts} />
          </span>
        </>
      ) : null}
      {info.length > 0 ? (
        <HoverPopover
          className={styles.infoTrigger}
          ariaLabel={t("expenses.creditCard.lineRow.infoAria")}
          trigger={<InfoIcon size={14} />}
        >
          {info}
        </HoverPopover>
      ) : null}
    </Root>
  );
}

/** The link label in full, the first line of a row's ⋯ panel. */
export function ExpenseVendorPanelLink({ linkLabel }: { linkLabel: ExpenseVendorLinkLabel }) {
  return (
    <div className={styles.panelLink}>
      <Joined parts={linkLabel.parts} />
    </div>
  );
}

/** The ⋯ button that opens a row's extras, with a red corner dot when the row waits on the user. */
export function ExpenseRowMoreButton({
  expanded,
  needsAction,
  ariaLabel,
  needsActionTitle,
  onClick,
}: {
  expanded: boolean;
  needsAction?: boolean;
  ariaLabel: string;
  needsActionTitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(styles.moreButton, expanded && styles.moreButtonOpen)}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      title={needsAction ? needsActionTitle : undefined}
      onClick={onClick}
    >
      <MoreIcon size={16} />
      {needsAction ? <span className={styles.needsActionBadge} aria-hidden /> : null}
    </button>
  );
}
