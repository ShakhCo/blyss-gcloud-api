# SMS Template Type & Price + Balance-Gated Sending — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-set `type` (service/ads) and `price_per_sms` to SMS templates (visible only when confirmed), and charge the business owner's balance per actually-sent message, gating the send on sufficient balance.

**Architecture:** Backend stores the two fields on `sms_templates` (admin edits in Firestore), exposes them only for `confirmed` templates, and on `/send` reads the business owner's balance, rejects with 402 if `balance < price × eligible`, then deducts `price × successful` via `FieldValue.increment`. Frontend shows the type label + price, gates the send button on `balance ≥ price × selected`, and decrements the store balance by the returned `charged`.

**Tech Stack:** Express 5, Firestore, Zod, Vitest + supertest (API); React Router v7 + TS + Tailwind + Zustand (business-app).

**Spec:** `docs/superpowers/specs/2026-06-01-sms-template-pricing-design.md`

**Working directories:**
- API tasks 1–2: `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api` (branch `feat/sms-template-pricing`; Vitest v4 — run with Node 24: prefix `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`).
- Frontend tasks 3–4: `/Users/shahzod/Projects/BLYSS/blyss-business-app` (its own git; branch off `master`).

> Frontend repo NOTE: has UNRELATED pre-existing uncommitted changes + pre-existing `PersonalSchedule.tsx` typecheck errors. `git add` ONLY the listed files — never `git add .`.

---

## File Structure

**Backend (modify):**
- `src/routes/sms.js` — POST /templates default fields; GET /templates status-gated exposure; /send balance gate + deduction
- `src/utils/smsContext.js` — return `business_owner_id`
- `src/routes/sms.test.js` — owner-update mock + new tests

**Frontend (modify):**
- `app/lib/api/sms.ts` — `SmsTemplate` type/price, `SendResult.charged`
- `app/components/sms/TemplatesList.tsx` — type label + price on confirmed
- `app/components/sms/SendWizard.tsx` — price/label in picker, balance gate, charge handling
- `app/lib/i18n/translations.ts` — type labels, price/cost/insufficient/charged keys (uz + ru)

---

## Task 1: Backend — template `type`/`price_per_sms` fields

**Files:**
- Modify: `src/routes/sms.js` (POST /templates doc ~lines 64-74; GET /templates map ~lines 100-108)
- Test: `src/routes/sms.test.js` (templates GET describe block)

- [ ] **Step 1: Write the failing test**

In `src/routes/sms.test.js`, inside `describe('GET /businesses/:businessId/sms/templates', ...)`, add:

```js
    it('exposes type/price only for confirmed templates', async () => {
        mockTemplateGet.mockResolvedValue({
            docs: [
                { id: 'c1', data: () => ({ business_id: 'biz-1', creator_id: 'owner-1', creator_type: 'business_owner', polished_text: 'A', status: 'confirmed', type: 'ads', price_per_sms: 500, created_at: null, moderated_at: null }) },
                { id: 'p1', data: () => ({ business_id: 'biz-1', creator_id: 'owner-1', creator_type: 'business_owner', polished_text: 'B', status: 'pending_moderation', type: 'ads', price_per_sms: 500, created_at: null, moderated_at: null }) },
            ],
        });

        const res = await request(app)
            .get('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        const confirmed = res.body.find((t) => t.id === 'c1');
        const pending = res.body.find((t) => t.id === 'p1');
        expect(confirmed).toMatchObject({ type: 'ads', price_per_sms: 500 });
        expect(pending).toMatchObject({ type: null, price_per_sms: null });
    });
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npx vitest run src/routes/sms.test.js -t "exposes type/price"`
Expected: FAIL — `type`/`price_per_sms` come back as the raw stored values (pending not nulled) / undefined.

- [ ] **Step 3: Default the fields at creation**

In `src/routes/sms.js`, `POST /templates`, add `type` and `price_per_sms` to the created `doc` (after `moderated_at: null,`):

```js
    const doc = {
        business_id,
        creator_id,
        creator_type,
        example_text,
        polished_text: example_text,
        status: 'pending_moderation',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        moderated_at: null,
        type: null,
        price_per_sms: null,
    };
```

- [ ] **Step 4: Gate exposure in GET /templates**

In `src/routes/sms.js`, `GET /templates`, replace the `.map((d) => { ... })` body with:

```js
        .map((d) => {
            const data = d.data();
            const confirmed = data.status === 'confirmed';
            return {
                id: d.id,
                ...data,
                type: confirmed ? (data.type ?? null) : null,
                price_per_sms: confirmed ? (data.price_per_sms ?? null) : null,
                created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
                moderated_at: data.moderated_at?.toDate?.()?.toISOString() ?? null,
            };
        })
```

