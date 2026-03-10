---
phase: 04-history-writes-persistence-loop
verified: 2026-03-10T17:30:00Z
status: passed
score: 4/4 must-haves verified
re_verification: false
---

# Phase 4: History Writes Persistence Loop — Verification Report

**Phase Goal:** Commenter memory and post reply log accumulate persistently across all sessions and instance restarts, closing the feedback loop that Phases 2-3 read from
**Verified:** 2026-03-10T17:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | After a comment is replied to, a Firestore commenter document exists with updated comment_count and last_seen_at | VERIFIED | `updateCommenterHistory` at line 336 calls `db.collection('businesses').doc(businessId).collection('commenters').doc(String(igCommenterId)).set({comment_count: FieldValue.increment(1), last_seen_at: Timestamp.now(), ...}, {merge: true})`; 10 unit tests confirm correct path, payload fields, and options |
| 2 | After a reply is posted, the post's recent_replies array is updated and capped at 8 entries | VERIFIED | `updatePostReplies` at line 363 performs read-modify-write appending `{text, at}` and applying `.slice(-8)`; test at line 1352 verifies 8-entry cap with oldest dropped |
| 3 | History writes happen fire-and-forget and do not delay the webhook response | VERIFIED | Lines 575-580: `Promise.all([updateCommenterHistory(...), updatePostReplies(...)]).catch(...)` — no `await` keyword; webhook handler continues to admin notify and returns before writes complete |
| 4 | Commenter history persists in Firestore (no in-memory fallback) — survives Cloud Run restarts | VERIFIED | Writes target Firestore via `db` (line 338-348); no in-memory Map exists in the codebase; `FieldValue.increment(1)` is server-side atomic; test infrastructure mocks `db.set()` confirming writes route to Firestore, not memory |

**Score:** 4/4 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/routes/instagram-webhook.js` | `updateCommenterHistory` and `updatePostReplies` named exports + call site wiring | VERIFIED | Both functions present as named exports (lines 336, 363); `FieldValue`/`Timestamp` imported at line 3; fire-and-forget block at lines 574-580 |
| `src/routes/instagram-webhook.test.js` | Unit tests covering all four success criteria | VERIFIED | 19 new tests across two describe blocks (lines 1237-1416); `updateCommenterHistory` and `updatePostReplies` imported at line 2; setCalls mock array tracks all writes |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `handleCommentEvent` (after replyToComment) | `updateCommenterHistory` + `updatePostReplies` | `Promise.all` fire-and-forget after `replyToComment()` succeeds, guarded by `igCommenterId` | WIRED | Lines 574-580: `if (igCommenterId) { Promise.all([updateCommenterHistory(...), updatePostReplies(...)]).catch(...) }` — no await |
| `updateCommenterHistory` | `businesses/{businessId}/commenters/{igCommenterId}` | `db.collection().doc().collection().doc().set({}, { merge: true })` | WIRED | Lines 338-348: exact path construction with `String(igCommenterId)` coercion; `{ merge: true }` confirmed by test at line 1287 |
| `updatePostReplies` | `businesses/{businessId}/instagram_post_replies/{mediaId}` | read-modify-write: `ref.get()` then `ref.set()` | WIRED | Lines 365-374: `ref.get()` reads existing, `slice(-8)` caps, `ref.set({recent_replies: updated, expires_at: ...}, {merge: true})` writes back |
| `igCommenterId` / `username` / `commentText` extraction | before mode branch | Variables extracted at lines 496-498, before `if (replyMode === 'ai')` at line 502 | WIRED | Lines 494-498 extract all three before mode branch — ensures history writes fire for both AI and static replies; confirmed by comment on line 494-495 |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| PERS-02 | 04-01-PLAN.md | System tracks returning commenters per business in Firestore (username, comment_count, last_seen) | SATISFIED | `updateCommenterHistory` writes `username`, `comment_count` (atomic increment), `last_seen_at` to `businesses/{id}/commenters/{id}`; `updatePostReplies` writes `recent_replies` to `businesses/{id}/instagram_post_replies/{id}`; both fire after every `replyToComment()` success |

**REQUIREMENTS.md traceability note:** REQUIREMENTS.md maps PERS-02 to Phase 2 (infrastructure) and marks it complete. Phase 4 is the write-side complement that makes the Phase 2 collections actually accumulate real data. The PLAN correctly notes it "closes the loop started by PERS-02." No orphaned requirements — PERS-02 is the only ID claimed by this phase's plan, and it is satisfied.

---

### Anti-Patterns Found

None. Scanned `src/routes/instagram-webhook.js` for:
- TODO / FIXME / PLACEHOLDER comments — none found
- Empty return stubs (`return null`, `return {}`, `return []`) — none found (the `return null` paths in `getCommenterHistory` and `getPostReplies` are intentional graceful-degradation returns from Phase 2, not stubs)
- Fire-and-forget block correctly uses no `await` on `Promise.all` at lines 576-579

---

### Human Verification Required

One item cannot be verified programmatically:

**Real Firestore persistence across Cloud Run restarts**

- **Test:** Deploy to Cloud Run. Send an Instagram comment that triggers an auto-reply. In Cloud Console, verify a document appears under `businesses/{businessId}/commenters/{igCommenterId}` with `comment_count: 1`, `last_seen_at`, `expires_at` ~90 days out. Restart the Cloud Run instance. Send another comment from the same Instagram account. Verify `comment_count` increments to 2 and a second entry appears in `instagram_post_replies`.
- **Expected:** Documents persist across the restart; `comment_count` reflects cumulative total, not reset to 1.
- **Why human:** Requires actual Cloud Run deployment and live Instagram webhook delivery. The unit tests verify the Firestore write path using mocks — they cannot confirm the live Firestore instance actually stores and retrieves data durably.

This is a confidence check, not a blocker — all code paths writing to Firestore are verified; durability is a Firestore property guaranteed by GCP.

---

### Gaps Summary

No gaps. All four must-have truths are verified. Both required artifacts exist, are substantive (no stubs), and are wired. All key links are confirmed. PERS-02 is the only declared requirement and it is satisfied.

The test suite ran: **127 tests passed, 0 failures** in `instagram-webhook.test.js`. The `server.test.js` failure is a pre-existing environment issue (missing JWT_SECRET) unrelated to Phase 4 changes.

---

**Commits verified:**
- `92e71b1` — `test(04-01): add failing tests for history write functions` (TDD RED phase)
- `ecce47a` — `feat(04-01): implement history write functions and wire fire-and-forget call site` (TDD GREEN phase)

---

_Verified: 2026-03-10T17:30:00Z_
_Verifier: Claude (gsd-verifier)_
