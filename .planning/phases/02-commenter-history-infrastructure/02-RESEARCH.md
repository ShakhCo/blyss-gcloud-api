# Phase 2: Commenter History Infrastructure - Research

**Researched:** 2026-03-10
**Domain:** Firestore subcollections, TTL policies, parallel async reads, Node.js/Express webhook pipeline
**Confidence:** HIGH

## Summary

Phase 2 adds two new Firestore subcollections (`commenters` and `instagram_post_replies`) and wires read functions for both into the existing `handleCommentEvent` pipeline via `Promise.all`. The read functions are added now but their data is not injected into the prompt yet — Phase 3 does that. The implementation is entirely within `src/routes/instagram-webhook.js` (matching the Phase 1 single-file pattern) and does not require new libraries.

The highest-risk area is Firestore TTL policy configuration. The official Google docs confirm a critical behavioral detail: expired-but-not-yet-deleted documents (up to 24h lag) remain fully visible in queries and lookups. This means the `expires_at < now` guard on read is mandatory, not optional — without it, stale records would be returned as valid data until Firestore actually deletes them. The TTL policy setup (gcloud CLI or `firestore.indexes.json` fieldOverride) is a one-time infrastructure step this phase owns.

The parallel-reads integration is low-risk. The pattern already exists in `buildBusinessInfo()` — `Promise.all([getCommenterHistory(...), getPostReplies(...), buildBusinessInfo(...)])` extends it trivially. Both new functions return `null` on missing data, matching the falsy-check idiom used throughout the file.

**Primary recommendation:** Two new named-export functions (`getCommenterHistory`, `getPostReplies`) + extend the `Promise.all` in `handleCommentEvent` + add `commenterHistory`/`postReplies` params to `buildSystemPrompt` (ignored for now) + configure TTL policies via `firestore.indexes.json` fieldOverrides.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Commenter History Schema**
- Path: `businesses/{businessId}/commenters/{igUserId}`
- Document ID: Instagram user ID (stable across username changes)
- Fields: `username`, `comment_count`, `first_seen_at` (Timestamp), `last_seen_at` (Timestamp), `last_comment_text` (string), `expires_at` (Timestamp, now + 90 days)
- Latest comment text only — no comment history array
- Username overwritten silently on each comment (igUserId is the stable identifier)

**Post Reply Log Schema**
- Path: `businesses/{businessId}/instagram_post_replies/{mediaId}` (separate subcollection, not on instagram_post_settings)
- Fields: `recent_replies` (array of `{ text, at }` objects, capped at 8), `expires_at` (Timestamp, now + 30 days)
- Full reply text stored — enables Phase 3 to detect opener repetition and broader style patterns
- Cap enforced on write (Phase 4): trim to 8 most recent when appending

**TTL / Cleanup Strategy**
- Both collections use Firestore TTL policy on `expires_at` field — zero cron code needed
- Commenter docs: 90-day TTL, refreshed on each comment
- Post reply docs: 30-day TTL, refreshed on each reply
- TTL policies configured in this phase (gcloud CLI or firestore config) so cleanup works from day one
- Expired-but-not-yet-deleted docs (up to 24h Firestore delay): treat as first-timer / no data — check `expires_at < now` on read

**Read Integration Pattern**
- Both reads (`getCommenterHistory`, `getPostReplies`) execute in parallel with `buildBusinessInfo()` via `Promise.all` — zero additional latency
- Functions return `null` when no data exists (first-time commenter, no prior replies) — falsy check is idiomatic
- Both functions live in `instagram-webhook.js` alongside `buildSystemPrompt()` and `buildBusinessInfo()` — matches existing single-file pattern
- `commenterHistory` and `postReplies` params added to `buildSystemPrompt()` signature now but ignored — Phase 3 adds prompt sections without signature change

