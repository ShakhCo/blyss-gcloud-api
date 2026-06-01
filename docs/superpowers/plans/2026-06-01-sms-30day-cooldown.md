# SMS Send History + 30-Day Per-Customer Cooldown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every campaign SMS per recipient and stop a business from texting the same customer more than once per 30 days.

**Architecture:** A new `sms_sends` Firestore collection records one doc per recipient per send (the history + cooldown source of truth). A small `smsCooldown` util computes the in-cooldown set for a business. `GET /recipients` annotates each customer with `in_cooldown` / `cooldown_until`; `POST /send` re-checks server-side, sends only to eligible phones, and writes the history. The frontend recipient picker disables in-cooldown customers.

**Tech Stack:** Express 5, `@google-cloud/firestore`, Zod, Vitest + supertest (API); React Router v7 + TanStack Query + TypeScript (business-app).

**Spec:** `docs/superpowers/specs/2026-06-01-sms-30day-cooldown-design.md`

**Working directories:**
- API tasks (1–4): `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api` (git branch `feat/sms-30day-cooldown`)
- Frontend tasks (5–6): `/Users/shahzod/Projects/BLYSS/blyss-business-app`

---

## File Structure

**Create:**
- `blyss-gcloud-api/src/utils/smsCooldown.js` — cooldown constants + `cooldownUntil()` + `getRecentContactMap()`
- `blyss-gcloud-api/src/utils/smsCooldown.test.js` — unit tests for the util

**Modify:**
- `blyss-gcloud-api/src/routes/sms.js` — annotate `/recipients`, enforce + record history in `/send`
- `blyss-gcloud-api/src/routes/sms.test.js` — add `sms_sends` + `batch` mocks, new test cases
- `blyss-gcloud-api/firestore.indexes.json` — composite index on `sms_sends`
- `blyss-business-app/app/lib/api/sms.ts` — extend `Recipient` + `SendResult` types
- `blyss-business-app/app/components/sms/SendWizard.tsx` — disable in-cooldown rows, surface skipped
- `blyss-business-app/app/lib/i18n/translations.ts` — new `sms.send.*` keys (uz + ru)

---

## Task 1: Cooldown utility

**Files:**
- Create: `blyss-gcloud-api/src/utils/smsCooldown.js`
- Test: `blyss-gcloud-api/src/utils/smsCooldown.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/utils/smsCooldown.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSmsSendsGet } = vi.hoisted(() => ({ mockSmsSendsGet: vi.fn() }));

vi.mock('../db/db.js', () => ({
    db: {
        collection: vi.fn(() => ({
            where: vi.fn().mockReturnThis(),
            get: mockSmsSendsGet,
        })),
    },
}));

import { SMS_COOLDOWN_DAYS, cooldownUntil, getRecentContactMap } from './smsCooldown.js';

function sendDoc(phone, success, sentAt) {
    return { data: () => ({ phone, success, sent_at: { toDate: () => sentAt } }) };
}

describe('cooldownUntil', () => {
    it('returns lastSent + 30 days as ISO', () => {
        const last = new Date('2026-05-01T00:00:00.000Z');
        expect(cooldownUntil(last)).toBe('2026-05-31T00:00:00.000Z');
        expect(SMS_COOLDOWN_DAYS).toBe(30);
    });
});

describe('getRecentContactMap', () => {
    beforeEach(() => vi.clearAllMocks());

    it('maps phone -> latest successful send, ignoring failures', async () => {
        const older = new Date('2026-05-10T00:00:00.000Z');
        const newer = new Date('2026-05-20T00:00:00.000Z');
        mockSmsSendsGet.mockResolvedValue({
            docs: [
                sendDoc('998900000010', true, older),
                sendDoc('998900000010', true, newer),
                sendDoc('998900000011', false, newer),
            ],
        });

        const map = await getRecentContactMap('biz-1');

        expect(map.get('998900000010')).toEqual(newer);
        expect(map.has('998900000011')).toBe(false); // failed send never locks
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && npx vitest run src/utils/smsCooldown.test.js`
Expected: FAIL — `Failed to resolve import "./smsCooldown.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/smsCooldown.js`:

