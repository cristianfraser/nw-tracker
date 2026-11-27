import type express from "express";

/**
 * What a request got wrong: its content (400), the row it names (404), the state that row is in
 * (409), the size of what it asks for (413).
 */
export type InputErrorStatus = 400 | 404 | 409 | 413;

/**
 * A request the user can fix (a bad date, an unknown category, a line that is not a bucket line):
 * a write route answers it with its message and its status (400 unless the thrower says the row
 * does not exist, 404, or is already there / no longer in that state, 409). Anything else a write
 * throws is an integrity failure and reaches the terminal JSON 500 middleware
 * (docs/untangle-plan.md bug 15).
 */
export class InputError extends Error {
  readonly status: InputErrorStatus;
  constructor(message: string, status: InputErrorStatus = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * A write route: `InputError` → its status `{ error }`, every other throw (or rejection) → `next(err)`,
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
          res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      });
  };
