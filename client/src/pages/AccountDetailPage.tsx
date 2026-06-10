import { CreditCardAccountDetailPage } from "./accountDetail/CreditCardAccountDetailPage";
import { StandardAccountDetailPage } from "./accountDetail/StandardAccountDetailPage";
import { useAccountDetailPageData } from "./accountDetail/useAccountDetailPageData";
import { isCreditCardAccountNavNode } from "../portfolioNavFromApi";

export function AccountDetailPage() {
  const data = useAccountDetailPageData();

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

  return <StandardAccountDetailPage data={data} />;
}