```js
import { db } from '../db/db.js';

export const SMS_COOLDOWN_DAYS = 30;
const COOLDOWN_MS = SMS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

// ISO timestamp when a customer last contacted at `lastSent` (Date) becomes eligible again.
export function cooldownUntil(lastSent) {
    return new Date(lastSent.getTime() + COOLDOWN_MS).toISOString();
}

// Map<phone, Date> of the latest SUCCESSFUL send per phone within the cooldown window.
export async function getRecentContactMap(businessId, now = new Date()) {
    const cutoff = new Date(now.getTime() - COOLDOWN_MS);
    const snap = await db
        .collection('sms_sends')
        .where('business_id', '==', businessId)
        .where('sent_at', '>=', cutoff)
        .get();

    const map = new Map();
    for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.success) continue;
        const sentAt = d.sent_at?.toDate?.() ?? null;
        if (!sentAt) continue;
        const prev = map.get(d.phone);
        if (!prev || sentAt > prev) map.set(d.phone, sentAt);
    }
    return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/smsCooldown.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api
git add src/utils/smsCooldown.js src/utils/smsCooldown.test.js
git commit -m "feat(sms): add 30-day cooldown utility"
```

---

## Task 2: Annotate `/recipients` with cooldown status

**Files:**
- Modify: `blyss-gcloud-api/src/routes/sms.js` (imports; `/recipients` handler, lines ~135-172)
- Modify: `blyss-gcloud-api/src/routes/sms.test.js` (add `sms_sends` mock; new test)

- [ ] **Step 1: Add the `sms_sends` mock to the test file**

In `src/routes/sms.test.js`, add `mockSmsSendsGet` to the `vi.hoisted(...)` block (alongside `mockBookingsGet`):

```js
    mockSmsSendsGet,
```
and in the returned object:
```js
    mockSmsSendsGet: vi.fn(),
```

Then inside `vi.mock('../db/db.js', ...)`, add a branch in `collection` (before the final fallback `return {...}`):

```js
            if (name === 'sms_sends') {
                return {
                    where: vi.fn().mockReturnThis(),
                    get: mockSmsSendsGet,
                    doc: vi.fn(() => ({ id: 'send-doc' })),
                };
            }
```

Add a default so unrelated tests don't break — at the top of the existing top-level `beforeEach` (the one that calls `vi.clearAllMocks()`), add:

```js
    mockSmsSendsGet.mockResolvedValue({ docs: [] });
```

- [ ] **Step 2: Write the failing test**

Add this test inside the existing `describe('GET /businesses/:businessId/sms/recipients', ...)` block:

```js
    it('marks a recently-contacted recipient as in_cooldown', async () => {
        mockBookingsGet.mockResolvedValue({
            docs: [
                { data: () => ({ customer_phone: '998900000010', customer_name: 'Ali', booking_date: '2026-05-01' }) },
                { data: () => ({ customer_phone: '998900000011', customer_name: 'Vali', booking_date: '2026-04-01' }) },
            ],
        });
        mockSmsSendsGet.mockResolvedValue({
            docs: [
                { data: () => ({ phone: '998900000010', success: true, sent_at: { toDate: () => new Date('2026-05-25T00:00:00.000Z') } }) },
            ],
        });

        const res = await request(app)
            .get('/businesses/biz-1/sms/recipients')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        const ali = res.body.find((r) => r.phone_number === '998900000010');
        const vali = res.body.find((r) => r.phone_number === '998900000011');
        expect(ali).toMatchObject({ in_cooldown: true, cooldown_until: '2026-06-24T00:00:00.000Z' });
        expect(vali).toMatchObject({ in_cooldown: false, cooldown_until: null });
    });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/routes/sms.test.js -t "in_cooldown"`
Expected: FAIL — `in_cooldown` is `undefined` on the response objects.

- [ ] **Step 4: Implement the annotation**

In `src/routes/sms.js`, add the import near the other util imports (after the `resolveSmsContext` import on line 13):

```js
import { getRecentContactMap, cooldownUntil } from '../utils/smsCooldown.js';
```

In the `/recipients` handler, replace the final `items` construction (currently lines ~167-171):

