import { useTranslation } from "react-i18next";
import { PageGridTile } from "../layout/PageGridTile";
import { ColumnTable } from "../ui/ColumnTable";
import { loadableClass } from "../ui/Loadable";
import { formatUsd, formatUsdFine } from "../../format";
import type { UsTaxReturnResponse, UsTaxReturnRow } from "../../types";

const dollars = (n: number | null) => (n == null ? "—" : formatUsd(n));

function useLineLabel() {
  const { t, i18n } = useTranslation();
  return (line: string) =>
    i18n.exists(`taxReturn.us.lines.${line}`) ? t(`taxReturn.us.lines.${line}`) : t("taxReturn.us.lineFallback", { line });
}

const lineDiff = (r: UsTaxReturnRow) => (r.changed && r.filed != null ? r.draft - r.filed : null);

function F1040Table({ rows, loading }: { rows: UsTaxReturnRow[]; loading?: boolean }) {
  const { t } = useTranslation();
  const label = useLineLabel();
  return (
    <ColumnTable
      rows={rows}
      rowKey={(r) => r.line}
      wrapClassName={loadableClass(loading)}
      cardLayout="flat"
      rowProps={(r) => ({ style: { fontWeight: r.section === "subtotal" || r.section === "result" ? 600 : undefined } })}
      columns={[
        { key: "line", header: t("taxReturn.us.table.line"), className: "mono", cell: (r) => r.printed_line, title: (r) => `${r.printed_line} · ${label(r.line)}` },
        { key: "concept", header: t("taxReturn.us.table.concept"), cell: (r) => label(r.line), desktopOnly: true },
        { key: "filed", header: t("taxReturn.us.table.filed"), headerClassName: "num", className: "num", cell: (r) => dollars(r.filed) },
        { key: "draft", header: t("taxReturn.us.table.draft"), headerClassName: "num", className: "num", cell: (r) => dollars(r.draft) },
        {
          key: "difference",
          header: t("taxReturn.us.table.difference"),
          headerClassName: "num",
          className: "num",
          cellProps: (r) => (lineDiff(r) != null ? { style: { color: "var(--negative)" } } : {}),
          cell: (r) => {
            const diff = lineDiff(r);
            return diff == null ? "" : formatUsd(diff);
          },
          card: (r) => {
            const diff = lineDiff(r);
            return diff == null ? null : formatUsd(diff);
          },
        },
      ]}
    />
  );
}

