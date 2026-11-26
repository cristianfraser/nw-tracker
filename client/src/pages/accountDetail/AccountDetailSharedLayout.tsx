import type { ReactNode } from "react";
import { PageTitleRow } from "../../components/layout/PageTitleRow";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { loadableClass } from "../../components/ui/Loadable";
import styles from "../AccountDetailPage.module.css";

type LayoutProps = {
  title: string;
  children: ReactNode;
  /** Rendered right-aligned at the bottom of the page (e.g. Export button). */
  toolbar?: ReactNode;
  /** The page data is not in (or is held prior-unit data): the body dims. */
  loading?: boolean;
  /** A title block of the page's own in place of the plain title (the stock page's title line). */
  titleRow?: ReactNode;
  /** A summary block of the page's own above the sections (the credit card's glance); null = none. */
  strip: ReactNode;
};

export function AccountDetailSharedLayout({ title, children, toolbar, loading = false, titleRow, strip }: LayoutProps) {
  // The page sits on the column grid (styles/page-grid.css): <main> and the content shell are
  // page grids, every section below is a tile with its heading inside, and the row gap is the
  // only space between them.
  return (
    <main>
      {titleRow ?? <PageTitleRow title={title} />}
      <div className={loadableClass(loading, styles.contentShell, "page-grid")}>
        {strip != null ? <PageGridTile id="strip">{strip}</PageGridTile> : null}
        {children}
        {toolbar ? (
          <PageGridTile id="export" className="page-tile--end">
            {toolbar}
          </PageGridTile>
        ) : null}
      </div>
    </main>
  );
}