```js
    const items = Array.from(byPhone.values())
        .sort((a, b) => (b.last_visit_at ?? '').localeCompare(a.last_visit_at ?? ''))
        .slice(0, 500);

    return res.json(items);
```

with:

```js
    const contactMap = await getRecentContactMap(business_id);
    const items = Array.from(byPhone.values())
        .sort((a, b) => (b.last_visit_at ?? '').localeCompare(a.last_visit_at ?? ''))
        .slice(0, 500)
        .map((r) => {
            const lastSent = contactMap.get(r.phone_number);
            return {
                ...r,
                in_cooldown: !!lastSent,
                cooldown_until: lastSent ? cooldownUntil(lastSent) : null,
            };
        });

    return res.json(items);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/routes/sms.test.js`
Expected: PASS — including the existing recipients test (now also returns `in_cooldown: false`) and the new one.

- [ ] **Step 6: Commit**

```bash
git add src/routes/sms.js src/routes/sms.test.js
git commit -m "feat(sms): annotate recipients with cooldown status"
```

---

## Task 3: Enforce cooldown + record history in `/send`

**Files:**
- Modify: `blyss-gcloud-api/src/routes/sms.js` (`/send` handler, lines ~174-219)
- Modify: `blyss-gcloud-api/src/routes/sms.test.js` (add `batch` mock; new tests)

- [ ] **Step 1: Add the batch mock to the test file**

In `src/routes/sms.test.js`, add to the `vi.hoisted(...)` block:

```js
    mockBatchSet,
    mockBatchCommit,
```
and in the returned object:
```js
    mockBatchSet: vi.fn(),
    mockBatchCommit: vi.fn(),
```

Inside `vi.mock('../db/db.js', ...)`, add a `batch` method to the `db` object (sibling of `collection` and `collectionGroup`):

```js
        batch: vi.fn(() => ({ set: mockBatchSet, commit: mockBatchCommit })),
```

In the top-level `beforeEach`, add a default so commit resolves:

```js
    mockBatchCommit.mockResolvedValue();
```

- [ ] **Step 2: Write the failing tests**

Add these tests inside the existing `describe('POST /businesses/:businessId/sms/send', ...)` block:

```js
    it('skips phones in cooldown and reports them', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({ business_id: 'biz-1', creator_id: 'owner-1', creator_type: 'business_owner', polished_text: 'Hi', status: 'confirmed' }),
        });
        mockSmsSendsGet.mockResolvedValue({
            docs: [
                { data: () => ({ phone: '998900000010', success: true, sent_at: { toDate: () => new Date('2026-05-25T00:00:00.000Z') } }) },
            ],
        });
        mockSendSms.mockResolvedValue({ success: true });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-9' });

        const body = { template_id: 't1', phone_numbers: ['998900000010', '998900000011'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(200);
        expect(mockSendSms).toHaveBeenCalledTimes(1);              // only the eligible phone
        expect(mockSendSms).toHaveBeenCalledWith('998900000011', 'Hi');
        expect(res.body.sent).toBe(1);
        expect(res.body.skipped).toEqual([
            { phone: '998900000010', cooldown_until: '2026-06-24T00:00:00.000Z' },
        ]);
        expect(mockBatchSet).toHaveBeenCalledTimes(1);             // history only for eligible
        expect(mockBatchCommit).toHaveBeenCalledOnce();
    });

    it('returns sent:0 with a skip list when all phones are in cooldown', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({ business_id: 'biz-1', creator_id: 'owner-1', creator_type: 'business_owner', polished_text: 'Hi', status: 'confirmed' }),
        });
        mockSmsSendsGet.mockResolvedValue({
            docs: [
                { data: () => ({ phone: '998900000010', success: true, sent_at: { toDate: () => new Date('2026-05-25T00:00:00.000Z') } }) },
            ],
        });

        const body = { template_id: 't1', phone_numbers: ['998900000010'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ campaign_id: null, sent: 0, failed: 0 });
        expect(res.body.skipped).toHaveLength(1);
        expect(mockSendSms).not.toHaveBeenCalled();
        expect(mockCampaignAdd).not.toHaveBeenCalled();
    });

    it('records a failed send with success:false so the customer is not locked', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({ business_id: 'biz-1', creator_id: 'owner-1', creator_type: 'business_owner', polished_text: 'Hi', status: 'confirmed' }),
        });
        mockSendSms.mockResolvedValue({ success: false, error: 'provider down' });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-10' });

        const body = { template_id: 't1', phone_numbers: ['998900000011'] };
        await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(mockBatchSet).toHaveBeenCalledTimes(1);
        const written = mockBatchSet.mock.calls[0][1];
        expect(written).toMatchObject({ phone: '998900000011', success: false });
    });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/routes/sms.test.js -t "send"`
