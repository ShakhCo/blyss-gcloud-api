# Business Owner `balance` Field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every business owner a numeric `balance` (default 0) that is stored, returned by `/auth/me`, and shown read-only on the profile page.

**Architecture:** Add `balance: 0` at `business_owners` creation, return `balance` from `GET /auth/me` (defensively defaulting to 0), default it in the Zod response schemas, backfill existing docs, and surface it on `/profile/me`. `balance` is a decimal-capable `z.number()`.

**Tech Stack:** Express 5, Firestore, Zod, Vitest + supertest (API); React Router v7 + TypeScript + Zustand store (business-app).

**Spec:** `docs/superpowers/specs/2026-06-01-business-owner-balance-design.md`

**Working directories:**
- API tasks (1–3): `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api` (branch `feat/business-owner-balance`; Vitest v4 — run with Node 24)
- Frontend task (4): `/Users/shahzod/Projects/BLYSS/blyss-business-app` (its own git; branch off `master`)

---

## File Structure

**Backend (modify):**
- `src/schemas/auth.js` — `balance` on `meResponseSchema`
- `src/schemas/businessOwner.js` — `balance` on `businessOwnerResponseSchema`
- `src/routes/auth.js` — write `balance: 0` at register (business_owner branch); return `balance` from `/auth/me`
- `src/routes/businessOwners.js` — write `balance: 0` at legacy register
- `src/routes/auth.balance.test.js` — new test (create)

**Frontend (modify):**
- `app/lib/types/auth.ts` — `balance` on `User`
- `app/routes/profile/me.tsx` — read-only balance row

**Backfill:** one-time Firestore data update (orchestrator-run, Task 3).

---

## Task 1: Backend — `balance` in `/auth/me` + schema

**Files:**
- Modify: `src/schemas/auth.js` (`meResponseSchema`)
- Modify: `src/routes/auth.js` (`GET /auth/me` handler, ~line 631)
- Test: `src/routes/auth.balance.test.js` (create)

