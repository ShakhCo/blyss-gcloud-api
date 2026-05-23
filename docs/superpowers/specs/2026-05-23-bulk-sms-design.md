# Bulk SMS Campaigns — Design

**Date:** 2026-05-23
**Status:** Approved
**Scope:** Let business owners and employees create AI-polished SMS templates, get them moderated through Eskiz, and send identical text to up to 100 customers from their own bookings.

## Goal

Ship a minimal bulk-SMS feature fast. Creators draft an example message; OpenAI polishes it into an Eskiz-compatible template; the operator (Shahzod) manually registers it with Eskiz, then flips a Firestore status to `confirmed`; the creator can then send that template to recipients picked from the business's booking history. A campaign log records every send for audit.

## Constraints driving the design

- **Eskiz moderation is mandatory.** Eskiz only delivers SMS whose text matches a template they have pre-approved (usually 1–2 business days). AI output cannot be sent until that human-in-the-loop step has happened.
- **Push to production fast.** No admin moderation UI, no retry queue, no scheduling, no per-recipient delivery tracking beyond the failure list.
- **No customer personalization.** Identical text to all recipients in a campaign — eliminates an entire class of Eskiz-template-registration complexity.

## Out of scope

- Admin moderation UI (operator uses Firestore console directly)
- Per-recipient delivery tracking (only aggregate `sent`/`failed` counts)
- Retry queue for failed sends
- Campaign scheduling (send-now only)
- Template editing (delete + recreate instead)
- SMS spend dashboard (Eskiz dashboard owns that)
- Opt-out / STOP keyword handling (Eskiz handles legally-mandated parts)
- AI variant generation, bilingual rewrites, or content classification (polish only)

## Actors

- **Creator** — `business_owner` OR `employee`. Each creator owns their own templates; an employee moving to another business does not carry templates with them.
- **Operator** — Shahzod. Bridges between Eskiz dashboard and Firestore. Receives Telegram pings when new templates arrive.
- **Recipient** — any phone number that appears on a `bookings` document for the creator's business. Never sees BLYSS UI; just receives the SMS.

## Data model

Two new Firestore collections.

### `sms_templates`

```
{
  business_id: string,             // tenant scope
  creator_id: string,              // user.id OR employee.id
  creator_type: 'business_owner' | 'employee',
  example_text: string,            // raw user input, 1..500 chars
  polished_text: string,           // AI output; the literal string Eskiz moderates
  status: 'pending_moderation' | 'confirmed' | 'rejected',
  rejection_reason: string | null, // operator's note, surfaced in UI
  created_at: Timestamp,
  moderated_at: Timestamp | null,
}
```

Composite index: `(business_id ASC, creator_id ASC, creator_type ASC, created_at DESC)` for the "my templates" list query.

### `sms_campaigns`

```
{
  business_id: string,
  sender_id: string,
  sender_type: 'business_owner' | 'employee',
  template_id: string,
  message_snapshot: string,        // copy of polished_text at send-time
  recipient_count: number,
  success_count: number,
  failure_count: number,
  errors: [{ phone: string, error: string }],   // truncated to first 20 to keep doc size bounded
  sent_at: Timestamp,
}
```

`message_snapshot` is stored because templates can be deleted; the audit log must survive.

Composite index: `(business_id ASC, sent_at DESC)`.

## Backend — `blyss-gcloud-api`

New route file `src/routes/sms.js`, mounted in `src/routes/index.js` under the standard JWT + HMAC authenticated tier (alongside `bookings`, `employees`, etc.). Validation schemas in `src/schemas/sms.js` using Zod.

The authenticate middleware exposes either `req.user` (business owner) or `req.employee`. The route resolves `creator_id` and `creator_type` from whichever is present, and uses `business_id` from the same source.

### Endpoints

#### `POST /sms/templates`

Create a new template from a raw example.