### Claude's Discretion
- Exact Firestore index configuration details
- Error handling strategy for failed reads (graceful degradation vs throw)
- Test structure for new functions

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PERS-02 | System tracks returning commenters per business in Firestore (username, comment_count, last_seen) | Schema and read path fully defined in CONTEXT.md; TTL policy config documented below; parallel read pattern already exists in buildBusinessInfo() |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@google-cloud/firestore` | ^8.0.0 (already installed) | Firestore reads: `doc().get()`, `Timestamp` | Already in codebase; `db` import available in instagram-webhook.js |
| `Promise.all` | Node built-in | Parallel async reads | Already used in `buildBusinessInfo()` — same pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| gcloud CLI / firestore.indexes.json | infrastructure | TTL policy configuration | One-time setup; not a runtime library |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Firestore TTL (`expires_at` field) | Cron job cleanup | TTL is zero maintenance, no cron code; cron adds operational burden. Decision is locked. |
| `doc().get()` single-doc reads | Collection queries | Single-doc reads are O(1) for known doc IDs (igUserId, mediaId) — no index needed, fastest path |

**No new packages to install.** All reads use the existing `db` instance from `../db/db.js`.

## Architecture Patterns

### Files Changed
```
src/routes/instagram-webhook.js   ← only file modified
  ├── getCommenterHistory(businessId, igUserId)   ← new exported function
  ├── getPostReplies(businessId, mediaId)          ← new exported function
  ├── buildSystemPrompt({ ...existing, commenterHistory, postReplies })  ← signature extended, params ignored
  └── handleCommentEvent(...)     ← extend Promise.all to include both new reads

firestore.indexes.json            ← add TTL fieldOverrides for both new collections
```

### Pattern 1: getCommenterHistory Function
**What:** Single-document read from `businesses/{businessId}/commenters/{igUserId}`. Returns document data if found and not expired, otherwise `null`.
**When to use:** Called in `handleCommentEvent` for every AI-mode comment event.

```javascript
// Source: established pattern in this codebase; @google-cloud/firestore v8 API
export async function getCommenterHistory(businessId, igUserId) {
    try {
        const snap = await db
            .collection('businesses').doc(businessId)
            .collection('commenters').doc(String(igUserId))
            .get();

        if (!snap.exists) return null;

        const data = snap.data();
        // Guard: treat expired-but-not-yet-deleted docs as no data
        // Firestore TTL deletion has up to 24h lag — check manually
        if (data.expires_at && data.expires_at.toDate() < new Date()) return null;

        return data; // { username, comment_count, first_seen_at, last_seen_at, last_comment_text, expires_at }
    } catch (e) {
        console.warn(`Instagram webhook: getCommenterHistory failed for ${igUserId}:`, e.message);
        return null; // Graceful degradation — never throw from read helpers
    }
}
```

### Pattern 2: getPostReplies Function
**What:** Single-document read from `businesses/{businessId}/instagram_post_replies/{mediaId}`. Returns document data if found and not expired, otherwise `null`.

```javascript
// Source: established pattern in this codebase; @google-cloud/firestore v8 API
export async function getPostReplies(businessId, mediaId) {
    try {
        const snap = await db
            .collection('businesses').doc(businessId)
            .collection('instagram_post_replies').doc(String(mediaId))
            .get();

        if (!snap.exists) return null;

        const data = snap.data();
        // Guard: treat expired-but-not-yet-deleted docs as no data
        if (data.expires_at && data.expires_at.toDate() < new Date()) return null;

        return data; // { recent_replies: [{ text, at }], expires_at }
    } catch (e) {
        console.warn(`Instagram webhook: getPostReplies failed for ${mediaId}:`, e.message);
        return null;
    }
}
```

### Pattern 3: Extending Promise.all in handleCommentEvent
**What:** Add both new reads alongside the existing `buildBusinessInfo()` call.
**When to use:** Inside the `replyMode === 'ai'` branch of `handleCommentEvent`.

The current code (line 370) calls `buildBusinessInfo` by itself with a single `await`. The new pattern wraps it with the two new reads:

```javascript
// Before (Phase 1 state):
const businessInfo = await buildBusinessInfo(businessId, businessData, bookingLink);

