# Phase 4: History Writes & Persistence Loop - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Add fire-and-forget Firestore writes after each reply to close the commenter memory and post reply log loop. Phases 2-3 wired reads and prompt injection; this phase writes data so those reads return real history on subsequent comments. No new reads, no prompt changes, no schema changes.

</domain>

<decisions>
## Implementation Decisions

### Write Error Handling
- Fire-and-forget writes use `console.warn` on failure — matches existing read-function error pattern (getCommenterHistory, getPostReplies)
- No retry, no throw — write failure must never affect webhook response
- Commenter write and post reply write are independent — one failure doesn't affect the other, each has its own `.catch()`
- Both writes run in parallel via `Promise.all([...]).catch(warn)` after `replyToComment()` succeeds

### Write Scope
- Writes happen after ALL replies — both AI-generated and template replies
- Keeps commenter history complete and post reply deduplication data accurate regardless of reply mode

### Concurrency & Atomicity
- `comment_count` uses `FieldValue.increment(1)` — atomic server-side increment, no read-then-write race (pattern already in bookings.js)
- `first_seen_at` handled via set-with-merge — include in write payload, Firestore merge preserves existing field on subsequent comments
- `recent_replies` array: read current doc, push new reply, `slice(-8)` to cap, set back. Tiny race window acceptable — worst case one extra reply
- `set({...}, { merge: true })` for commenter doc — single code path for both first-time and returning commenters

### Write Functions Design
- Named exports: `updateCommenterHistory(businessId, igCommenterId, username, commentText)` and `updatePostReplies(businessId, mediaId, replyText)`
- Matches read function pattern (getCommenterHistory, getPostReplies) — testable in isolation
- Specific field params, not full commentData object — explicit dependencies, easier to test
- updatePostReplies receives text and timestamp only — no reply mode metadata
- Both functions live in `instagram-webhook.js` — single-file pattern from Phases 1-3

### Call Site Pattern
- After `replyToComment()` succeeds, before admin notification:
  ```
  Promise.all([
    updateCommenterHistory(businessId, igCommenterId, username, commentText),
    updatePostReplies(businessId, mediaId, replyMessage),
  ]).catch(e => console.warn('History write failed:', e.message));
  ```
- Guarded by `igCommenterId` — if falsy, skip BOTH writes (no commenter history or reply log for anonymous comments)

### In-Memory Fallback (SC #4)
- No in-memory Map exists in the codebase — Phase 2 reads already hit Firestore directly
- SC #4 is automatically satisfied by Phase 4 writing to Firestore — no special handling needed, just verify in tests

### Claude's Discretion
- Exact field update payload structure for set-with-merge
- How to handle the `first_seen_at` conditional (check doc existence vs always send with merge behavior)
- Test structure and mock setup for write functions
- Whether to add `expires_at` refresh logic inline or as a helper

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `FieldValue.increment(1)` pattern from `bookings.js:1506` — exact pattern for comment_count
- `getCommenterHistory()` and `getPostReplies()` in `instagram-webhook.js` — read counterparts, same Firestore paths
- `db` import from `../db/db.js` — Firestore instance
- `Timestamp` from `@google-cloud/firestore` — for `expires_at` and `at` fields

### Established Patterns
- Named export functions for Firestore operations (buildSystemPrompt, buildBusinessInfo, getCommenterHistory, getPostReplies)
- Fire-and-forget pattern: `sendTelegramMessage(...).catch(() => {})` on line 527
- `console.warn` for non-fatal errors in read functions (lines 295, 320)
- `igCommenterId` guard pattern from Phase 2 (line 448): only operate when `commentData.from?.id` is truthy

### Integration Points
- `handleCommentEvent()` line 513 — after `replyToComment()` succeeds, before admin notification (line 517)
- Firestore paths: `businesses/{businessId}/commenters/{igCommenterId}`, `businesses/{businessId}/instagram_post_replies/{mediaId}`
- Available variables at call site: `businessId`, `igCommenterId`, `commentData.from.username`, `commentData.text`, `mediaId`, `replyMessage`

</code_context>

<specifics>
## Specific Ideas

- The Promise.all fire-and-forget block should be visually distinct from the admin notification block — separate concerns, separate comment blocks
- TTL refresh (expires_at = now + 90/30 days) happens on every write, keeping active users alive

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-history-writes-persistence-loop*
*Context gathered: 2026-03-10*
