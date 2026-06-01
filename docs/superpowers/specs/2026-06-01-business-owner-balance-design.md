# Business Owner `balance` Field

**Date:** 2026-06-01
**Status:** Approved (design)
**Scope:** `blyss-gcloud-api` (storage, profile response, schema, backfill), `blyss-business-app` (profile display)

## Problem

Business owner accounts have no notion of a balance. We want each business owner
to carry a numeric `balance`, defaulting to `0`, and to show it on the profile
page.

## Goal

1. Every `business_owners` document has a `balance` field, `0` by default.
2. `GET /auth/me` returns `balance` for the logged-in business owner.
3. The profile page (`/profile/me`) displays the balance, read-only.

## Decisions

- **Account:** `business_owners` only (the logged-in operator). Not the `users`
  (end customer) collection.
- **Type:** decimal-capable `z.number().default(0)` — no `.int()`. Values like
  `22450` or `22450.75` are valid. The comma in "22,450" is a display thousands
  separator, not stored data; we store the raw number.
- **Read-only:** display-only. No top-up, spend, transaction history, or edit on
  the profile-edit page.
- **Existing docs:** backfill `balance: 0` onto existing `business_owners` docs
  that lack it, plus a defensive `?? 0` in the response so it works regardless.

## Out of Scope (YAGNI)

- Crediting / debiting the balance, payments, transaction ledger.
- Integer minor-units (tiyin) storage. Plain `z.number()` for now. If balance
  later drives real accounting/payments, revisit to avoid float drift.
- Editing balance from the client.

## Backend Changes (`blyss-gcloud-api`)

### Storage at creation
Add `balance: 0` to the `business_owners` document written at creation:
- `src/routes/auth.js` — `POST /auth/register`, the `business_owner` branch
  (`createData` object).
- `src/routes/businessOwners.js` — `POST /businessOwners/register` legacy
  `.set()` call.

### Profile response
- `src/routes/auth.js` — `GET /auth/me` adds `balance: user.balance ?? 0` to the
  response object. The `?? 0` covers owners created before this field exists.

### Schema
- `src/schemas/auth.js` — add `balance: z.number().default(0)` to
  `meResponseSchema`.
- `src/schemas/businessOwner.js` — add `balance: z.number().default(0)` to
  `businessOwnerResponseSchema` for consistency.

### Backfill (one-time)
Set `balance: 0` on existing `business_owners` docs missing the field, via
Firestore (direct REST/admin access). Additive only — never overwrites a
non-missing value.

## Frontend Changes (`blyss-business-app`)

- `app/lib/types/auth.ts` — add `balance: number` to the `User` interface.
  `AuthMeResponse extends User` and the user store inherit it.
- `app/routes/profile/me.tsx` — add a read-only row to `profileFields`: Wallet
  icon, label `"Balans"`, value formatted with thousands separators (e.g.
  `(user?.balance ?? 0).toLocaleString(...)` rendered as `22 450 so'm`).

## Testing

- **Backend** (`src/routes/auth.test.js` or the existing auth test file):
  - `POST /auth/register` for a business owner writes `balance: 0`.
  - `GET /auth/me` returns `balance` (a number), defaulting to `0` when the
    stored doc has no `balance`.
- **Frontend:** `npm run typecheck` clean (the `balance` field is additive on
  `User`; profile page reads it defensively).