(The `type`/`price_per_sms` lines come AFTER `...data` so they override the spread.)

- [ ] **Step 5: Run — expect PASS**

Run: `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npx vitest run src/routes/sms.test.js`
Expected: PASS (existing template tests + the new one). The POST /templates test may now also return `type:null, price_per_sms:null` in the body — if an existing assertion uses `toMatchObject` it still passes; do not weaken it.

- [ ] **Step 6: Commit**

```bash
git add src/routes/sms.js src/routes/sms.test.js
git commit -m "feat(sms): add admin-set template type/price, exposed only when confirmed"
```

---

## Task 2: Backend — balance gate + deduction on send

**Files:**
- Modify: `src/utils/smsContext.js` (both return objects)
- Modify: `src/routes/sms.js` (`/send` handler)
- Modify: `src/routes/sms.test.js` (add owner-update mock + new tests)

- [ ] **Step 1: Add the owner-update mock to the test file**

In `src/routes/sms.test.js`:
- Add `mockOwnerUpdate` to the `vi.hoisted(...)` destructured names and to the returned object (`mockOwnerUpdate: vi.fn()`).
- Change the `business_owners`/`users` branch in the db mock from:
```js
            if (name === 'business_owners' || name === 'users') {
                return { doc: vi.fn(() => ({ get: mockUserDocGet })) };
            }
```
to:
```js
            if (name === 'business_owners' || name === 'users') {
                return { doc: vi.fn(() => ({ get: mockUserDocGet, update: mockOwnerUpdate })) };
            }
```
- In the top-level `beforeEach`, add: `mockOwnerUpdate.mockResolvedValue();`

- [ ] **Step 2: Write the failing tests**

Add inside `describe('POST /businesses/:businessId/sms/send', ...)`:

```js
    function confirmedTpl(price) {
        return {
            exists: true,
            id: 't1',
            data: () => ({ business_id: 'biz-1', creator_id: 'owner-1', creator_type: 'business_owner', polished_text: 'Hi', status: 'confirmed', price_per_sms: price }),
        };
    }
    function ownerWithBalance(balance) {
        return { exists: true, id: 'owner-1', data: () => ({ first_name: 'Own', phone_number: '998900000001', is_verified: true, balance }) };
    }

    it('deducts price x successful sends and returns charged', async () => {
        mockTemplateDocGet.mockResolvedValue(confirmedTpl(500));
        mockUserDocGet.mockResolvedValue(ownerWithBalance(5000));
        mockSendSms.mockResolvedValue({ success: true });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-p1' });

        const body = { template_id: 't1', phone_numbers: ['998900000010', '998900000011'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ sent: 2, charged: 1000 });
        expect(mockOwnerUpdate).toHaveBeenCalledTimes(1);
        expect(mockOwnerUpdate.mock.calls[0][0]).toHaveProperty('balance');
    });

    it('rejects with 402 when balance is insufficient and sends nothing', async () => {
        mockTemplateDocGet.mockResolvedValue(confirmedTpl(500));
        mockUserDocGet.mockResolvedValue(ownerWithBalance(400));

        const body = { template_id: 't1', phone_numbers: ['998900000010'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(402);
        expect(res.body).toMatchObject({ error_code: 'INSUFFICIENT_BALANCE', required: 500, balance: 400 });
        expect(mockSendSms).not.toHaveBeenCalled();
        expect(mockOwnerUpdate).not.toHaveBeenCalled();
    });

    it('does not read balance or deduct for a free (price 0/null) template', async () => {
        mockTemplateDocGet.mockResolvedValue(confirmedTpl(null));
        mockSendSms.mockResolvedValue({ success: true });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-free' });

        const body = { template_id: 't1', phone_numbers: ['998900000010'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(200);
        expect(res.body.charged ?? 0).toBe(0);
        expect(mockOwnerUpdate).not.toHaveBeenCalled();
    });

    it('charges only successful sends (failed excluded)', async () => {
        mockTemplateDocGet.mockResolvedValue(confirmedTpl(500));
        mockUserDocGet.mockResolvedValue(ownerWithBalance(5000));
        mockSendSms
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false, error: 'x' });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-mix' });

        const body = { template_id: 't1', phone_numbers: ['998900000010', '998900000011'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.body.charged).toBe(500); // 1 success x 500
    });
```

- [ ] **Step 3: Run — expect FAIL**

