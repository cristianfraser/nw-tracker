import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestGroceryReceiptInbox, listGroceryReceiptInboxFiles, photoTakenOnFromName } from "./inbox.js";

describe("grocery receipt inbox", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function dirs() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-receipt-inbox-"));
    tmpDirs.push(base);
    const inboxDir = path.join(base, "inbox");
    fs.mkdirSync(inboxDir);
    return { inboxDir, stagedDir: path.join(base, "staged"), duplicatesDir: path.join(base, "duplicates") };
  }

  it("stages each supported inbox file under a sha-keyed dir with provenance meta", () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.inboxDir, "IMG_0001.HEIC"), "photo-bytes-a");
    fs.writeFileSync(path.join(d.inboxDir, "scan.pdf"), "pdf-bytes-b");
    fs.writeFileSync(path.join(d.inboxDir, ".DS_Store"), "");
    const res = ingestGroceryReceiptInbox({ ...d, now: new Date("2037-01-05T12:00:00Z") });
    expect(res.map((r) => r.status)).toEqual(["staged", "staged"]);
    const heic = res[0] as Extract<(typeof res)[number], { status: "staged" }>;
    expect(heic.source).toBe("photo");
    expect(heic.dir).toMatch(/^\d{4}-\d{2}-\d{2}-photo-[0-9a-f]{12}$/);
    const meta = JSON.parse(fs.readFileSync(path.join(d.stagedDir, heic.dir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ source: "photo", original_file: "receipt.heic", original_name: "IMG_0001.HEIC", ingested_at: "2037-01-05T12:00:00.000Z" });
    expect(meta.source_key).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(d.stagedDir, heic.dir, "receipt.heic"), "utf8")).toBe("photo-bytes-a");
    const pdf = res[1] as Extract<(typeof res)[number], { status: "staged" }>;
    expect(pdf.source).toBe("pdf");
    expect(pdf.dir).toMatch(/-pdf-/);
    expect(listGroceryReceiptInboxFiles(d.inboxDir)).toEqual([]);
  });

  it("parks an exact duplicate of an already-staged document", () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.inboxDir, "first.jpg"), "same-bytes");
    const first = ingestGroceryReceiptInbox(d)[0] as { status: "staged"; dir: string };
    fs.writeFileSync(path.join(d.inboxDir, "copy.jpg"), "same-bytes");
    const res = ingestGroceryReceiptInbox(d);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: "duplicate", of: first.dir });
    expect(fs.existsSync((res[0] as { parked: string }).parked)).toBe(true);
    expect(listGroceryReceiptInboxFiles(d.inboxDir)).toEqual([]);
    expect(fs.readdirSync(d.stagedDir)).toHaveLength(1);
  });

  it("refuses the whole batch on an unsupported file, moving nothing", () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.inboxDir, "good.jpg"), "bytes");
    fs.writeFileSync(path.join(d.inboxDir, "notes.txt"), "not a receipt");
    expect(() => ingestGroceryReceiptInbox(d)).toThrow(/unsupported file\(s\) notes.txt/);
    expect(listGroceryReceiptInboxFiles(d.inboxDir)).toEqual(["good.jpg", "notes.txt"]);
    expect(fs.existsSync(d.stagedDir)).toBe(false);
  });

  it("dry run reports without moving", () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.inboxDir, "a.png"), "bytes");
    const res = ingestGroceryReceiptInbox({ ...d, dryRun: true });
    expect(res[0]!.status).toBe("staged");
    expect(listGroceryReceiptInboxFiles(d.inboxDir)).toEqual(["a.png"]);
    expect(fs.existsSync(d.stagedDir)).toBe(false);
  });

  it("reads the photo date only from a YYYY:MM:DD name", () => {
    expect(photoTakenOnFromName("2019:07:21.jpeg")).toBe("2019-07-21");
    expect(photoTakenOnFromName("IMG_1862.HEIC")).toBeNull();
    expect(photoTakenOnFromName("2019-07-21.jpeg")).toBeNull();
    expect(() => photoTakenOnFromName("2019:02:30.jpeg")).toThrow();
  });
});
