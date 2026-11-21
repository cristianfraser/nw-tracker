import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../cn";
import { shownNameText, useTranslation } from "../../i18n";
import { currencyFormatInfo, formatGroupedDecimal, formatMoney } from "../../format";
import { formatDayWeekdayLabel, formatMonthShortLabel, formatYearMonthLabel } from "../../formatDateLabel";
import { useCheckingStatement } from "../../queries/hooks";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import { loadableClass } from "../ui/Loadable";
import {
  Joined,
  useExpenseVendorInfo,
  useExpenseVendorLinkLabel,
  type ExpenseVendorLinks,
} from "../credit-card/ExpenseVendorLabel";
import { HoverPopover } from "../ui/HoverPopover";
import { InfoIcon } from "../icons/InfoIcon";
import { CalendarIcon } from "../icons/CalendarIcon";
import type {
  CheckingBalanceStripDto,
  CheckingGlanceDto,
  CheckingStatementKindFilter,
  CheckingStatementMonthDto,
  CheckingStatementRowDto,
  CheckingStripRange,
} from "../../types";
import styles from "./CheckingStatement.module.css";

const RANGES: readonly CheckingStripRange[] = ["90d", "1y", "5y", "total"];
const KINDS: readonly (CheckingStatementKindFilter | "all")[] = ["all", "income", "card_payment", "own_transfer", "other", "fee"];
/** Income kinds with a label of their own (`income.chart.*`). */
const LABELLED_INCOME_KINDS = new Set(["salary", "severance", "parent_gift", "rent"]);
const BLANK = " ";

/** A signed amount without its symbol («+21.102», «−150.000»), in the currency's own digits. */
function signed(value: number, currency: string): string {
  const digits = currencyFormatInfo(currency).minorDigits;
  const body = formatGroupedDecimal(Math.abs(value), digits, digits);
  return value > 0 ? `+${body}` : value < 0 ? `−${body}` : body;
}

/** An unsigned figure without its symbol, in the currency's own digits (negatives keep their sign). */
function plain(value: number, currency: string): string {
  const digits = currencyFormatInfo(currency).minorDigits;
  const body = formatGroupedDecimal(Math.abs(value), digits, digits);
  return value < 0 ? `−${body}` : body;
}

