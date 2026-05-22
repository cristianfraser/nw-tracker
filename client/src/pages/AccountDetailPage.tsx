import { CreditCardAccountDetailPage } from "./accountDetail/CreditCardAccountDetailPage";
import { StandardAccountDetailPage } from "./accountDetail/StandardAccountDetailPage";
import {
  useAccountDetailPageData,
  type AccountDetailPageData,
} from "./accountDetail/useAccountDetailPageData";

export function AccountDetailPage() {
  const loaded = useAccountDetailPageData();

  if ("detailPending" in loaded && loaded.detailPending) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if ("err" in loaded && loaded.err) {
    return (
      <main>
        <p className="error">{loaded.err}</p>
      </main>
    );
  }

  if ("loading" in loaded && loaded.loading) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const data = loaded as AccountDetailPageData;
  if (data.summary.category_slug === "credit_card") {
    return <CreditCardAccountDetailPage data={data} />;
  }

  return <StandardAccountDetailPage data={data} />;
}
