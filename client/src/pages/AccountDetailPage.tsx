import { CreditCardAccountDetailPage } from "./accountDetail/CreditCardAccountDetailPage";
import { EquityAccountDetailPage } from "./accountDetail/EquityAccountDetailPage";
import { StandardAccountDetailPage } from "./accountDetail/StandardAccountDetailPage";
import { useAccountDetailPageData } from "./accountDetail/useAccountDetailPageData";
import {
  usePendingEquityGlanceShape,
  useRememberEquityGlanceShape,
} from "../components/account/EquityGlance";
import { isCreditCardAccountNavNode } from "../portfolioNavFromApi";

export function AccountDetailPage() {
  const data = useAccountDetailPageData();
  const accountId = data.summary.account_id;
  // A stock's page is the stock page once the bundle states its glance; before that, when this
  // session or browser has seen the account's glance (`usePendingEquityGlanceShape`), else the
  // standard frame until the bundle says.
  const pendingShape = usePendingEquityGlanceShape(data.equityGlance === undefined ? accountId : 0);
  useRememberEquityGlanceShape(accountId, data.equityGlance, data.summary.position?.brokers?.length ?? 0);

  if (data.err) {
    return (
      <main>
        <p className="error">{data.err}</p>
      </main>
    );
  }
  const isCreditCard =
    data.summary.category_slug === "credit_card" || isCreditCardAccountNavNode(data.navSelf);
  if (isCreditCard) {
    return <CreditCardAccountDetailPage data={data} />;
  }
  const isEquity = data.equityGlance != null || (data.equityGlance === undefined && pendingShape != null);
  if (isEquity) {
    return <EquityAccountDetailPage data={data} pendingShape={pendingShape} />;
  }

  return <StandardAccountDetailPage data={data} />;
}