// After (Phase 2):
const igCommenterId = commentData.from?.id || '';
const [businessInfo, commenterHistory, postReplies] = await Promise.all([
    buildBusinessInfo(businessId, businessData, bookingLink),
    igCommenterId ? getCommenterHistory(businessId, igCommenterId) : Promise.resolve(null),
    getPostReplies(businessId, mediaId),
]);
```

Both new reads execute concurrently with `buildBusinessInfo` — zero extra wall-clock time compared to Phase 1.

### Pattern 4: buildSystemPrompt Signature Extension
**What:** Add `commenterHistory` and `postReplies` to the param destructuring. Both are ignored (not yet used to build prompt text). Signature change here so Phase 3 can add prompt sections without touching the call site.

```javascript
// Add to function signature — no changes to function body needed
export function buildSystemPrompt({
    // ... all existing params ...
    commenterHistory,  // null | { username, comment_count, first_seen_at, last_seen_at, last_comment_text }
    postReplies,       // null | { recent_replies: [{ text, at }] }
}) {
    // ... existing body unchanged ...
    // commenterHistory and postReplies are received but not used yet (Phase 3 adds sections)
}
```

Call site in `handleCommentEvent` passes them through:
```javascript
const systemPrompt = buildSystemPrompt({
    // ... all existing args ...
    commenterHistory,
    postReplies,
});
```

### Pattern 5: Firestore TTL Configuration via firestore.indexes.json
**What:** Add `fieldOverrides` entries for the `expires_at` field in both new collection groups. This configures Firestore to automatically delete documents when the `expires_at` timestamp is in the past (with up to 24h lag).

```json
{
  "fieldOverrides": [
    {
      "collectionGroup": "commenters",
      "fieldPath": "expires_at",
      "ttl": true,
      "indexes": []
    },
    {
      "collectionGroup": "instagram_post_replies",
      "fieldPath": "expires_at",
      "ttl": true,
      "indexes": []
    }
  ]
}
```

Append these two entries to the existing `fieldOverrides` array in `firestore.indexes.json`. Deploy with:
```bash
firebase deploy --only firestore:indexes
```

Alternative gcloud CLI approach (if not using Firebase CLI):
```bash
gcloud firestore fields ttls update expires_at \
  --collection-group=commenters \
  --enable-ttl

gcloud firestore fields ttls update expires_at \
  --collection-group=instagram_post_replies \
  --enable-ttl
```

### Recommended Project Structure
```
src/routes/instagram-webhook.js
  ├── buildSystemPrompt()          ← existing; add commenterHistory/postReplies to signature
  ├── buildBusinessInfo()          ← existing; unchanged
  ├── getCommenterHistory()        ← NEW named export
  ├── getPostReplies()             ← NEW named export
  └── handleCommentEvent()         ← extend Promise.all

