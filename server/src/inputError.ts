import type express from "express";

/**
 * A request the user can fix (a bad date, an unknown category, a line that is not a bucket line):
 * a write route answers it 400 with its message. Anything else a write throws is an integrity
 * failure and reaches the terminal JSON 500 middleware (docs/untangle-plan.md bug 15).
 */
export class InputError extends Error {}

/**
 * A write route: `InputError` → 400 `{ error }`, every other throw (or rejection) → `next(err)`,
 * the 500 middleware. Replaces the catch-all `try { … } catch { 400 }` that turned integrity throws
 * into input errors.
 */
export const writeHandler =
  (fn: (req: express.Request, res: express.Response) => void | Promise<void>): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => {
        if (err instanceof InputError && !res.headersSent) {
          res.status(400).json({ error: err.message });
          return;
        }
        next(err);
      });
  };
