# Phase 2: Commenter History Infrastructure - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Design and implement Firestore subcollections for commenter memory and post reply log. Wire parallel reads into the webhook pipeline. Reply behavior remains unchanged — reads are fetched but not injected into the prompt (that's Phase 3).

</domain>

<decisions>
## Implementation Decisions

### Commenter History Schema
- Path: `businesses/{businessId}/commenters/{igUserId}`
- Document ID: Instagram user ID (stable across username changes)
- Fields: `username`, `comment_count`, `first_seen_at` (Timestamp), `last_seen_at` (Timestamp), `last_comment_text` (string), `expires_at` (Timestamp, now + 90 days)
- Latest comment text only — no comment history array
- Username overwritten silently on each comment (igUserId is the stable identifier)

### Post Reply Log Schema
- Path: `businesses/{businessId}/instagram_post_replies/{mediaId}` (separate subcollection, not on instagram_post_settings)
- Fields: `recent_replies` (array of `{ text, at }` objects, capped at 8), `expires_at` (Timestamp, now + 30 days)
- Full reply text stored — enables Phase 3 to detect opener repetition and broader style patterns
- Cap enforced on write (Phase 4): trim to 8 most recent when appending

### TTL / Cleanup Strategy
- Both collections use Firestore TTL policy on `expires_at` field — zero cron code needed
- Commenter docs: 90-day TTL, refreshed on each comment
- Post reply docs: 30-day TTL, refreshed on each reply
- TTL policies configured in this phase (gcloud CLI or firestore config) so cleanup works from day one
- Expired-but-not-yet-deleted docs (up to 24h Firestore delay): treat as first-timer / no data — check `expires_at < now` on read

### Read Integration Pattern
- Both reads (`getCommenterHistory`, `getPostReplies`) execute in parallel with `buildBusinessInfo()` via `Promise.all` — zero additional latency
- Functions return `null` when no data exists (first-time commenter, no prior replies) — falsy check is idiomatic
- Both functions live in `instagram-webhook.js` alongside `buildSystemPrompt()` and `buildBusinessInfo()` — matches existing single-file pattern
- `commenterHistory` and `postReplies` params added to `buildSystemPrompt()` signature now but ignored — Phase 3 adds prompt sections without signature change

### Claude's Discretion
- Exact Firestore index configuration details
- Error handling strategy for failed reads (graceful degradation vs throw)
- Test structure for new functions

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildBusinessInfo()` in `instagram-webhook.js` — already parallelized with `Promise.all`, pattern to follow for new reads
- `db` import from `../db/db.js` — Firestore instance, used throughout
- `buildSystemPrompt()` — Phase 1 named export, will receive new params

### Established Patterns
- Firestore subcollections: `businesses/{id}/services`, `businesses/{id}/employees`, `businesses/{id}/instagram_post_settings/{mediaId}`
- All Firestore reads use `db.collection(...).doc(...).get()` chains
- Named exports for testable functions (`buildSystemPrompt`, `buildBusinessInfo`)
- Vitest with 64 existing tests in `instagram-webhook.test.js`

### Integration Points
- `handleCommentEvent()` — where Promise.all lives, add new reads here
- `buildSystemPrompt()` — add `commenterHistory` and `postReplies` params (ignored for now)
- `commentData.from.id` — Instagram user ID, available in webhook payload for commenter lookup
- `mediaId` — already extracted in handler, used for post reply log lookup

</code_context>

<specifics>
## Specific Ideas

- Commenter doc path mirrors existing subcollection patterns (`businesses/{id}/commenters/{igUserId}`)
- Reply log deliberately separated from `instagram_post_settings` to keep concerns clean
- TTL field pattern (`expires_at` refreshed on each interaction) ensures active users never expire while inactive ones auto-clean

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-commenter-history-infrastructure*
*Context gathered: 2026-03-10*
