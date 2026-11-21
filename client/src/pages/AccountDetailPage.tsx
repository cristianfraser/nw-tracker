import { CheckingAccountDetailPage } from "./accountDetail/CheckingAccountDetailPage";
import { CreditCardAccountDetailPage } from "./accountDetail/CreditCardAccountDetailPage";
import { PositionAccountDetailPage } from "./accountDetail/PositionAccountDetailPage";
import { StandardAccountDetailPage } from "./accountDetail/StandardAccountDetailPage";
import { useAccountDetailPageData } from "./accountDetail/useAccountDetailPageData";
import {
  usePendingPositionGlanceShape,
  useRememberPositionGlanceShape,
} from "../components/account/PositionGlance";
import { isCreditCardAccountNavNode } from "../portfolioNavFromApi";

/** The account kinds whose page is the checking page (server `CHECKING_PAGE_KIND_SLUGS`). */
const CHECKING_PAGE_CATEGORY_SLUGS: ReadonlySet<string> = new Set(["cuenta_corriente", "cuenta_vista"]);

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
  // A cuenta corriente / cuenta vista: its category is known from the placeholder, so the page mounts at first paint.
  if (CHECKING_PAGE_CATEGORY_SLUGS.has(data.summary.category_slug ?? "")) {
    return <CheckingAccountDetailPage data={data} />;
  }
  const isPosition = data.positionGlance != null || (data.positionGlance === undefined && pendingShape != null);
  if (isPosition) {
    return <PositionAccountDetailPage data={data} pendingShape={pendingShape} />;
  }

  return <StandardAccountDetailPage data={data} />;
}