firestore.indexes.json             ← add 2 TTL fieldOverride entries
src/routes/instagram-webhook.test.js  ← add tests for getCommenterHistory, getPostReplies
```

### Anti-Patterns to Avoid
- **Not guarding against TTL lag:** Expired docs remain visible for up to 24h. Without the `expires_at < now` check, stale commenter data from a 91-day-old record would be returned as valid. Always check on read.
- **Throwing from read helpers:** A Firestore read failure must never crash the webhook handler. Read helpers catch and return `null`, allowing the handler to continue with no personalization data.
- **Sequential placement of new reads:** `await getCommenterHistory(...)` followed by `await getPostReplies(...)` followed by `await buildBusinessInfo(...)` would add ~2 round trips of latency (failing the 200ms budget). Always use `Promise.all`.
- **Conditional guard skipping igCommenterId check:** If `commentData.from?.id` is absent (malformed webhook), passing `undefined` to `getCommenterHistory` would query the wrong doc path. Guard with `igCommenterId ? ... : Promise.resolve(null)`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Document expiry cleanup | Cron job that scans and deletes | Firestore TTL policy on `expires_at` | Zero maintenance, runs server-side; cron adds code + scheduling complexity |
| Expired doc detection | Re-implementing TTL logic in code | `expires_at < new Date()` guard on read + TTL policy | TTL handles physical deletion; guard handles the 24h race window |
| Parallel reads | Custom queue or sequential | `Promise.all([...])` | Standard Node.js; already established in `buildBusinessInfo` |

**Key insight:** Firestore single-document reads (`.doc(id).get()`) require no index and return in a single round trip. For known IDs (igUserId, mediaId), this is always the correct approach — never query a collection when you can look up by document ID.

## Common Pitfalls

### Pitfall 1: Expired-But-Visible Documents
**What goes wrong:** A commenter's record has `expires_at` in the past, but Firestore hasn't deleted it yet (up to 24h lag). The read function returns the stale document and treats the person as a known returning commenter with old data.
**Why it happens:** Firestore TTL deletion is asynchronous and has up to 24h delay per official documentation.
**How to avoid:** Always check `if (data.expires_at && data.expires_at.toDate() < new Date()) return null` after reading a document.
**Warning signs:** Long-inactive commenters being treated as returning customers with stale comment counts.

### Pitfall 2: Missing `from.id` in Webhook Payload
**What goes wrong:** `commentData.from?.id` is `undefined` for some webhook events. Passing `undefined` as the Firestore document ID queries a doc path like `commenters/undefined` and either returns null (if it doesn't exist) or returns garbage (if an `undefined`-keyed doc was created by a bug).
**Why it happens:** The `from` field in Meta webhooks is not guaranteed on all event subtypes.
**How to avoid:** Guard: `igCommenterId ? getCommenterHistory(...) : Promise.resolve(null)`.

### Pitfall 3: TTL Policy Not Deployed Before Data Starts Writing
**What goes wrong:** Phase 4 writes `expires_at` values, but the TTL policy is not yet active. Documents accumulate and never get cleaned up.
**Why it happens:** TTL policy must be explicitly configured — writing an `expires_at` field without the policy does nothing.
**How to avoid:** Configure TTL in this phase (Phase 2) via `firestore.indexes.json` deployment. TTL policies take ~10 minutes to activate on an empty database.

### Pitfall 4: Wrong String Conversion for Document IDs
**What goes wrong:** `igUserId` (from `entry.id` in the webhook) and `mediaId` (from `commentData.media.id`) may be numeric strings or numbers. Firestore document IDs must be strings, but inconsistent types cause lookup misses when write and read use different types.
**Why it happens:** JavaScript coerces numbers and strings in unexpected ways. A write using number `12345` creates doc ID `"12345"`, but a read using string `"12345"` should work — but subtle bugs happen when one side wraps in `String()` and the other doesn't.
**How to avoid:** Always wrap IDs in `String()` at both read time and write time: `doc(String(igUserId))`, `doc(String(mediaId))`.

### Pitfall 5: Adding New Reads Outside the Promise.all
**What goes wrong:** Developer adds `const commenterHistory = await getCommenterHistory(...)` before the existing `buildBusinessInfo` call rather than restructuring the `Promise.all`. This adds latency equal to one Firestore round trip (~50-100ms) and violates the 200ms budget constraint.
**Why it happens:** Sequential is simpler to write; the `Promise.all` restructure is easy to overlook.
**How to avoid:** The `Promise.all` wrapping `buildBusinessInfo` must include both new reads. Test this explicitly.

## Code Examples

### Full Promise.all Integration in handleCommentEvent
```javascript
// Source: extends existing buildBusinessInfo() pattern in instagram-webhook.js
// Place inside the replyMode === 'ai' branch, replacing the single buildBusinessInfo await

