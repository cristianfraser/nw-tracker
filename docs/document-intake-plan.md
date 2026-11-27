# Bank document intake by content — plan

Branch `claude/doc-intake` (worktree `.claude/worktrees/doc-intake`).

## Problem

In October 2026 Santander renamed its monthly mails. The fetcher gates on the subject, so two
months of cartolas and a statement were skipped and nothing said so: «no matching mail» is not
an error. The subject is the only fragile link — the organizer already files a PDF by what it
prints (statement or cartola, product heading, account).

## Goal

The PDF's content decides what it is; the subject gates nothing. A document that should have
arrived and did not raises a notification, whatever the cause.

## Step A — an expected document that did not arrive (server)

- The coverage matrix already knows each column's months and their state. A month in state
  `missing` becomes **late** on a fixed day:
  - cartolas (cuenta corriente, cuenta vista): the 25th of the following month;
  - card statements: the 7th of the following month (the matrix month is the close's month;
    the mail follows the close by 2–3 days).
- Once a Chile day the server looks at every column and raises one notification per newly late
  (column, month). Notified pairs are remembered in a table, so a month notifies once.
- Only months whose late day is recent (60 days) notify: old holes in the history stay quiet.
- Off where background jobs are off, and on the demo.

## Step B — the organizer holds what is not ours (ingest)

- A readable PDF that is neither a card statement nor a cartola, and a PDF no configured password
  opens, is moved to `cfraser/inbox/held/` and reported; the run goes on. Today either aborts the
  organizer.
- Unchanged: a document recognised as a statement or a cartola that fails its own checks (totals,
  period, account) fails the run loudly; a peso cartola of an unconfigured account is an error.

## Step C — a notice that does not fail the step (ingest → contracts → server)

- A step result carries `notices` beside `problems`. The run report lists them under their step;
  a run with a notice records a **notification** even when every step passed (an hourly run with
  notices is recorded, never «quiet»).
- The organizer's held files reach the pipeline through the organize manifest and become notices.

## Step D — the fetcher takes every PDF from the bank (ingest)

- For the Santander documents source, a mail with a PDF attachment is fetched whatever its
  subject. Known subjects keep their ledger kinds (nothing is fetched twice); any other gets a
  generic kind. Subjects still name the payment-receipt mails, which have no attachment.
- The «unknown subject with a PDF fails the step once» alarm goes: those mails are now processed.

Order: A is independent. B and C before D — D is only safe once an unknown PDF no longer aborts
the organizer.

## After each step

A review agent reads the diff cold; findings are fixed. Final: every workspace's tests, the
python tests, `npm run check:conventions`.
