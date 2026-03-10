---
phase: 02-commenter-history-infrastructure
plan: 01
subsystem: api
tags: [firestore, instagram, webhook, tdd, ttl, personalization]

# Dependency graph
requires:
  - phase: 01-prompt-architecture-model-switch
    provides: buildSystemPrompt named export, handleCommentEvent pipeline, gpt-4.1-mini chat completions wiring
provides:
  - getCommenterHistory(businessId, igUserId): reads businesses/{id}/commenters/{igUserId}, returns null on miss/expired/error
  - getPostReplies(businessId, mediaId): reads businesses/{id}/instagram_post_replies/{mediaId}, returns null on miss/expired/error
  - handleCommentEvent uses Promise.all for 3 parallel reads (buildBusinessInfo + getCommenterHistory + getPostReplies)
  - buildSystemPrompt extended signature accepts commenterHistory and postReplies (unused in body — Phase 3 activates them)
  - TTL policy configured in firestore.indexes.json for commenters and instagram_post_replies collections
affects:
  - 03-commenter-write-pipeline (will write to commenters collection)
  - 04-personalization-injection (will pass commenterHistory and postReplies into buildSystemPrompt body)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Graceful degradation: Firestore read functions catch all errors and return null — webhook never crashes"
    - "TTL lag guard: expires_at.toDate() < new Date() check before returning cached data"
    - "Promise.all parallelism: all three reads (buildBusinessInfo, getCommenterHistory, getPostReplies) run concurrently"
    - "String() coercion on Firestore doc IDs to prevent type mismatch bugs"
    - "Extended function signature: new params destructured but unused in body (Phase N+1 pattern)"

key-files:
  created: []
  modified:
    - src/routes/instagram-webhook.js
    - src/routes/instagram-webhook.test.js
    - firestore.indexes.json

key-decisions:
  - "getCommenterHistory and getPostReplies are named exports — testable in isolation without mocking handleCommentEvent"
  - "igCommenterId guard: getCommenterHistory only called when commentData.from?.id is truthy — avoids unnecessary reads for anonymous comments"
  - "TTL fieldOverrides configured in firestore.indexes.json with ttl: true and indexes: [] — relies on Firestore auto-delete, not manual cleanup"
  - "commenterHistory and postReplies passed through buildSystemPrompt call site but NOT used in body — clean Phase 2/3 boundary"

patterns-established:
  - "Pattern: Graceful-degradation Firestore reads — try/catch + return null, never throws, logged via console.warn"
  - "Pattern: String() doc ID coercion — applied to all user-provided IDs before Firestore .doc() calls"
  - "Pattern: Phase boundary params — new params added to function signature before being used in body"

requirements-completed: [PERS-02]

# Metrics
duration: 7min
completed: 2026-03-10
---

# Phase 2 Plan 01: Commenter History Infrastructure Summary

**Two Firestore read functions (getCommenterHistory, getPostReplies) wired into handleCommentEvent via Promise.all with TTL policy configured, zero-latency foundation for Phase 3 personalization**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-03-10T10:49:00Z
- **Completed:** 2026-03-10T10:56:11Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files modified:** 3

## Accomplishments

- Added `getCommenterHistory(businessId, igUserId)` named export with TTL lag guard and graceful degradation (catch + return null)
- Added `getPostReplies(businessId, mediaId)` named export with same contract, reads `instagram_post_replies` subcollection
- Extended `handleCommentEvent` AI branch to use `Promise.all([buildBusinessInfo, getCommenterHistory, getPostReplies])` — all three reads run concurrently with zero added latency
- Extended `buildSystemPrompt` signature to accept `commenterHistory` and `postReplies` params (received but ignored in Phase 2 body — Phase 3 injects them into the prompt)
- Configured TTL auto-delete policy in `firestore.indexes.json` for both new collections
- 14 new unit tests covering: exists/not-exists, expired, valid, Firestore error, String() coercion, and buildSystemPrompt signature compatibility

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing tests for commenter history and post reply reads** - `940c4cf` (test)
2. **Task 2 (GREEN): Implement getCommenterHistory, getPostReplies, Promise.all, TTL** - `134193f` (feat)

_TDD plan: RED commit then GREEN commit_

## Files Created/Modified

- `src/routes/instagram-webhook.js` - Added getCommenterHistory, getPostReplies exports; extended Promise.all in handleCommentEvent; extended buildSystemPrompt signature
- `src/routes/instagram-webhook.test.js` - Extended Firestore mock with docSnapOverrides map for per-test snapshot control; 14 new tests for the two functions and buildSystemPrompt signature
- `firestore.indexes.json` - Added TTL fieldOverrides for commenters.expires_at and instagram_post_replies.expires_at

## Decisions Made

- Named exports chosen over internal functions — makes `getCommenterHistory` and `getPostReplies` directly unit-testable without routing through `handleCommentEvent`
- `igCommenterId` guard: only calls `getCommenterHistory` when `commentData.from?.id` is truthy — avoids unnecessary Firestore reads for anonymous/unknown commenters
- `commenterHistory` and `postReplies` passed through `buildSystemPrompt` call site now (Phase 2) but only used in body in Phase 3 — clean phase boundary, no null-checks needed inside `buildSystemPrompt`

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None. The Firestore mock in tests needed a `docSnapOverrides` map approach (module-level mutable object) to allow per-test snapshot configuration without redefining the entire `vi.mock` block — this was anticipated in the plan's interface notes.

## User Setup Required

None — no external service configuration required. TTL policy is deployed via `firebase deploy --only firestore` using the updated `firestore.indexes.json`.

## Next Phase Readiness

- `getCommenterHistory` and `getPostReplies` are in place and tested — Phase 3 can call them and inject their output into `buildSystemPrompt`'s body
- `buildSystemPrompt` already accepts `commenterHistory` and `postReplies` parameters — Phase 3 only needs to add the injection logic inside the function body
- Firestore TTL is configured — data written by Phase 3's write pipeline will auto-expire

---
*Phase: 02-commenter-history-infrastructure*
*Completed: 2026-03-10*
