import { CreditCardAccountDetailPage } from "./accountDetail/CreditCardAccountDetailPage";
import { PositionAccountDetailPage } from "./accountDetail/PositionAccountDetailPage";
import { StandardAccountDetailPage } from "./accountDetail/StandardAccountDetailPage";
import { useAccountDetailPageData } from "./accountDetail/useAccountDetailPageData";
import {
  usePendingPositionGlanceShape,
  useRememberPositionGlanceShape,
} from "../components/account/PositionGlance";
import { isCreditCardAccountNavNode } from "../portfolioNavFromApi";

export function AccountDetailPage() {
  const data = useAccountDetailPageData();
  const accountId = data.summary.account_id;
  // A unit position's page (a stock, coin or fund) is the unit-position page once the bundle
  // states its glance; before that, when this session or browser has seen the account's glance
  // (`usePendingPositionGlanceShape`), else the standard frame until the bundle says.
  const pendingShape = usePendingPositionGlanceShape(data.positionGlance === undefined ? accountId : 0);
  useRememberPositionGlanceShape(accountId, data.positionGlance, data.summary.position?.brokers?.length ?? 0);

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
  const isPosition = data.positionGlance != null || (data.positionGlance === undefined && pendingShape != null);
  if (isPosition) {
    return <PositionAccountDetailPage data={data} pendingShape={pendingShape} />;
  }

  return <StandardAccountDetailPage data={data} />;
}