- Body: `{ example_text: string (1..500) }`
- Calls OpenAI (`gpt-4o-mini`, temperature 0.3, max 150 output tokens) with the system prompt below
- Backend re-validates the model output (length ≤160, no URLs, no foreign phone numbers, no emojis). On violation, return `400 { error_code: 'AI_OUTPUT_INVALID', error: <rule> }`. No Firestore write.
- On success, writes `sms_templates` doc with `status: 'pending_moderation'`
- Side effect: `sendTelegramMessage(OPERATOR_TG_ID, "New SMS template from {creator_name} @ {business_name}: ...")` — fire-and-forget, errors logged but do not fail the request
- Returns the full doc (`201`)

#### `GET /sms/templates`

List the caller's own templates.

- Optional query: `?status=confirmed|pending_moderation|rejected`
- Returns templates where `business_id === caller.business_id AND creator_id === caller.id AND creator_type === caller.type`
- Ordered by `created_at DESC`

#### `DELETE /sms/templates/:id`

Hard delete. Only the creator can delete their own template. Campaigns retain `message_snapshot`, so the audit trail survives.

- Returns `204` on success, `403` if not creator, `404` if not found

#### `GET /sms/recipients`

Distinct recipient list for the caller's business.

- Reads `bookings` where `business_id === caller.business_id`
- Returns `[{ phone_number, name, last_visit_at, visit_count }]`, dedup'd on `phone_number`, sorted by `last_visit_at DESC`
- Capped at the 500 most-recent customers
- Done in-memory after a single Firestore query (Firestore has no `DISTINCT`); this is acceptable at expected booking volumes per business

#### `POST /sms/send`

Send a campaign.

- Body: `{ template_id: string, phone_numbers: string[] (1..100) }`
- Loads template; rejects with `403` if template's `business_id` ≠ caller's or `status` ≠ `'confirmed'`
- Loops `sendSms(phone, polished_text)` with concurrency 5 using a simple semaphore (no new dependency)
- Collects results; writes one `sms_campaigns` doc
- If `failure_count > recipient_count / 2`, returns `502` with the campaign body so the frontend can show an error toast; otherwise returns `200`
- Response: `{ campaign_id, sent: number, failed: number, errors: [{phone, error}] }` (errors truncated to first 20)

#### `GET /sms/campaigns`

List recent campaigns for the caller's whole business (not just the caller). Owners need to see what employees sent.

- Optional pagination: `?cursor=<sent_at>&limit=20`
- Ordered by `sent_at DESC`

### OpenAI prompt

Single-shot completion. No streaming, no function calling.

```
System:
You polish SMS marketing messages for Uzbek barbershops and salons sending
via the Eskiz SMS gateway. Output ONE message body, plain text,
≤160 characters, no emojis, no URLs, no phone numbers other than the
business's own, no all-caps shouting. Preserve the user's language
(Uzbek/Russian/mixed) and intent. Append `BLYSS` on its own line at the
end if not already present. Return only the polished message, no preamble.

User:
{example_text}
```

Re-validate the response server-side against the same rules. The model usually obeys, but treating its output as untrusted means a hallucinated URL never reaches a customer.

## Frontend — `blyss-business-app`

One new route `/sms` under the authenticated layout. Uses existing antd-mobile, `@tanstack/react-query`, and the project's standard fetch helpers.

### Pages

**`/sms/templates`** — list of caller's templates
- Filter chips: All / Pending / Confirmed / Rejected
- Each row: polished text (or example if not polished yet), status badge, created date, delete button
- Floating "+ New template" button → modal with textarea, character counter, submit
- After submit, the modal shows the polished result and the message "Sent for moderation — you'll be able to send it once Shahzod approves it (usually 1–2 business days)."

**`/sms/send`** — three-step wizard
1. Pick a confirmed template (radio list; if none, show CTA back to Templates)
2. Pick recipients — searchable list of distinct customers, multiselect with running count, "Select all (capped at 100)" affordance
3. Confirm — shows message preview + recipient count → "Send" → progress spinner → result toast `Sent 87 / Failed 3`. If any failures, link to the campaign doc for the error breakdown.