Run: `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npx vitest run src/routes/sms.test.js -t "send"`
Expected: FAIL — `charged` undefined / no 402 / `mockOwnerUpdate` not called.

- [ ] **Step 4: Return `business_owner_id` from smsContext**

In `src/utils/smsContext.js`, add `business_owner_id: businessData.business_owner_id` to BOTH return objects:

The business_owner return becomes:
```js
        return {
            creator_id: user.id,
            creator_type: 'business_owner',
            business_id: businessId,
            business_owner_id: businessData.business_owner_id,
        };
```
The employee return becomes:
```js
                return {
                    creator_id: match.id,
                    creator_type: 'employee',
                    business_id: businessId,
                    business_owner_id: businessData.business_owner_id,
                };
```

- [ ] **Step 5: Add the balance gate + deduction in `/send`**

In `src/routes/sms.js`, `/send` handler: pull `business_owner_id` from the context and rework the section from after the `eligible.length === 0` early-return through the response.

(a) Update the context destructure at the top of the handler:
```js
    const { creator_id, creator_type, business_id, business_owner_id } = req.smsCtx;
```

(b) Immediately AFTER the `if (eligible.length === 0) { ... }` early-return block, insert the balance gate:
```js
    const price = tpl.price_per_sms ?? 0;
    if (price > 0) {
        const ownerSnap = await db.collection('business_owners').doc(business_owner_id).get();
        const ownerBalance = ownerSnap.exists ? (ownerSnap.data().balance ?? 0) : 0;
        const required = price * eligible.length;
        if (ownerBalance < required) {
            return res.status(402).json({
                error: 'Insufficient balance',
                error_code: 'INSUFFICIENT_BALANCE',
                required,
                balance: ownerBalance,
            });
        }
    }
```

(c) After `const failures = results.filter((r) => !r.success);`, compute the charge:
```js
    const charged = price * (results.length - failures.length);
```

(d) Add `price_per_sms` and `charged` to `campaignDoc` (after `skipped_count: skipped.length,`):
```js
        skipped_count: skipped.length,
        price_per_sms: price,
        charged,
```

(e) AFTER the `sms_sends` batch `try/catch` block, deduct the balance:
```js
    if (charged > 0) {
        try {
            await db.collection('business_owners').doc(business_owner_id).update({
                balance: FieldValue.increment(-charged),
            });
        } catch (err) {
            console.error('balance deduction failed for campaign', ref.id, err);
            // SMS already delivered; do not fail the request over the deduction
        }
    }
```

(f) Add `charged` to the response `payload`:
```js
    const payload = {
        campaign_id: ref.id,
        sent: campaignDoc.success_count,
        failed: campaignDoc.failure_count,
        errors: campaignDoc.errors,
        skipped,
        charged,
    };
```

- [ ] **Step 6: Run the full SMS test file**

Run: `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npx vitest run src/routes/sms.test.js`
Expected: PASS — the 4 new send tests plus all pre-existing tests. Pre-existing send tests use templates whose `data()` has no `price_per_sms`, so `price = 0` → no balance read, no deduction, `charged: 0`; their `toMatchObject` assertions are unaffected.

- [ ] **Step 7: Run the whole suite**

Run: `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm test`
Expected: the SMS + cooldown + auth suites pass; pre-existing unrelated failures in `chatAi.test.js`/`server.test.js` may remain (confirm they are the same as before, not caused here).

- [ ] **Step 8: Commit**

```bash
git add src/routes/sms.js src/utils/smsContext.js src/routes/sms.test.js
git commit -m "feat(sms): charge owner balance per sent message, gate send on balance"
```

---

## Task 3: Frontend — types + TemplatesList display

**Files:**
- Modify: `blyss-business-app/app/lib/api/sms.ts`
- Modify: `blyss-business-app/app/components/sms/TemplatesList.tsx`
- Modify: `blyss-business-app/app/lib/i18n/translations.ts`

- [ ] **Step 1: Branch off master**

```bash
cd /Users/shahzod/Projects/BLYSS/blyss-business-app
git checkout master
git checkout -b feat/sms-template-pricing
```

- [ ] **Step 2: Extend the types**

In `app/lib/api/sms.ts`, add to the `SmsTemplate` interface (after `moderated_at: string | null;`):
```ts
  type?: 'service' | 'ads' | null;
  price_per_sms?: number | null;
```
And add to the `SendResult` interface (after `skipped?: ...;`):
```ts
  charged?: number;
```

- [ ] **Step 3: Add the type-label + price translation keys (uz)**

