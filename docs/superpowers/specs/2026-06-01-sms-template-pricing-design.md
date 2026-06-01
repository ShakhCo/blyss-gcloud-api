# SMS Template Type & Price + Balance-Gated Sending

**Date:** 2026-06-01
**Status:** Approved (design)
**Scope:** `blyss-gcloud-api` (template fields, send gate + deduction, smsContext) and `blyss-business-app` (display type/price, gate send on balance, reflect charge).

## Problem

SMS templates have no notion of category or cost. We want each template to carry
a `type` (service vs ads) and a `price_per_sms`, set by the admin in Firestore.
Sending a campaign should cost the business owner `price_per_sms` per message and
require sufficient balance.

## Goal

1. `sms_templates` gain `type` (`service`|`ads`) and `price_per_sms` (number),
   set by admin in Firestore — visible to the business only after the template
   is `confirmed`.
2. The business owner needs enough balance to send: `balance ≥ price_per_sms ×
   recipients`. Example: ads template at 500 UZS/SMS, 10 customers → need ≥ 5000.
3. On send, the cost of **actually-sent** messages is deducted from the owner's
   balance.

## Decisions

- **Admin-set, no endpoint:** `type`, `price_per_sms`, and `status` (confirm) are
  edited directly in Firestore. No admin API/UI in this work.
- **Visibility:** `GET /templates` returns `type`/`price_per_sms` only when
  `status === 'confirmed'` (null otherwise).
- **Deduct on send:** balance decreases by the cost of successfully-sent messages.
- **Charge basis — actually-sent only:** cooldown-skipped and failed sends are
  never charged. The frontend gates the button on the selected count; the backend
  enforces against the eligible (post-cooldown) count and charges successes.
- **Balance owner:** the charge always hits the **business owner's** balance
  (`business_owners` doc), even when an employee sends. `price_per_sms` null/absent
  → treated as `0` (free; no gate, no deduction).

## Data Model

`sms_templates` — two new fields:

```js
type: 'service' | 'ads' | null,   // null until admin sets it
price_per_sms: number | null,     // UZS; null/absent => 0 (free)
```

Written as `type: null, price_per_sms: null` at creation (`POST /templates`).
Admin sets real values + flips `status` to `confirmed` in Firestore.

## Backend Changes (`blyss-gcloud-api`)

### `src/utils/smsContext.js`
`resolveSmsContext` additionally returns `business_owner_id`
(`businessData.business_owner_id`) so `/send` can read and charge the owner's
balance regardless of whether a business owner or employee is sending.

### `src/routes/sms.js`

**`POST /templates`** — add `type: null, price_per_sms: null` to the created doc.

**`GET /templates`** — in the response mapping, include `type` and
`price_per_sms` ONLY when `status === 'confirmed'`; otherwise both `null`.

**`POST /send`** — after the existing template checks and the cooldown split into
`eligible`/`skipped`:
1. `price = tpl.price_per_sms ?? 0`.
2. If `price > 0`:
   - Read the owner doc `business_owners/{business_owner_id}` → `balance ?? 0`.
   - Require `balance ≥ price × eligible.length`; else respond `402` with
     `{ error_code: 'INSUFFICIENT_BALANCE', required, balance }` — nothing sent.
3. Send to `eligible` (unchanged), write `sms_sends` history (unchanged).
4. `charged = price × success_count`. If `charged > 0`, deduct via
   `db.collection('business_owners').doc(business_owner_id).update({ balance: FieldValue.increment(-charged) })`.
5. Campaign doc gains `price_per_sms: price` and `charged`. Response gains
   `charged` (alongside existing `campaign_id/sent/failed/errors/skipped`).

`charged ≤ price × eligible.length ≤ balance`, so the balance never goes negative.

### `src/schemas/sms.js`
Add a `templateTypeEnum = z.enum(['service','ads'])`. The send response is plain
JSON (no schema parse), so add `charged` there directly; the template GET mapping
stays manual with `type`/`price_per_sms` added (gated by status).

## Frontend Changes (`blyss-business-app`)

- `app/lib/api/sms.ts` — `SmsTemplate` gains `type?: 'service'|'ads'|null` and
  `price_per_sms?: number|null`; `SendResult` gains `charged?: number`.
- `app/components/sms/TemplatesList.tsx` — on confirmed templates show the type
  label and price per SMS in the detail view.
- `app/components/sms/SendWizard.tsx`:
  - Template picker rows show the type label + `price_per_sms`.
  - Owner balance from `useUserStore(s => s.user?.balance)`. With a template
    picked: `cost = (price_per_sms ?? 0) × selected.size`. Show a cost preview;
    if `balance < cost`, disable the send button and show an "insufficient
    balance" message. Free templates (price 0) impose no gate.
  - On success, decrement the store balance by `data.charged ?? 0` (so the
    profile balance card updates) and surface the charged amount.
- `app/lib/i18n/translations.ts` (uz + ru): `sms.templates.type.service` =
  "Service turdagi" / "Сервисного типа"; `sms.templates.type.ads` = "Reklama
  turdagi" / "Рекламного типа"; plus keys for price-per-SMS label, cost preview,
  and insufficient-balance message.

## Out of Scope (YAGNI)

- Admin UI/endpoint for setting type/price/confirming (done in Firestore).
- Top-up / payment flow (admin credits balance in Firestore).
- Fully transactional check-then-deduct. Known limitation: two simultaneous
  campaigns could race the balance check. Acceptable at single-operator volume;
  revisit with a transactional reserve if it becomes a problem.

## Testing

- **Backend** (`src/routes/sms.test.js`):
  - `GET /templates` exposes `type`/`price_per_sms` for confirmed, nulls them for
    pending.
  - `POST /send` with a priced template and sufficient owner balance: sends,
    deducts `price × successful`, response `charged` correct, owner doc
    `update` called with `increment(-charged)`.
  - `POST /send` with insufficient balance → `402 INSUFFICIENT_BALANCE`, no send,
    no deduction.
  - Free template (price 0/null) → no balance read, no deduction.
  - Charge excludes cooldown-skipped and failed sends.
- **Frontend:** `npm run typecheck` + `npm run lint` clean (no component runner).
