# Third-Party SMS Endpoint — Design

**Date:** 2026-04-20
**Status:** Approved
**Scope:** Add a public, unauthenticated SMS-send endpoint for a single external caller (InformTech.uz), gated by a content marker in the SMS body.

## Goal

Expose a single endpoint that external callers can hit without any auth to send an SMS via the existing Eskiz integration. Access control is performed by checking the SMS body for the literal marker `InformTech.uz`.

## Endpoint

`POST /third-party/sms-services/send-sms`

- No HMAC signature required.
- No JWT required.
- No rate limiter (can be added later if abuse appears).

Mounted in `src/routes/index.js` alongside the other no-auth routers (next to `/public`, before the `verifySignature` block).

## Request

```json
{
  "phone_number": "998901234567",
  "message": "Your code is 12345. InformTech.uz"
}
```

### Validation rules (Zod)

Defined in a new file `src/schemas/thirdPartySms.js`:

- `phone_number`: string, regex `^998\d{9}$` — exactly 12 characters, all digits, must start with `998`. Matches the existing `sendOtpSchema` convention in `src/schemas/otp.js`.
- `message`: non-empty string, max length 1000 characters.

Validation is applied via the existing `validate` middleware (`src/middleware/validate.js`), which produces `400 { validation_errors, error_code: "VALIDATION_ERROR" }` on failure.

## Control flow

1. Zod validation (via `validate` middleware). Fail → `400 VALIDATION_ERROR`.
2. Marker check: `message.includes('InformTech.uz')` — **case-sensitive exact match**. Fail → `403 { error: "SMS body must contain the required marker", error_code: "FORBIDDEN_CONTENT" }`.
3. Call `sendSms(phone_number, message)` from `src/utils/eskiz.js`.
4. On `{ success: true }` → `200 { success: true }`.
5. On `{ success: false, error }` → `502 { error, error_code: "SMS_PROVIDER_ERROR" }`.
6. On thrown/unexpected error → `500 { error: "Internal server error", error_code: "INTERNAL_ERROR" }`.

## Response shapes

| Status | Body |
|--------|------|
| 200 | `{ "success": true }` |
| 400 | `{ "validation_errors": [...], "error_code": "VALIDATION_ERROR" }` |
| 403 | `{ "error": "SMS body must contain the required marker", "error_code": "FORBIDDEN_CONTENT" }` |
| 502 | `{ "error": "<eskiz error>", "error_code": "SMS_PROVIDER_ERROR" }` |
| 500 | `{ "error": "Internal server error", "error_code": "INTERNAL_ERROR" }` |

## File changes

- **NEW** `src/routes/thirdPartySms.js` — Express router with the single `POST /send-sms` handler.
- **NEW** `src/schemas/thirdPartySms.js` — Zod schema for the request body.
- **MODIFIED** `src/routes/index.js` — import the new router and mount it at `/third-party/sms-services` in the no-auth section.

## Non-goals (YAGNI)

- No rate limiting.
- No auth token / IP allowlist / caller identification beyond the `InformTech.uz` marker.
- No persistence or audit log of SMS messages sent through this endpoint.
- No automatic retries on Eskiz failure — the caller decides what to do.
- No internationalisation of error messages.

## Security notes

The `InformTech.uz` marker is a weak gate — it's visible in any SMS message this endpoint sends, so anyone who captures one message can call the endpoint. This is acceptable because:

- The marker is also sent in the message body to the end user, so the caller has a legitimate reason to know it.
- This endpoint is intended for one known partner (InformTech.uz) and the worst-case abuse is sending SMS that already contains the `InformTech.uz` brand — not ideal, but contained.
- If abuse occurs, the mitigation path is adding rate limiting or a shared secret header — both non-breaking changes.