In `app/lib/i18n/translations.ts`, in the UZ block immediately after `'sms.templates.delete': "O'chirish",` add:
```ts
    'sms.templates.type.service': "Service turdagi",
    'sms.templates.type.ads': "Reklama turdagi",
    'sms.send.pricePerSms': "{{price}} so'm / SMS",
    'sms.send.cost': "Narxi: {{cost}} so'm",
    'sms.send.insufficientBalance': "Balans yetarli emas (mavjud: {{balance}} so'm)",
    'sms.send.charged': "Hisobdan yechildi: {{charged}} so'm",
```

- [ ] **Step 4: Add the type-label + price translation keys (ru)**

In the RU block immediately after `'sms.templates.delete': "Удалить",` add:
```ts
    'sms.templates.type.service': "Сервисного типа",
    'sms.templates.type.ads': "Рекламного типа",
    'sms.send.pricePerSms': "{{price}} сум / SMS",
    'sms.send.cost': "Стоимость: {{cost}} сум",
    'sms.send.insufficientBalance': "Недостаточно баланса (доступно: {{balance}} сум)",
    'sms.send.charged': "Списано: {{charged}} сум",
```

- [ ] **Step 5: Show type label + price in the TemplatesList detail**

In `app/components/sms/TemplatesList.tsx`, in the detail modal, immediately AFTER the polished-text block:
```tsx
            <div className="text-sm whitespace-pre-wrap rounded-2xl bg-muted/40 p-3 text-foreground">
              {selected.polished_text}
            </div>
```
insert:
```tsx
            {selected.status === 'confirmed' && (selected.type || (selected.price_per_sms ?? 0) > 0) && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {selected.type && (
                  <span>{t(selected.type === 'ads' ? 'sms.templates.type.ads' : 'sms.templates.type.service')}</span>
                )}
                {(selected.price_per_sms ?? 0) > 0 && (
                  <span>{t('sms.send.pricePerSms', { price: (selected.price_per_sms ?? 0).toLocaleString('ru-RU') })}</span>
                )}
              </div>
            )}
```

- [ ] **Step 6: Typecheck + lint**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm run typecheck && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm run lint`
Expected: only pre-existing `PersonalSchedule.tsx` typecheck errors; no new errors/lint in the changed files.

- [ ] **Step 7: Commit (only these files)**

```bash
git add app/lib/api/sms.ts app/components/sms/TemplatesList.tsx app/lib/i18n/translations.ts
git commit -m "feat(sms): show template type and price on confirmed templates"
```

---

## Task 4: Frontend — SendWizard price, balance gate, charge

**Files:**
- Modify: `blyss-business-app/app/components/sms/SendWizard.tsx`

- [ ] **Step 1: Import the user store and read balance**

In `app/components/sms/SendWizard.tsx`, add the import (after the i18n import on line 5):
```tsx
import { useUserStore } from '~/stores/user-store';
```
Inside the component, after `const qc = useQueryClient();`, add:
```tsx
  const balance = useUserStore((s) => s.user?.balance ?? 0);
```

- [ ] **Step 2: Track `charged` in result state**

Change the result state declaration:
```tsx
  const [result, setResult] = useState<{ sent: number; failed: number; skipped: number } | null>(null);
```
to:
```tsx
  const [result, setResult] = useState<{ sent: number; failed: number; skipped: number; charged: number } | null>(null);
```

- [ ] **Step 3: On success, record charge + decrement the store balance**

Replace the `send` mutation `onSuccess`:
```tsx
    onSuccess: (data) => {
      setResult({ sent: data.sent, failed: data.failed, skipped: data.skipped?.length ?? 0 });
      setPickerOpen(false);
      qc.invalidateQueries({ queryKey: ['sms-campaigns', businessId] });
      qc.invalidateQueries({ queryKey: ['sms-recipients', businessId] });
    },
```
with:
```tsx
    onSuccess: (data) => {
      const charged = data.charged ?? 0;
      setResult({ sent: data.sent, failed: data.failed, skipped: data.skipped?.length ?? 0, charged });
      setPickerOpen(false);
      if (charged > 0) {
        const u = useUserStore.getState().user;
        if (u) useUserStore.getState().setUser({ ...u, balance: (u.balance ?? 0) - charged });
      }
      qc.invalidateQueries({ queryKey: ['sms-campaigns', businessId] });
      qc.invalidateQueries({ queryKey: ['sms-recipients', businessId] });
    },