- [ ] **Step 1: Write the failing test** — create `src/routes/auth.balance.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const { mockUserDoc, mockCollection } = vi.hoisted(() => {
    const mockUserDoc = {
        exists: true,
        id: 'user123',
        data: () => ({
            first_name: 'Test',
            last_name: 'User',
            phone_number: '998901234567',
            is_verified: true,
            user_type: 'business_owner',
            balance: 22450.5,
        }),
    };
    const mockCollection = vi.fn((name) => {
        if (name === 'business_owners' || name === 'users') {
            return {
                doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue(mockUserDoc) }),
                where: vi.fn().mockReturnThis(),
                orderBy: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
            };
        }
        return {
            doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ exists: false }), set: vi.fn() }),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
        };
    });
    return { mockUserDoc, mockCollection };
});

vi.mock('../db/db.js', () => ({ db: { collection: mockCollection } }));

import app from '../server.js';

const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-abc123';
const API_SECRET_VAL = 'test-api-secret-at-least-32-chars-long-abc123';

function makeAccessToken(overrides = {}) {
    return jwt.sign(
        { user_id: 'user123', user_type: 'business_owner', type: 'access', ...overrides },
        JWT_SECRET,
        { expiresIn: '24h' },
    );
}
function makeHmacHeaders(bodyStr = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto.createHmac('sha256', API_SECRET_VAL).update(bodyStr + timestamp).digest('hex');
    return { 'x-timestamp': timestamp, 'x-signature': signature };
}

describe('GET /auth/me — balance', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the stored decimal balance', async () => {
        const hmac = makeHmacHeaders('');
        const res = await request(app)
            .get('/auth/me')
            .set('x-timestamp', hmac['x-timestamp'])
            .set('x-signature', hmac['x-signature'])
            .set('Cookie', `access_token=${makeAccessToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(22450.5);
    });

    it('defaults balance to 0 when the stored doc has none', async () => {
        mockUserDoc.data = () => ({
            first_name: 'Test',
            last_name: 'User',
            phone_number: '998901234567',
            is_verified: true,
            user_type: 'business_owner',
        });
        const hmac = makeHmacHeaders('');
        const res = await request(app)
            .get('/auth/me')
            .set('x-timestamp', hmac['x-timestamp'])
            .set('x-signature', hmac['x-signature'])
            .set('Cookie', `access_token=${makeAccessToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && npx vitest run src/routes/auth.balance.test.js`
Expected: FAIL — `res.body.balance` is `undefined` (either the schema strips it or the handler never sets it).

- [ ] **Step 3: Add `balance` to `meResponseSchema`**

In `src/schemas/auth.js`, in `meResponseSchema` (the `z.object({...})`), add `balance` after `is_verified`:

```js
export const meResponseSchema = z.object({
    id: z.string(),
    user_type: userTypeEnum,
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number().nullable().optional(),
    is_verified: z.boolean(),
    balance: z.number().default(0),
    created_at: z.string().optional()
});
```

- [ ] **Step 4: Return `balance` from `/auth/me`**

In `src/routes/auth.js`, in the `GET /auth/me` handler, add `balance` to the `response` object (after `is_verified`):

```js
        const response = {
            id: user.id,
            user_type: user.user_type,
            first_name: user.first_name,
            last_name: user.last_name || '',
            phone_number: user.phone_number,
            telegram_id: user.telegram_id || null,
            is_verified: user.is_verified || false,
            balance: user.balance ?? 0,
            created_at: user.created_at?.toDate?.().toISOString() || user.date_created?.toDate?.().toISOString()
        };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/routes/auth.balance.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/schemas/auth.js src/routes/auth.js src/routes/auth.balance.test.js
git commit -m "feat(auth): return business owner balance from /auth/me"
```

---

## Task 2: Backend — write `balance: 0` at registration

**Files:**
- Modify: `src/routes/auth.js` (`POST /auth/register`, `createData` ~line 384)
- Modify: `src/routes/businessOwners.js` (`POST /businessOwners/register` `.set()` ~line 108)
- Modify: `src/schemas/businessOwner.js` (`businessOwnerResponseSchema`)

- [ ] **Step 1: Add `balance: 0` for business owners in `auth.js` register**

In `src/routes/auth.js`, just after the existing `business_owner` telegram_id block:

```js
        if (user_type === 'business_owner' && userData.telegram_id !== undefined) {
            createData.telegram_id = userData.telegram_id ?? null;
        }
```

add:

```js
        if (user_type === 'business_owner') {
            createData.balance = 0;
        }
```

- [ ] **Step 2: Add `balance: 0` in the legacy `businessOwners.js` register**

In `src/routes/businessOwners.js`, in the `.set({...})` call, add `balance: 0`:

```js
        await db.collection('business_owners').doc(ownerId).set({
            first_name,
            last_name,
            phone_number,
            telegram_id: telegram_id ?? null,
            date_created: dateCreated,
            is_verified: false,
            balance: 0
        });
```

- [ ] **Step 3: Add `balance` default to `businessOwnerResponseSchema`**

In `src/schemas/businessOwner.js`, in `businessOwnerResponseSchema`, add `balance` after `is_verified`:

```js
export const businessOwnerResponseSchema = z.object({
    id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number().nullable(),
    date_created: z.string(),
    is_verified: z.boolean(),
    balance: z.number().default(0)
});
```

- [ ] **Step 4: Verify no regressions**

Run: `npx vitest run src/routes/auth.balance.test.js src/routes/auth.revocation.test.js`
Expected: PASS (existing revocation tests still green; balance tests green).

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.js src/routes/businessOwners.js src/schemas/businessOwner.js
git commit -m "feat(auth): default new business owners to balance 0"
```

---

## Task 3: Backfill existing `business_owners` docs (orchestrator-run, one-time)

> Not a code change. The controller runs this directly against Firestore using the
> logged-in `gcloud` access token. Additive only — sets `balance: 0` ONLY on docs
> that currently lack the field. Safe to re-run (idempotent).

- [ ] **Step 1: Count owners missing `balance`**

```bash
TOKEN=$(gcloud auth print-access-token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://firestore.googleapis.com/v1/projects/blyss-project/databases/(default)/documents:runQuery" \
  -d '{"structuredQuery":{"from":[{"collectionId":"business_owners"}],"select":{"fields":[{"fieldPath":"balance"}]}}}' \
  > /tmp/owners_balance.json
# Inspect how many docs lack a `balance` field (no "balance" key in fields).
```

- [ ] **Step 2: Patch each missing doc with `balance: 0`**

For each `business_owners` doc id missing `balance`, PATCH only that field (leaves all other fields intact via `updateMask`):

```bash
# DOC_ID for each owner missing balance:
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://firestore.googleapis.com/v1/projects/blyss-project/databases/(default)/documents/business_owners/$DOC_ID?updateMask.fieldPaths=balance" \
  -d '{"fields":{"balance":{"doubleValue":0}}}'
```

- [ ] **Step 3: Verify**

Re-run the Step 1 query and confirm every `business_owners` doc now has a `balance` field. Report the count updated.

---

## Task 4: Frontend — `balance` type + profile display

**Files:**
- Modify: `blyss-business-app/app/lib/types/auth.ts` (`User` interface)
- Modify: `blyss-business-app/app/routes/profile/me.tsx`

> NOTE: the `blyss-business-app` repo has UNRELATED pre-existing uncommitted changes.
> `git add` ONLY the two files below — never `git add .`. Branch off `master` first.

- [ ] **Step 1: Branch off master**

```bash
cd /Users/shahzod/Projects/BLYSS/blyss-business-app
git checkout master
git checkout -b feat/business-owner-balance
```

- [ ] **Step 2: Add `balance` to the `User` interface**

In `app/lib/types/auth.ts`, in `export interface User { ... }`, add `balance` after `is_verified`:

```ts
export interface User {
  id: string;
  user_type: UserType;
  first_name: string;
  last_name: string;
  phone_number: string;
  telegram_id: number | null;
  is_verified: boolean;
  balance: number;
  created_at: string;
}
```

- [ ] **Step 3: Show the balance on the profile page**

In `app/routes/profile/me.tsx`:

(a) add `Wallet` to the lucide-react import:

```tsx
import { Phone, LogOut, Wallet } from 'lucide-react';
```

(b) add a balance row to the `profileFields` array (after the Phone entry):

```tsx
  const profileFields = [
    {
      icon: Phone,
      label: 'Telefon raqam',
      value: user ? `+${user.phone_number}` : '',
    },
    {
      icon: Wallet,
      label: 'Balans',
      value: `${(user?.balance ?? 0).toLocaleString('uz-UZ')} so'm`,
    },
  ];
```

- [ ] **Step 4: Typecheck**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && npm run typecheck`
Expected: no NEW errors. (Pre-existing unrelated errors in `app/components/PersonalSchedule.tsx` may remain — ignore those.)

- [ ] **Step 5: Commit (only these two files)**

```bash
git add app/lib/types/auth.ts app/routes/profile/me.tsx
git commit -m "feat(profile): show business owner balance"
```

---

## Final Verification

- [ ] Backend: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && npx vitest run src/routes/auth.balance.test.js src/routes/auth.revocation.test.js` — pass.
- [ ] Backfill (Task 3) reports all `business_owners` docs now carry `balance`.
- [ ] Frontend: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && npm run typecheck` — no new errors.

## Spec Coverage Check

- Every `business_owners` doc has `balance` default 0 → Task 2 (new docs) + Task 3 (existing docs).
- `/auth/me` returns `balance` → Task 1.
- Schema carries `balance` → Task 1 (`meResponseSchema`) + Task 2 (`businessOwnerResponseSchema`).
- Profile page shows balance, read-only → Task 4 (no edit-page change).
- Decimal-capable `z.number().default(0)` → Tasks 1 & 2 (no `.int()`).
- `balance` reaches the store → automatic via existing `setUser(await /auth/me json)` spread; only the `User` type needs the field (Task 4 Step 2).
- YAGNI (no top-up/spend/ledger/edit) → none added.