const igCommenterId = commentData.from?.id || '';
const [businessInfo, commenterHistory, postReplies] = await Promise.all([
    buildBusinessInfo(businessId, businessData, bookingLink),
    igCommenterId
        ? getCommenterHistory(businessId, igCommenterId)
        : Promise.resolve(null),
    getPostReplies(businessId, mediaId),
]);
```

### TTL fieldOverrides in firestore.indexes.json
```json
{
  "indexes": [...],
  "fieldOverrides": [
    // ... existing entries ...
    {
      "collectionGroup": "commenters",
      "fieldPath": "expires_at",
      "ttl": true,
      "indexes": []
    },
    {
      "collectionGroup": "instagram_post_replies",
      "fieldPath": "expires_at",
      "ttl": true,
      "indexes": []
    }
  ]
}
```

### Expected Document Shape (commenter)
```javascript
// businesses/{businessId}/commenters/{igUserId}
{
    username: "john_doe",           // string — overwritten on each comment
    comment_count: 3,               // number — incremented on each comment (Phase 4)
    first_seen_at: Timestamp,       // set once on first comment (Phase 4)
    last_seen_at: Timestamp,        // updated on each comment (Phase 4)
    last_comment_text: "Zo'r!",     // string — latest comment only (Phase 4)
    expires_at: Timestamp,          // now + 90 days, refreshed on each comment (Phase 4)
}
```

### Expected Document Shape (post reply log)
```javascript
// businesses/{businessId}/instagram_post_replies/{mediaId}
{
    recent_replies: [
        { text: "Rahmat, har doim xush kelibsiz!", at: Timestamp },
        { text: "Raxmat! Sizni kutamiz 😊", at: Timestamp },
        // ... up to 8 entries, newest last (or newest first — Phase 4 decides ordering)
    ],
    expires_at: Timestamp,  // now + 30 days, refreshed on each reply (Phase 4)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No commenter tracking | `businesses/{id}/commenters/{igUserId}` subcollection | Phase 2 | Enables returning-commenter detection in Phase 3 |
| No reply deduplication data | `businesses/{id}/instagram_post_replies/{mediaId}` subcollection | Phase 2 | Enables opener variety enforcement in Phase 3 |
| `buildBusinessInfo()` alone in Promise.all | Three parallel reads: businessInfo + commenterHistory + postReplies | Phase 2 | Zero latency increase — all reads concurrent |

**Note:** Phase 2 only wires reads. Writes (setting `comment_count`, `first_seen_at`, etc.) are Phase 4. The schemas are defined now so tests can verify the read shape is correct, but documents won't exist in Firestore until Phase 4 writes them.

## Open Questions

1. **TTL fieldOverrides `indexes: []` vs omitting `indexes` key**
   - What we know: The `firestore.indexes.json` fieldOverrides format requires a `ttl: true` flag. The `indexes` key in fieldOverrides controls single-field index exemptions.
   - What's unclear: Whether `"indexes": []` (empty array) is needed alongside `"ttl": true` or whether the key can be omitted. Existing entries in the file (e.g., `instagram_connection`) use `indexes` with specific configurations.
   - Recommendation: Use `"indexes": []` to explicitly disable automatic single-field indexes for the `expires_at` field (no queries on this field are needed — only TTL). This matches the pattern of other fieldOverride entries.

2. **Test coverage for reads that don't exist yet (no write in Phase 2)**
   - What we know: Phase 2 adds read functions, but Phase 4 adds writes. In production, these reads return `null` for all documents until Phase 4 ships.
   - What's unclear: Whether the test should mock a real document shape (verifying read parsing) or only test the null-return path.
   - Recommendation: Test both: (a) mock a valid document and verify the function returns correct fields, (b) mock an empty snapshot and verify null return, (c) mock an expired document and verify null return. This validates the schema shape and the TTL guard.

3. **Ordering of `recent_replies` array (newest first vs newest last)**
   - What we know: Phase 3 reads this array for prompt injection. Phase 4 writes it.
   - What's unclear: Which ordering makes Phase 3 prompt injection more natural. Phase 2 only reads — this ordering decision belongs to Phase 4 writes.
   - Recommendation: Defer to Phase 4. Phase 2 `getPostReplies` returns the array as stored. Document the expected ordering in Phase 4 context.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.16 (confirmed in package.json) |
| Config file | none — default vitest config; `npm test` runs `vitest run` |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PERS-02 (read path) | `getCommenterHistory` returns null when doc doesn't exist | unit (mock Firestore) | `npm test` | ❌ Wave 0 |
| PERS-02 (read path) | `getCommenterHistory` returns null when doc is expired | unit (mock Firestore) | `npm test` | ❌ Wave 0 |
| PERS-02 (read path) | `getCommenterHistory` returns doc data when doc exists and not expired | unit (mock Firestore) | `npm test` | ❌ Wave 0 |
| PERS-02 (read path) | `getPostReplies` returns null when doc doesn't exist | unit (mock Firestore) | `npm test` | ❌ Wave 0 |
| PERS-02 (read path) | `getPostReplies` returns null when doc is expired | unit (mock Firestore) | `npm test` | ❌ Wave 0 |
| PERS-02 (read path) | `getPostReplies` returns `recent_replies` array when doc exists and not expired | unit (mock Firestore) | `npm test` | ❌ Wave 0 |
| PERS-02 (parallel) | `handleCommentEvent` issues all three reads (businessInfo + commenterHistory + postReplies) via Promise.all | unit (mock all) | `npm test` | ❌ Wave 0 |
| PERS-02 (no regression) | Reply output is identical with null commenterHistory and postReplies vs Phase 1 output | unit (existing tests still pass) | `npm test` | ✅ existing 64 tests |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green (all 64 existing + new Phase 2 tests) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/routes/instagram-webhook.test.js` — add `getCommenterHistory` and `getPostReplies` test cases; update Firestore mock to support `.collection('commenters').doc(id).get()` and `.collection('instagram_post_replies').doc(id).get()` paths
- [ ] `src/routes/instagram-webhook.test.js` — add test verifying `commenterHistory` and `postReplies` are passed to `buildSystemPrompt` without changing prompt output (regression guard for Phase 3)

*(Existing test infrastructure covers all other requirements. No new files needed.)*

## Sources

### Primary (HIGH confidence)
- `src/routes/instagram-webhook.js` (read directly) — existing Promise.all pattern in `buildBusinessInfo`, `db` import pattern, `handleCommentEvent` structure
- `src/routes/instagram-webhook.test.js` (read directly) — existing Firestore mock structure, vitest patterns
- `.planning/phases/02-commenter-history-infrastructure/02-CONTEXT.md` (read directly) — all locked decisions
- `firestore.indexes.json` (read directly) — existing fieldOverrides format showing current convention
- `package.json` (read directly) — `@google-cloud/firestore` ^8.0.0 confirmed, vitest ^4.0.16 confirmed

### Secondary (MEDIUM confidence)
- [Google Cloud Firestore TTL documentation](https://docs.cloud.google.com/firestore/native/docs/ttl) — confirmed: (1) expired docs remain visible until physical deletion; (2) gcloud CLI command syntax; (3) one TTL field per collection group limit; (4) data typically deleted within 24h
- WebSearch result confirming `firestore.indexes.json` supports `"ttl": true` in fieldOverrides — cross-reference with official docs

### Tertiary (LOW confidence)
- TTL fieldOverrides `"indexes": []` exact syntax when combined with `"ttl": true` — not directly shown in official docs for the combined case; derived from existing file patterns. Verify with `firebase deploy --only firestore:indexes` dry run or Firebase console.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; existing `db` import and Promise.all pattern fully confirmed
- Architecture: HIGH — patterns directly derived from existing code in same file; single-file change
- TTL configuration: MEDIUM — gcloud CLI command and fieldOverrides `ttl:true` confirmed from official docs; exact combined `indexes: []` syntax is inferred
- Pitfalls: HIGH — TTL lag behavior verified from official docs; other pitfalls derived from code inspection

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable domain; Firestore TTL API is not fast-moving)
