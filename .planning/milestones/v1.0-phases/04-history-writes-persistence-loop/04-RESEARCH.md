# Phase 4: History Writes & Persistence Loop - Research

**Researched:** 2026-03-10
**Domain:** Firestore fire-and-forget writes, FieldValue.increment, set-with-merge TTL pattern
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Write Error Handling**
- Fire-and-forget writes use `console.warn` on failure — matches existing read-function error pattern (getCommenterHistory, getPostReplies)
- No retry, no throw — write failure must never affect webhook response
- Commenter write and post reply write are independent — one failure doesn't affect the other, each has its own `.catch()`
- Both writes run in parallel via `Promise.all([...]).catch(warn)` after `replyToComment()` succeeds

**Write Scope**
- Writes happen after ALL replies — both AI-generated and template replies
- Keeps commenter history complete and post reply deduplication data accurate regardless of reply mode

**Concurrency & Atomicity**
- `comment_count` uses `FieldValue.increment(1)` — atomic server-side increment, no read-then-write race (pattern already in bookings.js)
- `first_seen_at` handled via set-with-merge — include in write payload, Firestore merge preserves existing field on subsequent comments
- `recent_replies` array: read current doc, push new reply, `slice(-8)` to cap, set back. Tiny race window acceptable — worst case one extra reply
- `set({...}, { merge: true })` for commenter doc — single code path for both first-time and returning commenters

**Write Functions Design**
- Named exports: `updateCommenterHistory(businessId, igCommenterId, username, commentText)` and `updatePostReplies(businessId, mediaId, replyText)`
- Matches read function pattern (getCommenterHistory, getPostReplies) — testable in isolation
- Specific field params, not full commentData object — explicit dependencies, easier to test
- updatePostReplies receives text and timestamp only — no reply mode metadata
- Both functions live in `instagram-webhook.js` — single-file pattern from Phases 1-3

**Call Site Pattern**
- After `replyToComment()` succeeds, before admin notification:
  ```
  Promise.all([
    updateCommenterHistory(businessId, igCommenterId, username, commentText),
    updatePostReplies(businessId, mediaId, replyMessage),
  ]).catch(e => console.warn('History write failed:', e.message));
  ```
- Guarded by `igCommenterId` — if falsy, skip BOTH writes (no commenter history or reply log for anonymous comments)

