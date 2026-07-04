/** Binary download through fetch (same-origin auth applies); errors surface as JSON `error`. */
export async function downloadFile(path: string): Promise<void> {
  const base = import.meta.env.VITE_API_URL ?? "";
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // non-JSON error body; keep raw text
    }
    throw new Error(message);
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "export.xlsx";
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