/** The US tab of the tax page: the 1040 draft against the filed return, the W-2s, FICA, the settlement. */
export function UsTaxReturnSections({ data, loading }: { data: UsTaxReturnResponse | undefined; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <PageGridTile id="f1040">
        <h2>{t("taxReturn.us.title", { year: data?.tax_year ?? "" })}</h2>
        {data ? (
          <>
            <p className="muted">
              {t("taxReturn.us.intro", { stubs: data.stubs, status: t(`taxReturn.us.filingStatus.${data.filing_status}`), year: data.tax_year })}
            </p>
            {data.notes.map((n) => (
              <p key={n} className="muted">
                {t(`taxReturn.us.notes.${n}`, { year: data.tax_year, lawYear: data.law_year })}
              </p>
            ))}
            <p>
              {data.filed ? t("taxReturn.us.filedOn", { date: data.filed.filed_on }) : t("taxReturn.us.notFiled")} ·{" "}
              {t("taxReturn.us.summaryFiled", { amount: dollars(data.tax_filed) })} ·{" "}
              {t("taxReturn.us.summaryDraft", { amount: dollars(data.tax_draft) })}
              {data.tax_filed != null ? ` · ${t("taxReturn.us.summaryDiff", { amount: formatUsd(data.tax_draft - data.tax_filed) })}` : ""}
              {" · "}
              {data.refund_draft > 0
                ? t("taxReturn.us.refund", { amount: formatUsd(data.refund_draft) })
                : data.owed_draft > 0
                  ? t("taxReturn.us.owed", { amount: formatUsd(data.owed_draft) })
                  : t("taxReturn.us.even")}
            </p>
          </>
        ) : null}
        <F1040Table rows={data?.rows ?? []} loading={loading} />
      </PageGridTile>
      {data ? (
        <>
          <UsSettlementSection data={data} />
          {data.w2s.length > 0 ? (
            <PageGridTile id="w2">
              <h2>{t("taxReturn.us.w2.title")}</h2>
              <p className="muted">{t("taxReturn.us.w2.explain")}</p>
              <ColumnTable
                rows={data.w2s}
                rowKey={(w) => w.ein}
                cardLayout="flat"
                columns={[
                  { key: "employer", header: t("taxReturn.us.w2.employer"), cell: (w) => w.employer, title: (w) => `${w.employer} · ${w.ein}` },
                  { key: "stubs", header: t("taxReturn.us.w2.stubs"), headerClassName: "num", className: "num", cell: (w) => w.stubs },
                  { key: "box1", header: t("taxReturn.us.w2.box1"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box1_wages) },
                  { key: "box2", header: t("taxReturn.us.w2.box2"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box2_federal_withheld) },
                  { key: "box3", header: t("taxReturn.us.w2.box3"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box3_social_security_wages) },
                  { key: "box4", header: t("taxReturn.us.w2.box4"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box4_social_security_tax) },
                  { key: "box5", header: t("taxReturn.us.w2.box5"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box5_medicare_wages) },
                  { key: "box6", header: t("taxReturn.us.w2.box6"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box6_medicare_tax) },
                  { key: "box12d", header: t("taxReturn.us.w2.box12d"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box12_d) },
                  { key: "box12aa", header: t("taxReturn.us.w2.box12aa"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box12_aa) },
                  { key: "box12w", header: t("taxReturn.us.w2.box12w"), headerClassName: "num", className: "num", cell: (w) => formatUsdFine(w.box12_w) },
                ]}
              />
            </PageGridTile>
          ) : null}
          <PageGridTile id="fica">
            <h2>{t("taxReturn.us.fica.title")}</h2>
            <p className="muted">{t("taxReturn.us.fica.explain")}</p>
            <p>
              {t("taxReturn.us.fica.summary", {
                socialSecurity: formatUsdFine(data.fica.social_security),
                medicare: formatUsdFine(data.fica.medicare),
                total: formatUsdFine(data.fica.total),
              })}
            </p>
            {data.fica.additional_medicare_tax > 0 ? (
              <p>{t("taxReturn.us.fica.additional", { amount: formatUsdFine(data.fica.additional_medicare_tax) })}</p>
            ) : null}
          </PageGridTile>
        </>
      ) : null}
    </>
  );
}

function UsSettlementSection({ data }: { data: UsTaxReturnResponse }) {
  const { t } = useTranslation();
  const s = data.settlement;
  if (!s || !s.expected) return null;
  return (
    <PageGridTile id="f1040-settlement">
      <h2>{t("taxReturn.us.settlement.title")}</h2>
      <p>
        {t(`taxReturn.us.settlement.expected.${s.expected.kind}`, { amount: formatUsd(s.expected.amount) })}
        {s.links.length === 0 ? (
          <span style={{ color: "var(--negative)" }}> · {t("taxReturn.us.settlement.notLinked")}</span>
        ) : (
          <>
            {" · "}
            {t(`taxReturn.us.settlement.settled.${s.expected.kind}`, { amount: formatUsdFine(s.settled) })}
            {s.difference != null && s.difference !== 0
              ? ` · ${t("taxReturn.us.settlement.difference", { amount: formatUsdFine(s.difference) })}`
              : ""}
          </>
        )}
      </p>
      {s.links.length > 0 ? (
        <ColumnTable
          rows={s.links}
          rowKey={(l) => l.movement_id}
          cardLayout="flat"
          columns={[
            { key: "date", header: t("taxReturn.settlement.colDate"), className: "mono", cell: (l) => l.occurred_on, title: (l) => `${l.occurred_on} · ${l.account_name}` },
            { key: "account", header: t("taxReturn.settlement.colAccount"), cell: (l) => l.account_name, desktopOnly: true },
            { key: "description", header: t("taxReturn.settlement.colDescription"), cell: (l) => l.description },
            { key: "amount", header: t("taxReturn.settlement.colAmount"), headerClassName: "num", className: "num", cell: (l) => formatUsdFine(l.amount) },
          ]}
        />
      ) : null}
    </PageGridTile>
  );
}