```

- [ ] **Step 4: Show the charged amount on the result screen**

In the `if (result) { ... }` block, immediately AFTER the `{result.skipped > 0 && (...)}` block and BEFORE the "send another" button, add:
```tsx
        {result.charged > 0 && (
          <div className="rounded-2xl p-3 text-xs text-muted-foreground bg-muted/40 text-center">
            {t('sms.send.charged', { charged: result.charged.toLocaleString('ru-RU') })}
          </div>
        )}
```

- [ ] **Step 5: Compute selected template price/cost and the insufficient flag**

In `SendWizard.tsx`, after the `const canContinue = selected.size > 0;` line (just before the main `return`), add:
```tsx
  const selectedTpl = templates.find((x) => x.id === tplId) ?? null;
  const pricePerSms = selectedTpl?.price_per_sms ?? 0;
  const cost = pricePerSms * selected.size;
  const insufficient = pricePerSms > 0 && balance < cost;
```

- [ ] **Step 6: Show type label + price in the template picker rows**

In the template picker `templates.map((tt) => { ... })`, replace the single polished-text div:
```tsx
                    <div className="text-sm text-foreground whitespace-pre-wrap">{tt.polished_text}</div>
```
with a text + meta block:
```tsx
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground whitespace-pre-wrap">{tt.polished_text}</div>
                      {(tt.type || (tt.price_per_sms ?? 0) > 0) && (
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          {tt.type && (
                            <span>{t(tt.type === 'ads' ? 'sms.templates.type.ads' : 'sms.templates.type.service')}</span>
                          )}
                          {(tt.price_per_sms ?? 0) > 0 && (
                            <span>{t('sms.send.pricePerSms', { price: (tt.price_per_sms ?? 0).toLocaleString('ru-RU') })}</span>
                          )}
                        </div>
                      )}
                    </div>
```

- [ ] **Step 7: Add the cost preview + insufficient message, and gate the send button**

In the picker modal, immediately BEFORE the final send `<button ...>`, add:
```tsx
          {selectedTpl && pricePerSms > 0 && (
            <div className="text-xs text-center text-muted-foreground">
              {t('sms.send.cost', { cost: cost.toLocaleString('ru-RU') })}
              {insufficient && (
                <div className="mt-1 text-destructive">
                  {t('sms.send.insufficientBalance', { balance: balance.toLocaleString('ru-RU') })}
                </div>
              )}
            </div>
          )}
```
Then change the send button's `disabled`:
```tsx
            disabled={!tplId || send.isPending}
```
to:
```tsx
            disabled={!tplId || send.isPending || insufficient}
```

- [ ] **Step 8: Typecheck + lint**

Run: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm run typecheck && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm run lint`
Expected: only pre-existing `PersonalSchedule.tsx` typecheck errors; no new errors/lint in `SendWizard.tsx`.

- [ ] **Step 9: Commit (only this file)**

```bash
git add app/components/sms/SendWizard.tsx
git commit -m "feat(sms): show price, gate send on balance, reflect charge in SendWizard"
```

---

## Final Verification

- [ ] Backend: `cd /Users/shahzod/Projects/BLYSS/blyss-gcloud-api && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npx vitest run src/routes/sms.test.js` — all pass.
- [ ] Frontend: `cd /Users/shahzod/Projects/BLYSS/blyss-business-app && PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm run typecheck && npm run lint` — only pre-existing unrelated issues.
- [ ] Manual (optional): set a template `type:'ads', price_per_sms:500, status:'confirmed'` in Firestore; on the Send tab the picker shows "Reklama turdagi" + "500 so'm / SMS"; selecting 10 customers shows cost 5000 and disables send if balance < 5000; a successful send deducts and the profile balance card drops.

## Spec Coverage Check

- `type`/`price_per_sms` fields, null at creation → Task 1 Step 3.
- Visible only when confirmed → Task 1 Step 4 (backend gate) + Task 3/4 display.
- Type labels "Service turdagi"/"Reklama turdagi" → Task 3 Steps 3-4 (keys), 5 + Task 4 Step 6 (render).
- Balance gate `≥ price × recipients` → Task 4 Step 7 (frontend, selected) + Task 2 Step 5b (backend, eligible, 402).
- Deduct cost of actually-sent → Task 2 Step 5c/5e (charge = price × successes; increment).
- Charge excludes skipped/failed → Task 2 (eligible split pre-existing; charged uses success count) + tests Step 2.
- Owner balance regardless of sender → Task 2 Step 4 (`business_owner_id`) + 5 (read/deduct owner doc).
- Reflect charge in UI → Task 4 Steps 3-4 (store decrement + result note).
- Admin-set, no endpoint; free template = price 0 → no admin task; Task 2 Step 5b/5c guard `price > 0`.
