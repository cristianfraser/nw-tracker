import { creditCardBillingDetailInactive } from "./src/ccBillingInactive.js";
import { isNavRetiredCcMaster } from "./src/ccNavRetired.js";
import { isSupersededSantanderCcMaster } from "./src/ccConsolidatedCards.js";
import { accountChartInactive } from "./src/accountChartInactive.js";
import { db } from "./src/db.js";
const ids = (db.prepare("select account_id from credit_card_account_config order by 1").all() as {account_id:number}[]).map(r=>r.account_id);
for (const id of ids) console.log(JSON.stringify({id, billingInactive: creditCardBillingDetailInactive(id), navRetired: isNavRetiredCcMaster(id), superseded: isSupersededSantanderCcMaster(id), chartInactive: accountChartInactive(id)}));
