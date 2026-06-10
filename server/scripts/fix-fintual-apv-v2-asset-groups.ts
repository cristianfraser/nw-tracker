/**
 * Repair Fintual cert v2 APV accounts placed on the wrong leaf asset group (shared `apv` kind).
 * Run: npx tsx scripts/fix-fintual-apv-v2-asset-groups.ts
 */
import { assetGroupIdForFintualCertV2Notes } from "../src/fintualCertV2.js";
import { db } from "../src/db.js";
import { seedNavTree } from "../src/seedNavTree.js";

const notesList = [
  "import:fintual|cert|key=apv_a",
  "import:fintual|cert|key=apv_b",
] as const;

const upd = db.prepare("UPDATE accounts SET asset_group_id = ? WHERE notes = ?");

for (const notes of notesList) {
  const agId = assetGroupIdForFintualCertV2Notes(notes);
  const r = upd.run(agId, notes);
  if (r.changes !== 1) {
    throw new Error(`Expected 1 account for ${notes}, updated ${r.changes}`);
  }
  console.log(`Updated ${notes} → asset_group_id ${agId}`);
}

seedNavTree();
console.log("seedNavTree: APV sidebar links rebuilt");
