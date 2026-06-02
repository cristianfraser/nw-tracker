import { CreditCardAccountDetailPage } from "./accountDetail/CreditCardAccountDetailPage";
import { StandardAccountDetailPage } from "./accountDetail/StandardAccountDetailPage";
import { useAccountDetailPageData } from "./accountDetail/useAccountDetailPageData";

export function AccountDetailPage() {
  const data = useAccountDetailPageData();

  if (data.err) {
    return (
      <main>
        <p className="error">{data.err}</p>
      </main>
    );
  }
  if (data.summary.category_slug === "credit_card") {
    return <CreditCardAccountDetailPage data={data} />;
  }

  return <StandardAccountDetailPage data={data} />;
}
