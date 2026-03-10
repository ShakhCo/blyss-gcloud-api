---
phase: 04-history-writes-persistence-loop
plan: 01
subsystem: database
tags: [firestore, instagram, webhook, tdd, history, persistence]

# Dependency graph
requires:
  - phase: 02-commenter-history-infrastructure
    provides: getCommenterHistory and getPostReplies read functions + Firestore collection layout
  - phase: 03-memory-variety-in-prompt
    provides: buildSystemPrompt consuming commenterHistory/postReplies for prompt injection
provides:
  - updateCommenterHistory named export: writes commenter doc with FieldValue.increment(1), 90-day TTL, merge:true
  - updatePostReplies named export: read-modify-write with slice(-8) cap, 30-day TTL
  - Fire-and-forget history writes wired into handleCommentEvent after replyToComment() succeeds
affects:
  - Any phase reading commenters or instagram_post_replies collections (data now actually accumulates)

# Tech tracking
tech-stack:
  added: ["FieldValue, Timestamp from @google-cloud/firestore (imported in webhook route)"]
  patterns:
    - "Fire-and-forget Promise.all guarded by igCommenterId — writes never block webhook response"
    - "merge:true on commenter set — first_seen_at preserved across subsequent writes, comment_count atomically incremented"
    - "read-modify-write pattern for post replies — slice(-8) keeps newest 8 entries"
    - "TDD red-green with vi.mock extension — setCalls array + set:key Error override pattern for write mocks"

key-files:
  created: []
  modified:
    - src/routes/instagram-webhook.js
    - src/routes/instagram-webhook.test.js

key-decisions:
  - "updateCommenterHistory uses merge:true so first_seen_at is preserved on subsequent writes — FieldValue.increment(1) is atomic, no race conditions"
  - "updatePostReplies uses read-modify-write (not arrayUnion) to enforce slice(-8) cap — arrayUnion has no length limit"
  - "igCommenterId/username/commentText extracted before mode branch — history writes apply to both AI and static reply modes"
  - "fire-and-forget Promise.all guarded by igCommenterId check — no writes for anonymous comments, outer .catch() prevents unhandled rejection"

patterns-established:
  - "Write mock extension: setCalls array + set:key prefix in docSnapOverrides for Error simulation"
  - "vi.mock('@google-cloud/firestore') with sentinel objects — __type fields enable structural equality assertions"

requirements-completed: [PERS-02]

# Metrics
duration: 20min
completed: 2026-03-10
---

# Phase 4 Plan 1: History Writes Persistence Loop Summary

**Fire-and-forget Firestore writes after each reply — updateCommenterHistory (90-day TTL, atomic increment) and updatePostReplies (8-entry cap) wired into handleCommentEvent, completing the commenter memory feedback loop**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-03-10T17:02:00Z
- **Completed:** 2026-03-10T17:24:43Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 2

## Accomplishments

- Implemented `updateCommenterHistory`: atomic `comment_count` increment via `FieldValue.increment(1)`, server-authoritative `Timestamp.now()` timestamps, 90-day TTL refresh on every write, `merge:true` so `first_seen_at` is preserved across subsequent writes
- Implemented `updatePostReplies`: read-modify-write appending new reply to `recent_replies`, `slice(-8)` cap to keep newest 8 entries, 30-day TTL
- Wired both writes into `handleCommentEvent` as a fire-and-forget `Promise.all` after `replyToComment()` succeeds, guarded by `igCommenterId` — no blocking, no delay to webhook response
- Moved `igCommenterId`/`username`/`commentText` extraction before the mode branch — writes now apply to both AI and static reply modes
- Added 19 new unit tests covering all success criteria (correct paths, payload fields, TTL, cap-at-8, error suppression)

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — Write failing tests** - `92e71b1` (test)
2. **Task 2: GREEN — Implement functions and wire call site** - `ecce47a` (feat)

## Files Created/Modified

- `src/routes/instagram-webhook.js` — Added `FieldValue`/`Timestamp` import, `updateCommenterHistory` and `updatePostReplies` named exports, call-site wiring with fire-and-forget block, variable extractions moved before mode branch
- `src/routes/instagram-webhook.test.js` — Extended db mock with `.set()` support and `setCalls` tracker, added `vi.mock('@google-cloud/firestore')`, added 19 tests across two new describe blocks

## Decisions Made

- `updateCommenterHistory` uses `merge:true` so `first_seen_at` is preserved on subsequent writes — `FieldValue.increment(1)` is atomic, avoids read-modify-write race conditions for the counter
- `updatePostReplies` uses explicit read-modify-write (not `arrayUnion`) to enforce `slice(-8)` cap — Firestore `arrayUnion` has no length limit
- Variables (`igCommenterId`, `username`, `commentText`) extracted before the `replyMode === 'ai'` branch — ensures history writes fire for both AI and static reply modes
- Fire-and-forget guarded by `igCommenterId` check — no writes for anonymous comments (empty string); outer `.catch()` prevents unhandled rejection warnings

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - both TDD phases worked cleanly. The db mock extension for `.set()` was straightforward: added a module-level `setCalls` array and a `set:` key prefix pattern for Error simulation in `docSnapOverrides`.

## User Setup Required

None - no external service configuration required. Writes go to the same Firestore instance already configured.

## Next Phase Readiness

- Commenter memory feedback loop is now complete: Phase 2 reads, Phase 3 injects into prompts, Phase 4 writes after each reply
- `commenters` and `instagram_post_replies` collections will now accumulate real data on every AI or static auto-reply
- Returning commenters will receive personalized warmth on their second+ visits; reply deduplication will prevent repeated identical replies on the same post
- No blockers for any future phases

---
*Phase: 04-history-writes-persistence-loop*
*Completed: 2026-03-10*
