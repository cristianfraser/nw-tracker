# One shown name per row (expense, income, flows, checking statement)

**Goal.** Every row that names a bank movement or card line carries ONE server-built name, `name`. No
client consumer chooses between a pretty and a raw name. The bank's own text reaches the client only as
provenance for the ⓘ card (`name_detail`). Matching (category rules, receipt / real-estate / recurring
matchers, vendor keys) keeps reading the bank text on the server, where it reads it today. This changes
display only.

## Inventory (2026-11-20, main 17cbefcd + the checking-page work)

| DTO (contracts) | Today's name fields | Server builder | Client pick |
|---|---|---|---|
| `FlowCcExpenseLineRow` (`dto/flows.ts`) | `merchant`, `display_merchant?`, `payment_name?`, `merchant_processor?`, `refund_of.{merchant, display_merchant, payment_name}` | pipeline steps «display names» (`withExpenseDisplayNames`), «payment names» (`withExpensePaymentNames`), «refund links» (`withRefundLinks`); wire seam `toWireExpenseLine` (`wireExpenseLine.ts`) | `expenseVendorName` / `useExpenseVendorInfo` (`ExpenseVendorLabel.tsx`); `line.merchant` in `CreditCardExpenseLinesTable` (delete confirm), `ExpenseLinePiecesDialog` (title), `ManualExpenseDialog` (edit prefill) |
| `CcInstallmentPurchaseComputed` (`dto/creditCard.ts`, card plans) | `merchant`, `display_merchant?`, `merchant_processor?` | `withPurchaseExpenseLinks` (`ccPurchaseExpenseLinks.ts`) copies them from the plan's line | `CreditCardPurchaseVendor.tsx` → `expenseVendorName` |
| `FlowsApiRow` (`dto/groups.ts`) | `note`, `display_note` | `withDisplayNotes` (`flowsApi.ts`), which skips the name pipeline when the note is already plain text | `FlowsTable.tsx` (`display_note ?? note`, `noteTitle`) → `FlowRows.tsx` |
| `FlowCheckingIncomeLine`, `FlowExcludedCheckingIncomeLine`, `FlowFilteredCheckingIncomeLine`, `refund_lines` (`dto/flows.ts`) | `description` only (no pretty name at all) | `flowsCheckingInflows.ts` | `IncomeAllLinesTable`, `IncomeExcludedLinesTable`, `IncomeFilteredLinesTable`, `IncomeRefundLinesTable` (`row.description`) |
| `FlowManualIncomeLine` | `source`, `note` | `flowsCheckingInflows.ts` | income tables |
| `LatestIncomeMovement` (`dto/flows.ts`) | `description`, `display_merchant?`, `link_label?` | `latestMovements.ts` (`checkingMovementDisplayNames`) | `LatestMovementsTable.tsx` builds a fake vendor source `{merchant: description, display_merchant}` |
| `CheckingStatementVendorDto` (`dto/accounts.ts`, checking-page branch) | `merchant`, `display_merchant?`, `merchant_processor?`, `link_label?`, `transfer_counterparty?` | `checkingStatement.ts` | `CheckingStatement.tsx` → `ExpenseVendorLabel` |