Expected: FAIL — `res.body.skipped` undefined / `mockBatchSet` not called (history not written yet).

- [ ] **Step 4: Implement enforcement + history**

In `src/routes/sms.js`, extend the cooldown import added in Task 2 to also pull the constant (optional but keeps intent clear):

```js
import { getRecentContactMap, cooldownUntil } from '../utils/smsCooldown.js';
```

Replace the body of the `/send` handler from after the template checks (the line `if (tpl.status !== 'confirmed') { ... }` block stays) — i.e. replace from the current line 193 (`const results = await sendWithConcurrency(...)`) through the end of the handler (line 218) with:

```js
    const contactMap = await getRecentContactMap(business_id);
    const eligible = [];
    const skipped = [];
    for (const phone of phone_numbers) {
        const lastSent = contactMap.get(phone);
        if (lastSent) skipped.push({ phone, cooldown_until: cooldownUntil(lastSent) });
        else eligible.push(phone);
    }

    if (eligible.length === 0) {
        return res.status(200).json({ campaign_id: null, sent: 0, failed: 0, errors: [], skipped });
    }

    const results = await sendWithConcurrency(eligible, tpl.polished_text, 5);
    const failures = results.filter((r) => !r.success);

    const campaignDoc = {
        business_id,
        sender_id: creator_id,
        sender_type: creator_type,
        template_id,
        message_snapshot: tpl.polished_text,
        recipient_count: eligible.length,
        success_count: results.length - failures.length,
        failure_count: failures.length,
        skipped_count: skipped.length,
        errors: failures.slice(0, 20).map((f) => ({ phone: f.phone, error: f.error || 'unknown' })),
        sent_at: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('sms_campaigns').add(campaignDoc);

    const batch = db.batch();
    for (const r of results) {
        const sendRef = db.collection('sms_sends').doc();
        batch.set(sendRef, {
            business_id,
            phone: r.phone,
            name: null,
            campaign_id: ref.id,
            template_id,
            sender_id: creator_id,
            sender_type: creator_type,
            success: r.success,
            sent_at: FieldValue.serverTimestamp(),
        });
    }
    await batch.commit();

    const payload = {
        campaign_id: ref.id,
        sent: campaignDoc.success_count,
        failed: campaignDoc.failure_count,
        errors: campaignDoc.errors,
        skipped,
    };

    const failedTooMany = failures.length > eligible.length / 2;
    return res.status(failedTooMany ? 502 : 200).json(payload);
```

- [ ] **Step 5: Run the full SMS test file**

Run: `npx vitest run src/routes/sms.test.js`
Expected: PASS — all existing tests (the "sends to all phones" test now also triggers `mockBatchSet` twice and `mockBatchCommit` once via the defaults) plus the 3 new ones.

- [ ] **Step 6: Run the whole API test suite**

Run: `npm test`
Expected: PASS — no regressions in other suites.

- [ ] **Step 7: Commit**

```bash
git add src/routes/sms.js src/routes/sms.test.js
git commit -m "feat(sms): enforce 30-day cooldown and record per-recipient history on send"
```

---

## Task 4: Firestore composite index

**Files:**
- Modify: `blyss-gcloud-api/firestore.indexes.json`

- [ ] **Step 1: Add the index**

In `firestore.indexes.json`, add this object as a new entry in the top-level `"indexes"` array (insert after the opening `"indexes": [` so it sits alongside the existing entries — mind the trailing comma):

