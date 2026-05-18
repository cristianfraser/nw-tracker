import fs from "node:fs";

/** Minimal RFC4180-style parser (quoted fields, commas). */
export function readCommaCsvRecords(filePath: string): Record<string, string>[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const table = parseCsvWithQuotes(text);
  if (table.length < 2) return [];
  const header = table[0]!.map((h) => normHeader(h));
  const out: Record<string, string>[] = [];
  for (let i = 1; i < table.length; i++) {
    const row = table[i]!;
    if (!row.some((c) => String(c).trim())) continue;
    const o: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      o[header[j]!] = row[j] ?? "";
    }
    out.push(o);
  }
  return out;
}

function normHeader(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/^\ufeff/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function parseCsvWithQuotes(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (row.length > 1 || row.some((x) => String(x).trim())) {
      rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushField();
      pushRow();
    } else if (c === "\r") {
      /* ignore — handle \r\n on \n */
    } else {
      field += c;
    }
  }
  pushField();
  if (row.length) pushRow();
  return rows;
}