Out of scope here (other DTOs that print a purchase's bank text; follow-up): real-estate link candidates
and unlinked purchases (`RealEstateAssignPurchaseModal`, `RealEstateExpenseLinkModal`,
`RealEstateExpensesPage`), financing candidates (`CreditCardFacturadoFinancingManager`), facturación
purchase list (`CreditCardFacturacionesTable`), deposits reconciliation, mortgage card matches, the import
panel's preview. Each can take `name` from the same seam later.

## Design

### The name: `ShownName` (contracts `dto/flows.ts`)

```ts
type ShownName =
  | { kind: "text"; text: string }                       // catalog / counterparty / cartola transfer / payslip / receipt payee / bank text
  | { kind: "pays_card"; card_brand: string; card_last4: string }
  | { kind: "paid_by_card"; card_brand: string; card_last4: string }
  | { kind: "paid_from_account"; account_name: string }
  | { kind: "refund_of"; purchase: ShownNameBase };     // «Reembolso de <purchase name>»
```

**The server decides which name is shown. The client only puts it into words.** The payment-name and
refund wordings stay i18n keys, because the server has no language (the language preference lives on the
client, GUIDELINES' i18n rule). So `name` is a structured value, and one client helper,
`shownNameText(name)` (`client/src/i18n/index.ts`, beside the other shared label helpers), turns it into
a string at render time. It never falls back to another field. A plain name is `{kind: "text"}`, so the
helper returns it as is.

Alternative rejected: a server-built string with a `?lang=` parameter. It would put a second i18n layer
on the server and split the cache per language, for three wordings.

### Provenance: `name_detail` (ⓘ only)

```ts
name_detail?: { bank_text: string; store_name?: string; processor?: string }
```

This is present only when the shown name is not the bank's text. `store_name` is the catalog / receipt
name when a payment name or refund wording replaced it. `processor` is the prefix the cleaner moved off
(«Mercado Pago»). Today the ⓘ card works out the same three facts by comparing `display_merchant`,
`payment_name` and `merchant`. After this change it only prints them.

### Server seams

- **Expense lines:** the pipeline keeps its internal fields (`merchant`, `display_merchant`,
  `payment_name`, `merchant_processor`, `refund_of` names). In-pipeline readers use them:
  `recurringPaymentMatch`, refund links, the plans' copy. A new pure `lineShownName(line)` in
  `expenseShownName.ts` builds `name` + `name_detail`, in this order of precedence: payment name >
  refund wording over the purchase's own name > `display_merchant` > `merchant` (> «—» for none, which
  becomes a hard error once no line lacks a merchant). `toWireExpenseLine` calls it and drops the
  internal name fields and `merchant` from the wire.
- **Card plans:** `withPurchaseExpenseLinks` copies `name` + `name_detail` from the plan's line
  (`lineShownName`), not the raw fields.
- **Flows rows:** `withDisplayNotes` becomes `withShownNames`. A bank note (an import key, or a
  mail-paired movement) goes through `checkingMovementDisplayNames`. A note the user typed is its own
  name: the catalog cleans bank text («COMPRA …» clutter), and running it over the user's words would
  rewrite them. `name: ShownName | null` (null = a movement with no note), and `name_detail` (the stored
  note) when the name differs. Either way the client reads only `name`.
  `note` stays on the row, because the flow editors (`AccountUnitsFlowForm`, `AccountBookMovementsForm`)
  edit the stored note. The display list stops reading it. The `q` filter searches `name` text + note.
- **Income lines:** each checking income line gets `name` + `name_detail` in `GET /api/income`
  (`checkingMovementShownName(description, account, counterparty)`). `description` leaves the wire:
  the tables only displayed it, and every mutation keys on `movement_id`. Manual income keeps its own
  `source` / `note` columns. They are the user's fields, not a bank pair, so they get no `name`.
- **Latest movements:** income rows carry `name` / `name_detail` / `link_label`. `display_merchant` and
  `description` leave the DTO.
- **Checking statement:** `vendor` becomes `{name, name_detail?, link_label?, transfer_counterparty?}`.
  It is built by the same helper that names the flows rows (`checkingMovementShownName`).

### Client

- `ExpenseVendorLabel` reads `source.name` through `shownNameText`. The ⓘ bank block prints
  `name_detail`. `expenseVendorName` and `expensePaymentName` are deleted. `ExpenseVendorSource` becomes
  `{name, name_detail?, …links}`.
- Every confirm / title that names a line (`CreditCardExpenseLinesTable`, `ExpenseLinePiecesDialog`,
  `CreditCardPurchaseVendor`) uses `shownNameText(line.name)`.
- `ManualExpenseDialog` prefills from a structured `manual_description` on manual lines. It is the
  form's own stored value, not a display name.
- The line-pieces response (`ExpenseLinePiecesDto`) drops `merchant`. The dialog titles with the
  line's `name`.
- `FlowsTable` / `FlowRows`: the row's text = `shownNameText(row.name)`, its title = `name_detail`'s bank
  text.
- Income tables and `LatestMovementsTable`: `shownNameText(row.name)`.

### Rules file

`.claude/rules/expenses.md` «What an expense row shows» is restated: the wire carries `name` +
`name_detail`. `display_merchant` / `payment_name` are server pipeline fields, and the client words
`ShownName` via `shownNameText`.

## Coordination

- The checking-page work (statement DTO, `checkingTransferParty`, the `accountFlowRows` split) landed
  as 8203d237; this branch is rebased on it and `CheckingStatementVendorDto` carries `name` /
  `name_detail` (`checkingMovementShownName`).
- expenses-page-redesign is at mockups (no code changes). This change touches `ExpenseVendorLabel`,
  `CreditCardExpenseLinesTable` and the dialogs. The redesign should build on `name` / `shownNameText`.

## Steps

1. Contracts: `ShownName`, `name_detail`, the new fields on each DTO; remove `display_merchant` /
   `display_note` / `payment_name` / `merchant_processor` from the wire types.
2. Server: `expenseShownName.ts` + the wire seam; plans; flows rows; income; latest movements; checking
   statement. Tests: `lineShownName` precedence, flows rows named through the catalog even for a plain
   note, income line names.
3. Client: `shownNameText`, the components above; drop the pickers.
4. `cd server && npm run test`, `cd client && npm run test`, `npm run check:conventions`; restate the
   rules section.