**`/sms/history`** — campaign log
- Table: date, sender name, message snapshot (truncated, expandable), `sent/failed`
- Visible to entire business; sortable by date

### Navigation

Add an "SMS" entry to the existing sidebar/nav, gated to authenticated users (both business_owner and employee roles).

## Operator workflow

The operator (Shahzod) is the bridge between Eskiz and Firestore. No code path automates this — it is intentionally manual.

1. Telegram bot pings the operator: `"New SMS template from {creator} @ {business}: \n\n{polished_text}\n\nTemplate ID: {id}"`
2. Operator opens Eskiz dashboard at `notify.eskiz.uz`, registers `polished_text` as a new template under the BLYSS account
3. Operator waits for Eskiz approval (1–2 business days)
4. On Eskiz approval, operator opens Firestore console → `sms_templates/{id}` → set `status: 'confirmed'`, `moderated_at: <now>`. Template becomes sendable immediately.
5. On Eskiz rejection, operator sets `status: 'rejected'`, `rejection_reason: '<short note>'`. Creator sees it in UI and can delete + recreate.

The Telegram ping uses `OPERATOR_TG_ID` (new env var) and the existing `sendTelegramMessage` helper.

## Error handling

| Failure | Behavior |
|---|---|
| OpenAI 5xx / timeout | `503 { error_code: 'AI_UNAVAILABLE' }`, no Firestore write |
| AI output violates rules | `400 { error_code: 'AI_OUTPUT_INVALID', error: <rule> }`, no write |
| Eskiz send fails for one recipient | Recorded in `errors[]`, campaign continues |
| Eskiz fails for >50% recipients | Campaign doc still written; response is `502` so UI toasts as error |
| Sending an un-`confirmed` template | `403 { error_code: 'TEMPLATE_NOT_APPROVED' }` |
| Trying to send another business's template | `403 { error_code: 'FORBIDDEN' }` |
| Telegram ping failure | Logged, request still succeeds — operator notification is best-effort |

## Testing

Vitest (matches `blyss-gcloud-api`'s existing test setup; see `auth.revocation.test.js`, `instagram-webhook.test.js`).

Minimum coverage:
- Schema validation for both `POST /sms/templates` (length bounds) and `POST /sms/send` (1..100 phones, valid `template_id`)
- AI output re-validation: a stubbed model response containing a URL must produce `400`
- Send-flow: a stubbed `sendSms` returning mixed success/failure produces correct aggregate counts and writes one `sms_campaigns` doc
- Authorization: caller from a different business cannot read/delete another creator's template; cannot send another business's template
- Template status guard: `pending_moderation` and `rejected` templates cannot be sent

Frontend tests are out of scope for this spec.

## New environment variables

- `OPERATOR_TG_ID` — Telegram chat ID for moderation pings
- `OPENAI_API_KEY` — already present (used by `src/routes/ai.js`); reuse the existing client

## Files to add or modify

**Add:**
- `blyss-gcloud-api/src/routes/sms.js`
- `blyss-gcloud-api/src/schemas/sms.js`
- `blyss-gcloud-api/src/utils/aiPolish.js` (OpenAI call + server-side rule revalidation)
- `blyss-gcloud-api/src/routes/sms.test.js`
- `blyss-business-app/app/routes/sms.tsx` (or wherever new authenticated routes go in this React Router v7 layout)
- `blyss-business-app/app/components/sms/*` for the wizard, templates list, history view

**Modify:**
- `blyss-gcloud-api/src/routes/index.js` — mount `sms` router
- `blyss-gcloud-api/firestore.indexes.json` — add the two composite indexes
- `blyss-business-app` sidebar/nav config — add "SMS" entry

## Success criteria

- A business owner can create an example message, see it polished, and find it in a pending state
- The operator gets a Telegram ping and can flip the status in Firestore console
- After approval, the creator can pick recipients from their bookings and send to up to 100 phones in one call
- A campaign row exists for every send, even partial-failure ones, viewable by the whole business
- Eskiz never receives un-moderated template text
