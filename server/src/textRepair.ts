/**
 * UTF-8 text that was decoded as Latin-1 somewhere upstream («SebastiÃ¡n» for «Sebastián»):
 * re-encoded back when, and only when, the result is clean UTF-8. Text without the telltale
 * «Ã»/«Â» + continuation-byte pairs is returned untouched.
 */
export function repairMojibake(text: string): string;
export function repairMojibake(text: string | null): string | null;
export function repairMojibake(text: string | null): string | null {
  if (text == null || !/[ÃÂ][\u0080-¿]/.test(text)) return text;
  if (/[^\u0000-ÿ]/.test(text)) return text;
  const fixed = Buffer.from(text, "latin1").toString("utf8");
  return fixed.includes("�") ? text : fixed;
}