/** The balance strip: end-of-day step line over the range, the month in view banded, a click jumps to a month. */
function BalanceStrip({
  strip,
  currency,
  activeMonth,
  onPickMonth,
}: {
  strip: CheckingBalanceStripDto;
  currency: string;
  activeMonth: string | null;
  onPickMonth: (periodMonth: string) => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<{ x: number; date: string; balance: number } | null>(null);
  const path = useMemo(() => {
    const pts = strip.points;
    if (pts.length === 0) return "";
    let d = `M${pts[0]!.x * 1000},${(1 - pts[0]!.y) * 100}`;
    for (let i = 1; i < pts.length; i++) {
      d += `H${pts[i]!.x * 1000}V${(1 - pts[i]!.y) * 100}`;
    }
    return d;
  }, [strip]);
  const band = strip.months.find((m) => m.period_month === activeMonth) ?? null;
  const last = strip.points[strip.points.length - 1];

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    let hit = strip.points[0];
    for (const p of strip.points) {
      if (p.x <= fx) hit = p;
      else break;
    }
    if (hit) setHover({ x: fx, date: hit.date, balance: hit.balance });
  };

  return (
    <div className={styles.strip}>
      <div
        className={styles.plot}
        role="img"
        aria-label={t("accountDetail.checking.glance.stripAria")}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className={styles.svg} aria-hidden>
          {band ? (
            <rect className={styles.band} x={band.x0 * 1000} width={(band.x1 - band.x0) * 1000} y={0} height={100} />
          ) : null}
          {strip.months.slice(1).map((m) => (
            <line key={m.period_month} className={styles.monthRule} x1={m.x0 * 1000} x2={m.x0 * 1000} y1={0} y2={100} />
          ))}
          {strip.zero_y > 0 ? (
            <line className={styles.zero} x1={0} x2={1000} y1={(1 - strip.zero_y) * 100} y2={(1 - strip.zero_y) * 100} />
          ) : null}
          <path className={styles.line} d={path} />
        </svg>
        {last ? (
          <span className={styles.endDot} style={{ left: `${last.x * 100}%`, top: `${(1 - last.y) * 100}%` }} />
        ) : null}
        {hover ? (
          <span className={cn("mono", styles.hover)} style={{ left: `${Math.min(hover.x, 0.85) * 100}%` }}>
            {hover.date} · {formatMoney({ value: hover.balance, currency })}
          </span>
        ) : null}
      </div>
      <div className={styles.monthLabels}>
        {strip.months.map((m, i) => {
          const labelled =
            strip.label_every === "month" ? true : m.period_month.endsWith("-01") || i === 0;
          if (!labelled) return null;
          return (
            <button
              key={m.period_month}
              type="button"
              className={cn(styles.monthLabel, m.period_month === activeMonth && styles.monthLabelActive)}
              style={{ left: `${((m.x0 + m.x1) / 2) * 100}%` }}
              onClick={() => onPickMonth(m.period_month)}
            >
              {strip.label_every === "month" ? formatMonthShortLabel(m.period_month) : m.period_month.slice(0, 4)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What a row is, the word it opens with; null on a fee (the bank's own name says it). */
function rowTypeLabel(row: CheckingStatementRowDto, t: (key: string) => string): string | null {
  if (row.kind === "card_payment") return t("accountDetail.checking.statement.type.cardPayment");
  if (row.kind === "fee") return null;
  if (row.income_kind != null && LABELLED_INCOME_KINDS.has(row.income_kind)) return t(`income.chart.${row.income_kind}`);
  return t(row.amount > 0 ? "accountDetail.checking.statement.type.deposit" : "accountDetail.checking.statement.type.withdrawal");
}

/** A row that is not a bank movement (a transfer between own accounts) has nothing for the ⓘ card. */
const NO_VENDOR: ExpenseVendorLinks = {};

/**
 * A row's ⓘ card: the bank's own text and the transfer mail behind it (a bank movement), and the day
 * the bank posted it when that is not the movement's day. Null when there is nothing to add.
 */
function RowInfo({ row }: { row: CheckingStatementRowDto }) {
  const { t } = useTranslation();
  const blocks = useExpenseVendorInfo(row.vendor ?? NO_VENDOR);
  if (row.posted_on) {
    blocks.push(
      <div key="posted" className="muted">
        {t("accountDetail.checking.statement.postedOn", { date: row.posted_on })}
      </div>
    );
  }
  if (blocks.length === 0) return null;
  return (
    <HoverPopover className={styles.info} ariaLabel={t("expenses.creditCard.lineRow.infoAria")} trigger={<InfoIcon size={14} />}>
      {blocks}
    </HoverPopover>
  );
}

/**
 * A row's text: what it is, then who: «Depósito ← Ana Prueba», «Pago tarjeta → santander
 * ·1234», «Sueldo ← Empresa Chile»; a movement that names nobody, what it is and the bank's name for it
 * («Retiro · Cajero automático»). Everything else (the bank's text, the mail, the posting day) is in
 * the row's ⓘ.
 */
function RowText({ row }: { row: CheckingStatementRowDto }) {
  const { t } = useTranslation();
  const linkLabel = useExpenseVendorLinkLabel(row.vendor ?? NO_VENDOR);
  const type = rowTypeLabel(row, t);
  const party = row.counterpart
    ? { direction: row.counterpart.direction, label: row.counterpart.name, own: true }
    : row.party
      ? { ...row.party, own: false }
      : null;
  return (
    <>
      {type ? <span className={styles.type}>{type}</span> : null}
      {party ? (
        <>
          <span className={styles.arrow}>{party.direction === "in" ? "\u2190" : "\u2192"}</span>
          <span className={party.own ? styles.counterpart : styles.party}>{party.label}</span>
        </>
      ) : row.vendor ? (
        <>
          {type ? <span className={styles.dot}>{"\u00b7"}</span> : null}
          <span className={styles.text}>{shownNameText(row.vendor.name)}</span>
          {linkLabel?.inline ? (
            <>
              <span className={styles.dot}>{"\u00b7"}</span>
              <span className={styles.linkLabel}>
                <Joined parts={linkLabel.parts} />
              </span>
            </>
          ) : null}
        </>
      ) : null}
      <RowInfo row={row} />
      {row.forward_posted ? <span className={styles.tag}>{t("accountDetail.checking.statement.forwardPosted")}</span> : null}
    </>
  );
}

/** A month's head: name and cartola mark, money in and out, the change, opening → closing. */
function MonthHead({
  month,
  currency,
}: {
  month: CheckingStatementMonthDto;
  currency: string;
}) {
  const { t } = useTranslation();
  const change = month.closing_balance - month.opening_balance;
  const rec = month.reconciliation;
  const recMark =
    rec.status === "matches" ? (
      <span className={styles.matches} title={t("accountDetail.checking.statement.matches")}>
        {"✓"}
      </span>
    ) : rec.status === "differs" ? (
      <span
        className={styles.differs}
        title={t("accountDetail.checking.statement.differs", { difference: formatMoney({ value: rec.difference, currency }) })}
      >
        {signed(rec.difference, currency)}
      </span>
    ) : rec.status === "open" ? (
      <span className={styles.status}>{t("accountDetail.checking.statement.open")}</span>
    ) : (
      <span className={styles.status}>{t("accountDetail.checking.statement.noStatement")}</span>
    );
  return (
    <header className={styles.monthHead}>
      <span className={styles.monthName}>
        {formatYearMonthLabel(month.period_month)}
        {recMark}
      </span>
      <span className={cn("mono", styles.flows)}>
        <span className={styles.in}>{signed(month.money_in, currency)}</span>{" "}
        <span>{signed(-month.money_out, currency)}</span>
      </span>
      <span className={cn("mono", styles.change)}>{signed(change, currency)}</span>
      <span className={cn("mono", styles.span)}>
        <span className={styles.from}>{plain(month.opening_balance, currency)} {"→"} </span>
        {formatMoney({ value: month.closing_balance, currency })}
      </span>
    </header>
  );
}

function MonthSection({
  month,
  currency,
  registerSection,
}: {
  month: CheckingStatementMonthDto;
  currency: string;
  registerSection: (periodMonth: string, el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  // The month's rows by day (rows run newest first, a day's rows together): each day is one block.
  const days: CheckingStatementRowDto[][] = [];
  for (const row of month.rows) {
    const last = days[days.length - 1];
    if (last && last[0]!.occurred_on === row.occurred_on) last.push(row);
    else days.push([row]);
  }
  return (
    <section className={styles.month} data-month={month.period_month} ref={(el) => registerSection(month.period_month, el)}>
      <MonthHead month={month} currency={currency} />
      {days.map((day) => (
        <div key={day[0]!.occurred_on} className={styles.day}>
          {/* A narrow list's day line, above the day's bar (a wide list dates the first row). */}
          <div className={styles.dayHead}>
            <CalendarIcon size={12} className={styles.dayIcon} />
            {formatDayWeekdayLabel(day[0]!.occurred_on)}
          </div>
          <div className={styles.dayRows}>
          {day.map((row, i) => (
            <div
              key={row.movement_id}
              className={cn(styles.row, i === 0 && styles.dayStart, row.income_kind === "salary" && styles.salary)}
            >
              <span className={cn("mono", styles.date)}>
                {/* The day and its weekday: the month and year are the month's head. */}
                {i === 0 ? formatDayWeekdayLabel(row.occurred_on) : BLANK}
              </span>
              <span className={cn(styles.typeTop, styles.type)}>{rowTypeLabel(row, t) ?? BLANK}</span>
              <span className={styles.what}>
                <RowText row={row} />
              </span>
              <span className={cn("mono", styles.amount, row.amount > 0 && styles.in)}>{signed(row.amount, currency)}</span>
              <span className={cn("mono", styles.balance)}>{plain(row.balance_after, currency)}</span>
            </div>
          ))}
          </div>
        </div>
      ))}
      {month.hidden ? (
        <div className={cn(styles.row, styles.hiddenRow)}>
          <span className={styles.date}>{BLANK}</span>
          <span className={styles.what}>
            {t("accountDetail.checking.statement.hidden", {
              count: month.hidden.count,
              net: signed(month.hidden.net, currency),
            })}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The checking page's statement (server `checkingStatement.ts`): a sticky head with the balance strip
 * and the filters, then whole months newest first, each row with the balance after it. The month in
 * view is banded on the strip; a month label on the strip scrolls to it.
 */
export function CheckingStatement({
  accountId,
  glance,
  loading,
  onAdjustOpening,
}: {
  accountId: number;
  /** The page's head: undefined while the bundle is not in. */
  glance: CheckingGlanceDto | null | undefined;
  loading: boolean;
  /** Opens the ledger anchor form (the statement's first line). */
  onAdjustOpening: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const [range, setRange] = useState<CheckingStripRange>("1y");
  const [kind, setKind] = useState<CheckingStatementKindFilter | "all">("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [hideOwn, setHideOwn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const query = useCheckingStatement(accountId, { kind: kind === "all" ? undefined : kind, q: q || undefined, hideOwn });
  const statementLoading = loading || queryShowsLoading(query);
  const pages = query.data?.pages ?? [];
  const months = pages.flatMap((p) => p.months);
  const currency = glance?.currency ?? pages[0]?.currency ?? null;
  const opening = pages.length > 0 ? pages[pages.length - 1]!.opening : null;

  // The head (strip, filters) and each month's header are `position: sticky` (CSS): the head under
  // the ticker, a month's header under the head inside its own month, so the next month pushes it up.
  // The month headers stick below the head, whose height the stylesheet cannot know: measured here.
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const head = headRef.current;
    if (!root || !head) return;
    const observer = new ResizeObserver(() => root.style.setProperty("--statement-head-h", `${head.offsetHeight}px`));
    observer.observe(head);
    return () => observer.disconnect();
  }, []);

  // The month in view: the last month whose section has reached the head's foot.
  const sections = useRef(new Map<string, HTMLElement>());
  const registerSection = (periodMonth: string, el: HTMLElement | null) => {
    if (el) sections.current.set(periodMonth, el);
    else sections.current.delete(periodMonth);
  };
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      const line = Math.max(0, headRef.current?.getBoundingClientRect().bottom ?? 0) + 8;
      let current: string | null = months[0]?.period_month ?? null;
      for (const m of months) {
        const el = sections.current.get(m.period_month);
        if (el && el.getBoundingClientRect().top <= line) current = m.period_month;
      }
      setActiveMonth(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [months]);

  const pickMonth = (periodMonth: string) => {
    const el = sections.current.get(periodMonth);
    const head = headRef.current;
    if (!el || !head) return;
    window.scrollBy({ top: el.getBoundingClientRect().top - head.getBoundingClientRect().bottom, behavior: "smooth" });
  };

  const strip = glance?.strips.find((s) => s.range === range) ?? null;

  return (
    <div className={styles.statement} ref={rootRef}>
      <div className={styles.head} ref={headRef}>
        <div className={loadableClass(glance === undefined, styles.stripFrame)}>
          {strip && currency ? (
            <BalanceStrip strip={strip} currency={currency} activeMonth={activeMonth} onPickMonth={pickMonth} />
          ) : (
            <div className={styles.strip} />
          )}
          <div className={styles.ranges}>
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={cn(styles.chip, r === range && styles.chipOn)}
                onClick={() => setRange(r)}
              >
                {t(`accountDetail.checking.glance.range.${r}`)}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.filters}>
          <input
            className={styles.search}
            type="search"
            value={search}
            placeholder={t("accountDetail.checking.statement.search")}
            aria-label={t("accountDetail.checking.statement.search")}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className={styles.kinds}>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={cn(styles.chip, k === kind && styles.chipOn)}
                onClick={() => setKind(k)}
              >
                {t(`accountDetail.checking.statement.kind.${k}`)}
              </button>
            ))}
          </span>
          <label className={styles.toggle}>
            <input type="checkbox" checked={hideOwn} onChange={(e) => setHideOwn(e.target.checked)} />
            {t("accountDetail.checking.statement.hideOwn")}
          </label>
        </div>
      </div>

      <div className={loadableClass(statementLoading, styles.months)} aria-busy={statementLoading || undefined}>
        {currency
          ? months.map((m) => (
              <MonthSection key={m.period_month} month={m} currency={currency} registerSection={registerSection} />
            ))
          : null}
        {!statementLoading && months.length === 0 ? (
          <p className="muted">{t("accountDetail.checking.statement.none")}</p>
        ) : null}
        {query.hasNextPage ? (
          <button
            type="button"
            className={styles.more}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t("accountDetail.checking.statement.more")}
          </button>
        ) : opening && currency ? (
          <div className={cn(styles.row, styles.openingRow)}>
            <span className={cn("mono", styles.date)}>{opening.occurred_on}</span>
            <span className={styles.what}>
              {t("accountDetail.checking.statement.opening")}
              <button type="button" className={styles.adjust} onClick={onAdjustOpening}>
                {t("accountDetail.checking.statement.adjust")}
              </button>
            </span>
            <span className={styles.amount}>{BLANK}</span>
            <span className={cn("mono", styles.balance)}>{plain(opening.amount, currency)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
