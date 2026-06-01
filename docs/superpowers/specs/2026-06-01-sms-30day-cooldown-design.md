# SMS Send History + 30-Day Per-Customer Cooldown

**Date:** 2026-06-01
**Status:** Approved (design)
**Scope:** `blyss-gcloud-api` (primary), `blyss-business-app` (recipient picker UI)

## Problem

The SMS bulk-marketing feature lets a business send a campaign to any list of
phone numbers. Today `POST /businesses/:businessId/sms/send` records only an
**aggregate** `sms_campaigns` document (counts + a few sampled errors). There is
no per-recipient record, so businesses can repeatedly text the same customer —
i.e. spam them — and nothing prevents it.

## Goal

1. Persist a history of every SMS sent, per recipient.
2. Enforce: a business may send a given customer **at most one** marketing SMS
   per **30 days**.
3. Enforcement is surfaced at selection time — customers in cooldown are
   **disabled / unselectable** in the recipient picker — and re-checked
   server-side so a stale client cannot bypass it.

## Decisions

- **Scope: per business.** Each business has its own 30-day window per phone. A
  customer of two businesses may receive one SMS from each. (Not platform-wide.)
- **Blocked handling: disable at selection.** In-cooldown recipients are shown
  grayed-out and cannot be selected. The server independently skips any blocked
  phone that still arrives and reports it.
- **Only successful sends lock a customer.** A failed send (provider error)
  does not start a cooldown — the customer never received the message.
- **Transactional SMS (OTP, invitations) is unaffected.** Only campaign sends
  via `/sms/send` count toward the cooldown.

## Data Model

New collection **`sms_sends`** — one document per recipient per send. This is
both the send history and the source of truth for the cooldown check.

```js
{
  business_id: string,        // owning business
  phone: string,              // recipient phone (as sent)
  name: string | null,        // customer name snapshot, if known
  campaign_id: string,        // links to the aggregate sms_campaigns doc
  template_id: string,
  sender_id: string,
  sender_type: string,        // 'business_owner' | 'employee' | ...
  success: boolean,           // only success: true starts a cooldown
  sent_at: Timestamp          // serverTimestamp
}
```

The existing **`sms_campaigns`** aggregate doc is unchanged (counts, sampled
errors), now linked to its per-recipient rows via `campaign_id`.

**Cooldown predicate:** phone `P` is in cooldown for business `B` iff there
exists an `sms_sends` doc with `business_id == B`, `phone == P`,
`success == true`, and `sent_at >= now - 30 days`.

Constant: `SMS_COOLDOWN_DAYS = 30`.

## Backend Changes (`src/routes/sms.js`)

### `GET /recipients`
After building the recipient list from `bookings`, query recent sends for the
business (`business_id == B` and `sent_at >= cutoff`), filter `success === true`
in memory, and build a `phone -> latest sent_at` map. Annotate each recipient:

- `in_cooldown: boolean`
- `cooldown_until: string | null` — ISO date = last successful `sent_at` + 30 days

### `POST /send`
1. Resolve template (unchanged: must exist, belong to business, be `confirmed`).
2. Re-check cooldown server-side: query recent successful sends → set of blocked
   phones. Split requested `phone_numbers` into **eligible** and **blocked**.
3. Send only to eligible phones (`sendWithConcurrency`, unchanged).
4. Write the aggregate `sms_campaigns` doc (unchanged shape; counts reflect
   eligible sends).
5. Batch-write one `sms_sends` doc per eligible phone with its `success` flag.
6. Response adds `skipped: Array<{ phone, cooldown_until }>` for blocked phones.
   If every phone is blocked → `200` with `sent: 0` and the full skip list.

The existing "too many failures → 502" behavior is preserved for the eligible
subset.

## Frontend Changes (`blyss-business-app`)

- `app/lib/api/sms.ts` — `Recipient` interface gains `in_cooldown: boolean` and
  `cooldown_until: string | null`; `SendResult` gains optional
  `skipped?: Array<{ phone: string; cooldown_until: string | null }>`.
- `app/components/sms/SendWizard.tsx` — in-cooldown rows render grayed-out and
  unselectable, with a small "Available {date}" label; `toggle()` and
  `toggleAll()` skip in-cooldown recipients. After a send, surface any
  server-`skipped` phones as a notice.

## Firestore Index

Add a composite index on `sms_sends` to `firestore.indexes.json`:
`business_id (ASC)` + `sent_at (ASC)`. `success` is filtered in memory to keep
the index minimal.

## Testing (`src/routes/sms.test.js`)

- `/send` writes one `sms_sends` doc per eligible recipient.
- A recently-texted customer is returned with `in_cooldown: true` and a correct
  `cooldown_until` from `/recipients`.
- `/send` skips blocked phones and reports them in `skipped`; eligible phones
  still send.
- After 30 days the customer is eligible again (`in_cooldown: false`).
- A failed send does **not** create a lockout (customer stays eligible).

## Out of Scope (YAGNI)

- Automatic cleanup / TTL of old `sms_sends` docs. History is the point;
  revisit with a cron only if storage becomes a concern.
- Configurable per-business cooldown length (fixed at 30 days for now).