**In-Memory Fallback (SC #4)**
- No in-memory Map exists in the codebase — Phase 2 reads already hit Firestore directly
- SC #4 is automatically satisfied by Phase 4 writing to Firestore — no special handling needed, just verify in tests

### Claude's Discretion
- Exact field update payload structure for set-with-merge
- How to handle the `first_seen_at` conditional (check doc existence vs always send with merge behavior)
- Test structure and mock setup for write functions
- Whether to add `expires_at` refresh logic inline or as a helper

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

## Summary

Phase 4 closes the persistence loop by adding two fire-and-forget Firestore write functions to `instagram-webhook.js`. Phases 2-3 established reads and prompt injection; this phase writes data so those reads return real commenter history and post reply logs on all subsequent events.

The technical footprint is minimal: two named export functions mirroring the existing `getCommenterHistory` / `getPostReplies` read pair, inserted at one call site in `handleCommentEvent` after `replyToComment()` succeeds. All Firestore patterns needed already exist in the codebase (`FieldValue.increment`, `set({}, { merge: true })`, `Timestamp`). The TTL infrastructure (`expires_at` fields in `firestore.indexes.json`) is already deployed from Phase 2.

The only design judgment left to Claude's discretion is the exact field payload structure for the commenter set-with-merge write (handling `first_seen_at` correctly) and the `updatePostReplies` read-modify-write sequence for `recent_replies`. Both are straightforward given established Firestore patterns.

**Primary recommendation:** Add `updateCommenterHistory` and `updatePostReplies` as named exports in `instagram-webhook.js`, call them via a single fire-and-forget `Promise.all` after `replyToComment()`, guarded by `igCommenterId` truthiness.

---

## Standard Stack

### Core (already in project)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@google-cloud/firestore` | ^8.0.0 | Firestore SDK — writes, FieldValue, Timestamp | Already the project DB |
| `FieldValue.increment(1)` | built-in | Atomic server-side counter increment | Prevents read-then-write race on comment_count |
| `set({}, { merge: true })` | built-in | Upsert pattern — creates or updates without overwriting unset fields | Single code path for first-time and returning commenters |
| `Timestamp.now()` | built-in | Server-authoritative timestamp for `at`, `expires_at`, `last_seen_at` | Consistent with existing read-side expectations |

### No New Libraries Needed

Everything required is already imported (`db` from `../db/db.js`) or available from `@google-cloud/firestore` which is already a project dependency.

**Installation:** None required.

---

## Architecture Patterns

### Pattern 1: Fire-and-Forget Write (established in codebase)

**What:** Launch async operations after a primary action, attach a `.catch()` to suppress errors — do not await in the main flow.

**When to use:** When failures must never affect the caller (webhook response, notification sends).

**Existing example in `instagram-webhook.js` line 527:**
```javascript
// Source: src/routes/instagram-webhook.js line 527
sendTelegramMessage(ADMIN_GROUP_ID, adminMsg).catch(() => {});
```

**Phase 4 pattern (parallel writes, shared catch):**
```javascript
// Source: CONTEXT.md locked decision — call site pattern
Promise.all([
    updateCommenterHistory(businessId, igCommenterId, username, commentText),
    updatePostReplies(businessId, mediaId, replyMessage),
]).catch(e => console.warn('History write failed:', e.message));
```

Note: the outer `.catch()` on `Promise.all` only fires if one of the inner promises rejects — each function should have its own internal try/catch so failures are isolated and logged with context.

### Pattern 2: FieldValue.increment + set-with-merge Upsert (established in bookings.js)

**What:** Atomically increment a counter while merging other fields into an existing or new document.

**When to use:** Maintaining per-entity counters without read-then-write race conditions.

**Existing example in `bookings.js` lines 1505-1508:**
```javascript
// Source: src/routes/bookings.js lines 1505-1508
.set({
    visit_count: FieldValue.increment(1),
    last_visit: now
}, { merge: true })
```

**Phase 4 commenter write pattern:**
```javascript
// Derived from bookings.js pattern + CONTEXT.md field spec
import { FieldValue, Timestamp } from '@google-cloud/firestore';

export async function updateCommenterHistory(businessId, igCommenterId, username, commentText) {
    try {
        const expiresAt = Timestamp.fromDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
        await db
            .collection('businesses').doc(businessId)
            .collection('commenters').doc(String(igCommenterId))
            .set({
                username,
                comment_count: FieldValue.increment(1),
                last_seen_at: Timestamp.now(),
                last_comment_text: commentText,
                first_seen_at: Timestamp.now(),   // merge preserves existing value on subsequent writes
                expires_at: expiresAt,             // refreshed on every write — keeps active users alive
            }, { merge: true });
    } catch (e) {
        console.warn(`Instagram webhook: updateCommenterHistory failed for ${igCommenterId}:`, e.message);
    }
}
```

**Note on `first_seen_at`:** Including it in every `set({}, { merge: true })` is safe — Firestore merge preserves the existing value on subsequent writes. No conditional check-then-write needed; this is the correct pattern for "set if absent" semantics.

### Pattern 3: Read-Modify-Write for Array Cap

**What:** Read current doc, append new entry to array, cap with `slice(-8)`, set full field back.

**When to use:** Maintaining a bounded recent-items list (no Firestore native "bounded array" operation).

**Phase 4 post replies write pattern:**
```javascript
export async function updatePostReplies(businessId, mediaId, replyText) {
    try {
        const ref = db
            .collection('businesses').doc(businessId)
            .collection('instagram_post_replies').doc(String(mediaId));
        const snap = await ref.get();
        const existing = snap.exists ? (snap.data().recent_replies || []) : [];
        const expiresAt = Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
        const updated = [...existing, { text: replyText, at: Timestamp.now() }].slice(-8);
        await ref.set({
            recent_replies: updated,
            expires_at: expiresAt,
        }, { merge: true });
    } catch (e) {
        console.warn(`Instagram webhook: updatePostReplies failed for ${mediaId}:`, e.message);
    }
}
```

**Race condition:** Acceptable per locked decision — worst case one extra entry in the array, well within functional bounds. Firestore transactions would eliminate this but add latency and complexity incompatible with fire-and-forget semantics.

### Recommended Call Site Placement

```javascript
// After line 514 (replyToComment success log), before line 517 (ADMIN_GROUP_ID block)
// Only write when we have a real commenter identity
if (igCommenterId) {
    Promise.all([
        updateCommenterHistory(businessId, igCommenterId, username, commentText),
        updatePostReplies(businessId, mediaId, replyMessage),
    ]).catch(e => console.warn('History write failed:', e.message));
}
```

For static replies, `igCommenterId` and `username` and `commentText` must be resolved from `commentData` at this point — they are available for AI mode but need extraction for the static branch too.

### Anti-Patterns to Avoid

- **Awaiting history writes before responding:** Defeats fire-and-forget intent; webhook latency must not grow.
- **Throwing from write functions:** Inner functions must catch-and-warn, never throw. The outer `.catch()` on `Promise.all` is a safety net, not the primary handler.
- **Using `FieldValue.arrayUnion` for `recent_replies`:** Firestore `arrayUnion` deduplicates — two identical reply texts would collapse. Use read-modify-write to preserve all entries.
- **Placing write logic inside the `replyMode === 'ai'` branch only:** Locked decision requires writes after ALL replies (static and AI).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic counter increment | Manual read-then-increment-then-write | `FieldValue.increment(1)` | Race-free, single-operation, already used in bookings.js |
| TTL-based document expiry | Cron job querying and deleting old docs | `expires_at` field + Firestore TTL policy | Already configured in firestore.indexes.json for both collections |
| Idempotent upsert | Check-then-create logic | `set({}, { merge: true })` | Single SDK call, atomic, no read required |

**Key insight:** Every Firestore primitive needed exists in the SDK and is already used in this codebase. The implementation is pattern application, not new engineering.

---

## Common Pitfalls

### Pitfall 1: Variables Not Available in Static Branch
**What goes wrong:** `igCommenterId`, `username`, and `commentText` are extracted inside the `replyMode === 'ai'` block (`const igCommenterId = commentData.from?.id || ''`). When mode is `static`, these variables are not in scope at the call site.
**Why it happens:** AI mode extracts them to pass to `buildSystemPrompt`; static mode skips that block entirely.
**How to avoid:** Extract `igCommenterId`, `username`, and `commentText` from `commentData` at the top of `handleCommentEvent` (before the mode branch), or re-read them at the call site with `commentData.from?.id || ''` etc.
**Warning signs:** ReferenceError on static-mode webhook events.

### Pitfall 2: `first_seen_at` Incorrectly Overwritten
**What goes wrong:** If the write payload always sends `first_seen_at: Timestamp.now()`, you'd expect it to be overwritten on every comment. But `set({}, { merge: true })` preserves existing fields — it does NOT update `first_seen_at` if the field already exists.
**Why it happens:** Merge semantics: only fields absent in the document are written; existing fields are left unchanged even if a new value is provided in the `set()` call. This is actually the correct behavior for `first_seen_at`.
**How to avoid:** Simply include `first_seen_at` in every set-with-merge payload. Firestore merge handles the "set if absent" semantics automatically.
**Warning signs:** None — this works correctly by default.

### Pitfall 3: `FieldValue` and `Timestamp` Not Imported in `instagram-webhook.js`
**What goes wrong:** `instagram-webhook.js` currently imports only `{ db }` from `../db/db.js`. `FieldValue` and `Timestamp` are imported from `@google-cloud/firestore` in `bookings.js` but not yet in `instagram-webhook.js`.
**Why it happens:** Phase 2 reads don't need these — they only appeared in the write functions.
**How to avoid:** Add `import { FieldValue, Timestamp } from '@google-cloud/firestore';` to `instagram-webhook.js`.
**Warning signs:** `FieldValue is not defined` runtime error.

### Pitfall 4: Outer Promise.all.catch Masks Individual Failures
**What goes wrong:** If both inner functions catch their own errors (as they should), the outer `.catch()` on `Promise.all` never fires — which is correct. But if one function's internal try/catch is missing, a rejection propagates to `Promise.all` and the single `.catch()` message loses context about which write failed.
**Why it happens:** Relying solely on the outer catch for error visibility.
**How to avoid:** Each write function must have its own try/catch with a descriptive `console.warn`. The outer `.catch()` is a final safety net only.

### Pitfall 5: `slice(-8)` vs `slice(0, 8)`
**What goes wrong:** `slice(0, 8)` keeps the oldest 8; `slice(-8)` keeps the newest 8. The QUAL-01/QUAL-02 requirements need the most recent replies as negative examples.
**Why it happens:** Easy to confuse direction when capping arrays.
**How to avoid:** Use `slice(-8)` to keep the last 8 entries (newest).

---

## Code Examples

### updateCommenterHistory — Full Implementation

```javascript
// Source: derived from bookings.js:1505 pattern + CONTEXT.md locked decisions
import { FieldValue, Timestamp } from '@google-cloud/firestore';

/**
 * Write or update commenter history in Firestore after a reply is sent.
 * Fire-and-forget — never throws.
 *
 * @param {string} businessId
 * @param {string} igCommenterId
 * @param {string} username
 * @param {string} commentText
 */
export async function updateCommenterHistory(businessId, igCommenterId, username, commentText) {
    try {
        const expiresAt = Timestamp.fromDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
        await db
            .collection('businesses').doc(businessId)
            .collection('commenters').doc(String(igCommenterId))
            .set({
                username,
                comment_count: FieldValue.increment(1),
                last_seen_at: Timestamp.now(),
                last_comment_text: commentText,
                first_seen_at: Timestamp.now(),   // merge preserves on subsequent writes
                expires_at: expiresAt,
            }, { merge: true });
    } catch (e) {
        console.warn(`Instagram webhook: updateCommenterHistory failed for ${igCommenterId}:`, e.message);
    }
}
```

### updatePostReplies — Full Implementation

```javascript
// Source: derived from getPostReplies read pattern + CONTEXT.md locked decisions
/**
 * Append a reply text to the post's recent_replies log, capped at 8 entries.
 * Fire-and-forget — never throws.
 *
 * @param {string} businessId
 * @param {string} mediaId
 * @param {string} replyText
 */
export async function updatePostReplies(businessId, mediaId, replyText) {
    try {
        const ref = db
            .collection('businesses').doc(businessId)
            .collection('instagram_post_replies').doc(String(mediaId));
        const snap = await ref.get();
        const existing = snap.exists ? (snap.data().recent_replies || []) : [];
        const expiresAt = Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
        const updated = [...existing, { text: replyText, at: Timestamp.now() }].slice(-8);
        await ref.set({ recent_replies: updated, expires_at: expiresAt }, { merge: true });
    } catch (e) {
        console.warn(`Instagram webhook: updatePostReplies failed for ${mediaId}:`, e.message);
    }
}
```

### Call Site — Variable Extraction and Guard

```javascript
// handleCommentEvent — extract early so available in both AI and static branches
const igCommenterId = commentData.from?.id || '';
const username = commentData.from?.username || '';
const commentText = commentData.text || '';

// ... [existing mode branch and replyToComment call] ...

// After replyToComment() succeeds (line 513-514), before admin notification:
// History writes — fire-and-forget, must not delay webhook response
if (igCommenterId) {
    Promise.all([
        updateCommenterHistory(businessId, igCommenterId, username, commentText),
        updatePostReplies(businessId, mediaId, replyMessage),
    ]).catch(e => console.warn('History write failed:', e.message));
}
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|-----------------|--------|
| In-memory Map for commenter state | Firestore with TTL — survives instance restart | Cloud Run stateless instances can restart any time; in-memory state is ephemeral |
| Read-then-write counter updates | `FieldValue.increment()` | Atomic, no race on concurrent webhooks |
| Manual TTL cleanup job | Firestore native TTL via `expires_at` field policy | Already configured in firestore.indexes.json — zero maintenance |

**Deprecated/outdated:**
- In-memory fallback Maps: Never implemented (Phase 2 read directly from Firestore) — SC #4 is satisfied purely by Phase 4 writing durable data.

---

## Open Questions

1. **Variable extraction refactor scope**
   - What we know: `igCommenterId`, `username`, `commentText` are currently extracted inside the `replyMode === 'ai'` block
   - What's unclear: The planner needs to decide whether to move extractions to top-of-function or re-read from `commentData` at the call site
   - Recommendation: Move extractions to before the mode branch — cleaner, avoids duplication, and makes the call site one line of guard check

2. **TTL for `instagram_post_replies` (30 days)**
   - What we know: TTL field config is deployed; CONTEXT.md notes 30 days for post replies vs 90 days for commenters
   - What's unclear: 30-day TTL means replies on posts older than 30 days won't be logged — acceptable since QUAL-01 only needs recent-session deduplication
   - Recommendation: Confirm 30 days matches the TTL in firestore.indexes.json (it does, per existing `getPostReplies` expiry check pattern)

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.16 |
| Config file | none (package.json `"test": "vitest run"`) |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements — Test Map

Phase 4 closes PERS-02 infrastructure (write side). Success criteria map to:

| Req / SC | Behavior | Test Type | Automated Command | File Exists? |
|----------|----------|-----------|-------------------|-------------|
| SC-1: Commenter doc updated | After reply, Firestore commenter doc has incremented comment_count and updated last_seen_at | unit (mock db) | `npm test -- --grep "updateCommenterHistory"` | No — Wave 0 |
| SC-2: Post replies array capped | After reply, recent_replies array updated and capped at 8 | unit (mock db) | `npm test -- --grep "updatePostReplies"` | No — Wave 0 |
| SC-3: Writes don't delay response | Promise.all is not awaited at call site; webhook handler returns before writes complete | unit (spy on Promise.all) | `npm test -- --grep "fire-and-forget"` | No — Wave 0 |
| SC-4: Persists across restarts | Firestore is durable by design — verified by SC-1 (write exists) | unit (covered by SC-1) | `npm test -- --grep "updateCommenterHistory"` | No — Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** All tests green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/routes/instagram-webhook.write.test.js` — covers SC-1, SC-2, SC-3, SC-4 with `vi.mock('../db/db.js')` pattern matching `server.test.js` style

*(Existing `src/server.test.js` covers server-level concerns — new test file is the only gap)*

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/routes/instagram-webhook.js` — all existing patterns, exports, call sites, line numbers
- Direct code inspection: `src/routes/bookings.js` lines 21, 1505-1508 — `FieldValue.increment` + `set-with-merge` pattern
- Direct code inspection: `src/db/db.js` — Firestore instance export
- Direct code inspection: `firestore.indexes.json` — TTL fields confirmed for both `commenters` and `instagram_post_replies` collections
- Direct code inspection: `src/server.test.js` — vitest test style (describe/it/expect, vi.mock pattern)
- Direct code inspection: `package.json` — `@google-cloud/firestore@^8.0.0`, `vitest@^4.0.16`
- `.planning/phases/04-history-writes-persistence-loop/04-CONTEXT.md` — all locked decisions

### Secondary (MEDIUM confidence)
- None required — all needed information was in the codebase directly

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in project, versions confirmed in package.json
- Architecture: HIGH — patterns directly from existing codebase (bookings.js, instagram-webhook.js)
- Pitfalls: HIGH — identified from direct code inspection (variable scope in mode branch, missing imports)
- Test structure: HIGH — existing test file provides clear style guide

**Research date:** 2026-03-10
**Valid until:** 2026-06-10 (stable Firestore SDK — patterns don't change frequently)
