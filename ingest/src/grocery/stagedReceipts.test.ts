import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeReceiptKind, type StoreReceiptApplyDetails } from "nw-tracker-contracts";
import {
  clearDisplacedStamps,
  hasPendingGroceryReceipts,
  listStagedReceipts,
  stampIsCurrent,
  storeReceiptPayload,
  writeStamp,
  type StagingRoot,
} from "./stagedReceipts.js";

function parsed(key: string, over: Record<string, unknown> = {}) {
  return {
    boleta_number: `9${key.replace(/\D/g, "")}01`,
    caja: "0001",
    sucursal: "CALLE FICTICIA #123",
    city: "COMUNA FICTICIA - SANTIAGO",
    purchased_at: "2037-01-04 20:11:22",
    template: "store",
    items: [
      {
        position: 0,
        barcode: "7801234567890",
        description: "LECHE VITEST 1L",
        qty: "2",
        qty_unit: "un",
        unit_price_clp: 1500,
        total_clp: 3000,
        discount_clp: 500,
        discount_labels: ["RF Lleve N x $"],
      },
    ],
    receipt_discounts: [{ label: "RF CANJE PESOS MCL", amount_clp: 100 }],
    payments: [{ method: "efectivo", amount_clp: 2400 }],
    total_printed_clp: 2400,
    articles_declared: 2,
    mi_club_points: 24,
    parser_version: 4,
    ...over,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function root(kind: StagingRoot["kind"]): StagingRoot {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `vitest-receipts-${kind}-`));
  tmpDirs.push(d);
  return { kind, dir: d };
}

function stageEmail(r: StagingRoot, key: string, over: Record<string, unknown> = {}) {
  const d = path.join(r.dir, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "Boleta.pdf"), "");
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ message_id: `<${key}@vitest>`, subject: "Boleta", date: "2037-01-05T00:22:00Z", body_text: "" }));
  fs.writeFileSync(path.join(d, "parsed.json"), JSON.stringify(parsed(key, over)));
}

function stagePhoto(r: StagingRoot, key: string, meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const d = path.join(r.dir, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ source: "photo", source_key: `sha-${key}`, original_file: "receipt.heic", ...meta }));
  fs.writeFileSync(path.join(d, "parsed.json"), JSON.stringify(parsed(key, { chain: "lider", ...over })));
}

function details(over: Partial<StoreReceiptApplyDetails> = {}): StoreReceiptApplyDetails {
  return {
    chain: "lider",
    receipt_key: "lider|901|2037-01-04",
    receipt_id: 7,
    receipt_status: "inserted",
    other_document: null,
    purchased_at: "2037-01-04 20:11:22",
    purchase_date_source: "printed",
    card_paid: 0,
    items: 1,
    items_classified: 0,
    movement: { status: "not_card_paid" },
    final: true,
    ...over,
  };
}

describe("staged grocery receipts", () => {
  it("reads both roots into documents the contract accepts", () => {
    const email = root("lider_email");
    const photos = root("generic");
    stageEmail(email, "vitest-a");
    stagePhoto(photos, "vitest-p", { photo_taken_on: "2037-01-05" }, { purchased_at: null, purchase_date_source: null, boleta_number: null });
    const [a, p] = [...listStagedReceipts([email]), ...listStagedReceipts([photos])];
    expect(a).toMatchObject({ document: "email", key: "<vitest-a@vitest>", chain: "lider", photo_taken_on: null });
    expect(p).toMatchObject({ document: "photo", key: "sha-vitest-p", chain: "lider", photo_taken_on: "2037-01-05" });

    const payload = storeReceiptKind.payload.parse(storeReceiptPayload(a!, true));
    expect(payload.receipt).toMatchObject({
      chain: "lider",
      number: "901",
      purchase_date_source: "printed",
      receipt_discounts: [{ label: "RF CANJE PESOS MCL", amount: 100 }],
      payments: [{ method: "efectivo", amount: 2400 }],
      loyalty_points: 24,
    });
    expect(payload.receipt.items[0]).toMatchObject({ unit_price: 1500, total: 3000, discount: 500 });
    const undated = storeReceiptKind.payload.parse(storeReceiptPayload(p!, false));
    expect(undated).toMatchObject({ apply: false, receipt: { number: null, purchased_at: null, purchase_date_source: null } });
  });

  it("fails fast on an unknown source or a chain-less parse in the generic root", () => {
    const badSource = root("generic");
    stagePhoto(badSource, "vitest-bad-src", { source: "manual_pdf" });
    expect(() => listStagedReceipts([badSource])).toThrow(/source must be one of pdf\/photo/);
    const noChain = root("generic");
    stagePhoto(noChain, "vitest-no-chain", {}, { chain: undefined });
    expect(() => listStagedReceipts([noChain])).toThrow(/without chain/);
  });

  it("a receipt without a parse, or whose parse changed under its stamp, is pending", () => {
    const email = root("lider_email");
    const photos = root("generic");
    expect(hasPendingGroceryReceipts([email, photos])).toBe(false);
    stagePhoto(photos, "vitest-gate");
    expect(hasPendingGroceryReceipts([photos])).toBe(true);
    const [staged] = listStagedReceipts([photos]);
    writeStamp(staged!, details());
    expect(stampIsCurrent(staged!)).toBe(true);
    expect(hasPendingGroceryReceipts([photos])).toBe(false);
    stagePhoto(photos, "vitest-gate", {}, { items: [{ ...parsed("x").items[0], description: "LECHE VITEST NUEVA" }] });
    expect(hasPendingGroceryReceipts([photos])).toBe(true);
    expect(stampIsCurrent(listStagedReceipts([photos])[0]!)).toBe(false);
    const d = path.join(email.dir, "vitest-gate-mail");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "Boleta.pdf"), "");
    expect(hasPendingGroceryReceipts([email])).toBe(true);
  });

  it("a receipt taken over by a higher-ranked document clears the displaced document's stamp", () => {
    const email = root("lider_email");
    const photos = root("generic");
    stagePhoto(photos, "vitest-twin");
    stagePhoto(photos, "vitest-other");
    stageEmail(email, "vitest-twin-mail");
    const all = [...listStagedReceipts([photos]), ...listStagedReceipts([email])];
    const byDir = (dir: string) => all.find((s) => s.dir === dir)!;
    const [photo, other, mail] = [byDir("vitest-twin"), byDir("vitest-other"), byDir("vitest-twin-mail")];
    writeStamp(photo!, details({ receipt_key: "lider|1|2037-01-04" }));
    writeStamp(other!, details({ receipt_key: "lider|2|2037-01-04" }));
    writeStamp(mail!, details({ receipt_key: "lider|1|2037-01-04", receipt_status: "replaced", other_document: "photo" }));
    expect(clearDisplacedStamps(all, mail!, "lider|1|2037-01-04")).toEqual(["vitest-twin"]);
    expect(fs.existsSync(path.join(photos.dir, "vitest-twin", "imported.json"))).toBe(false);
    expect(stampIsCurrent(other!)).toBe(true);
    expect(stampIsCurrent(mail!)).toBe(true);
  });
});