```json
    {
      "collectionGroup": "sms_sends",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "business_id", "order": "ASCENDING" },
        { "fieldPath": "sent_at", "order": "ASCENDING" }
      ]
    },
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && node -e "JSON.parse(require('fs').readFileSync('firestore.indexes.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 3: Commit**

```bash
git add firestore.indexes.json
git commit -m "feat(sms): add Firestore index for sms_sends cooldown query"
```

> **Deploy note (manual, not part of this plan):** the index must be deployed before the query runs in production — `gcloud firestore indexes composite create` or `firebase deploy --only firestore:indexes`. Until deployed, `/recipients` and `/send` will error on the range query in prod.

---

## Task 5: Frontend types

**Files:**
- Modify: `blyss-business-app/app/lib/api/sms.ts` (`Recipient` lines 27-32; `SendResult` lines 48-53)

- [ ] **Step 1: Extend the `Recipient` interface**

In `app/lib/api/sms.ts`, replace lines 27-32:

```ts
export interface Recipient {
  phone_number: string;
  name: string | null;
  last_visit_at: string | null;
  visit_count: number;
}
```

with:

```ts
export interface Recipient {
  phone_number: string;
  name: string | null;
  last_visit_at: string | null;
  visit_count: number;
  in_cooldown: boolean;
  cooldown_until: string | null;
}
```

- [ ] **Step 2: Extend the `SendResult` interface**

Replace lines 48-53:

```ts
export interface SendResult {
  campaign_id: string;
  sent: number;
  failed: number;
  errors: Array<{ phone: string; error: string }>;
}
```

with:

```ts
export interface SendResult {
  campaign_id: string | null;
  sent: number;
  failed: number;
  errors: Array<{ phone: string; error: string }>;
  skipped?: Array<{ phone: string; cooldown_until: string | null }>;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/shahzod/Projects/BLYSS/blyss-business-app
git add app/lib/api/sms.ts
git commit -m "feat(sms): add cooldown fields to Recipient and SendResult types"
```

---

## Task 6: Recipient picker — disable in-cooldown customers + surface skipped

**Files:**
- Modify: `blyss-business-app/app/components/sms/SendWizard.tsx`
- Modify: `blyss-business-app/app/lib/i18n/translations.ts` (uz block ~line 1107; ru block ~line 2226)

- [ ] **Step 1: Add translation keys (uz)**

In `app/lib/i18n/translations.ts`, in the UZ block immediately after the line `'sms.send.sendAnother': "Yana yuborish",` add:

```ts
    'sms.send.cooldownBadge': "Yaqinda yuborilgan",
    'sms.send.availableOn': "{{date}} dan keyin",
    'sms.send.skippedNote': "{{count}} ta mijoz yaqinda xabar olgani uchun o'tkazib yuborildi.",
```

- [ ] **Step 2: Add translation keys (ru)**

In the RU block immediately after the line `'sms.send.sendAnother': "Отправить ещё",` add:

```ts
    'sms.send.cooldownBadge': "Недавно отправлено",
    'sms.send.availableOn': "Доступно после {{date}}",
    'sms.send.skippedNote': "{{count}} клиент(ов) пропущено: недавно получали сообщение.",
```

- [ ] **Step 3: Guard selection against in-cooldown recipients**

In `app/components/sms/SendWizard.tsx`, replace `toggle` (lines 60-65):

```ts
  function toggle(phone: string) {
    const next = new Set(selected);
    if (next.has(phone)) next.delete(phone);
    else if (next.size < 100) next.add(phone);
    setSelected(next);
  }
```

with:

```ts
  function toggle(r: Recipient) {
    if (r.in_cooldown) return;
    const next = new Set(selected);
    if (next.has(r.phone_number)) next.delete(r.phone_number);
    else if (next.size < 100) next.add(r.phone_number);
    setSelected(next);
  }
```

And replace `toggleAll` (lines 67-73) so it only selects eligible recipients:

```ts
  function toggleAll() {
    if (selected.size > 0) {
      setSelected(new Set());
    } else {
      setSelected(
        new Set(filtered.filter((r) => !r.in_cooldown).slice(0, 100).map((r) => r.phone_number)),
      );
    }
  }
```

- [ ] **Step 4: Render in-cooldown rows as disabled**

Replace the recipient row block (lines 159-185, the `filtered.map((r) => { ... })`) with:

```tsx
            filtered.map((r) => {
              const isSelected = selected.has(r.phone_number);
              const disabled = r.in_cooldown;
              return (
                <button
                  key={r.phone_number}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(r)}
                  className={
                    'w-full text-left flex items-center gap-3 px-4 py-3 transition-colors ' +
                    (disabled ? 'opacity-50 cursor-not-allowed' : 'active:bg-muted/40')
                  }
                >
                  <span
                    className={
                      'w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-colors ' +
                      (isSelected
                        ? 'bg-primary'
                        : 'border-2 border-muted-foreground/40 bg-card')
                    }
                  >
                    {isSelected && <Check size={14} className="text-primary-foreground" strokeWidth={3} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">{r.name || '—'}</div>
                    <div className="text-xs text-muted-foreground">{r.phone_number}</div>
                  </div>
                  {disabled ? (
                    <div className="text-[11px] text-amber-600 shrink-0 text-right leading-tight">
                      <div>{t('sms.send.cooldownBadge')}</div>
                      {r.cooldown_until && (
                        <div>
                          {t('sms.send.availableOn', {
                            date: new Date(r.cooldown_until).toLocaleDateString(),
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground shrink-0">×{r.visit_count}</div>
                  )}
                </button>
              );
            })
```

- [ ] **Step 5: Surface skipped recipients in the result screen**

Change the `result` state type (line 25):

```ts
  const [result, setResult] = useState<{ sent: number; failed: number; skipped: number } | null>(null);
```

Update the mutation `onSuccess` (lines 53-57):

```ts
    onSuccess: (data) => {
      setResult({ sent: data.sent, failed: data.failed, skipped: data.skipped?.length ?? 0 });
      setPickerOpen(false);
      qc.invalidateQueries({ queryKey: ['sms-campaigns', businessId] });
      qc.invalidateQueries({ queryKey: ['sms-recipients', businessId] });
    },
```

In the result render block, after the existing result banner `</div>` (after line 104, before the "send another" button on line 105), add:

```tsx
        {result.skipped > 0 && (
          <div className="rounded-2xl p-3 text-xs text-amber-600 bg-amber-500/10 text-center">
            {t('sms.send.skippedNote', { count: result.skipped })}
          </div>
        )}
```

- [ ] **Step 6: Typecheck and lint**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && npm run typecheck && npm run lint`
Expected: PASS. (If lint flags the unused `phone` param anywhere, it's because `toggle` now takes a `Recipient` — confirm no other caller passes a string.)

- [ ] **Step 7: Commit**

```bash
git add app/components/sms/SendWizard.tsx app/lib/i18n/translations.ts
git commit -m "feat(sms): disable in-cooldown customers in recipient picker and surface skipped"
```

---

## Final Verification

- [ ] API: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && npm test` — all suites pass.
- [ ] Frontend: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && npm run typecheck && npm run lint` — clean.
- [ ] Manual sanity (optional, requires running API + app): send a campaign to a customer, reload the recipient picker, confirm that customer now shows grayed-out with an "available after {date}" label and cannot be selected.
- [ ] Confirm the `sms_sends` Firestore index is deployed before relying on this in production (see Task 4 deploy note).

## Spec Coverage Check

- History persisted per recipient → Task 3 (`sms_sends` batch write).
- 1 SMS / 30 days, per business → Task 1 (`getRecentContactMap`) + Task 3 (eligibility split).
- Only successful sends lock → Task 1 (`if (!d.success) continue`) + Task 3 (writes `success` flag).
- Disabled at selection → Task 6; re-checked server-side → Task 3.
- `in_cooldown` / `cooldown_until` on recipients → Task 2 + Task 5.
- Skipped reported to client → Task 3 (`skipped`) + Task 6 (note).
- Firestore index → Task 4.
- Transactional SMS unaffected → only `/sms/send` touched; OTP/invite paths in `eskiz.js` untouched.
