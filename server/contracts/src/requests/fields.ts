/** Field building blocks of the write routes' request bodies (`requests/*.ts`). */
import { z } from "zod";

/** A row id: a positive integer. */
export const rowIdSchema = z.number().int().positive();

/** A text field that must say something: trimmed, refused when empty, with `message` either way. */
export function requiredText(message: string) {
  return z.string({ error: message }).trim().min(1, message);
}

/** A text field that may be blank: trimmed (absent stays absent). */
export const trimmedText = z.string().trim();
