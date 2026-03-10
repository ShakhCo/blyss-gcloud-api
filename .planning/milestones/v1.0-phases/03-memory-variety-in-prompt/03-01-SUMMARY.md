---
phase: 03-memory-variety-in-prompt
plan: 01
subsystem: api
tags: [ai, instagram, prompt-engineering, openai, gpt-4.1-mini]

# Dependency graph
requires:
  - phase: 02-commenter-history-infrastructure
    provides: commenterHistory and postReplies fetched and passed to buildSystemPrompt call site
provides:
  - Four conditional prompt sections in buildSystemPrompt() else branch
  - RETURNING COMMENTER section with warmth calibration (comment_count >= 2 threshold)
  - POST TYPE section with keyword-based promo/before-after/milestone/general classification
  - RECENT REPLIES deduplication section with slice(0,5) guard
  - Follow-up question guidance for returning visitors inside RETURNING COMMENTER section
  - Full test coverage for PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04
affects: [future prompt phases, AI quality metrics, instagram-webhook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional prompt injection: if (param && param.field >= threshold) { systemPrompt += section }"
    - "All new sections placed in else branch (global rules path) only — postAiInstructions path unaffected"
    - "Warmth calibration threshold: count >= 4 = loyal regular, count 2-3 = subtle nod"
    - "Slice guard: recent_replies.slice(0, 5) prevents prompt bloat"

key-files:
  created: []
  modified:
    - src/routes/instagram-webhook.js
    - src/routes/instagram-webhook.test.js

key-decisions:
  - "RETURNING COMMENTER section gated on comment_count >= 2 — count=1 is treated as first-timer"
  - "Warmth calibration uses only comment_count (not dates) — simpler, avoids formatting first_seen_at"
  - "last_comment_text NOT quoted in prompt — avoids privacy concerns and prompt injection risk"
  - "POST TYPE section present whenever postCaption is non-empty — includes keyword list for AI classification"
  - "RECENT REPLIES slice(0,5) guard — balances context richness vs prompt size"
  - "All three new sections placed only in else branch — postAiInstructions per-post override path unaffected"

patterns-established:
  - "TDD RED-GREEN: tests written first to assert Phase 3 activation, then implementation follows"
  - "Phase boundary: existing 'Phase 2 params ignored' test updated to assert opposite (Phase 3 activation)"

requirements-completed: [PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04]

# Metrics
duration: 18min
completed: 2026-03-10
---

# Phase 3 Plan 01: Memory and Variety Prompt Sections Summary

**Four conditional AI prompt sections injected into buildSystemPrompt(): returning commenter warmth calibration, post type keyword classification, and reply deduplication with slice(0,5) guard**

## Performance

- **Duration:** 18 min
- **Started:** 2026-03-10T11:19:00Z
- **Completed:** 2026-03-10T11:37:28Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments
- RETURNING COMMENTER section injects into prompt when comment_count >= 2 with loyalty calibration ("loyal regular" for count >= 4, "commented before" for count 2-3) and follow-up question guidance
- POST TYPE section injects when postCaption is non-empty, providing keyword-based classification (promo/before-after/milestone/general) with tone adaptation hints
- RECENT REPLIES deduplication section injects when recent_replies has items, with slice(0,5) guard and "Do NOT start with same word" instruction
- All sections strictly null-safe — absent data means section omitted entirely (no regression)
- 30 new tests covering PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04 (108 total, all pass)

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Write failing tests** - `1eee3a3` (test)
2. **Task 2 (GREEN): Implement four conditional sections** - `760cf06` (feat)

_Note: TDD tasks committed as test (RED) then feat (GREEN)._

## Files Created/Modified
- `src/routes/instagram-webhook.js` - Added three conditional prompt injection blocks in else branch between Section 4 RULES and Section 5 EXAMPLE REPLIES
- `src/routes/instagram-webhook.test.js` - Added 30 new tests in four describe blocks; updated Phase 2 "params ignored" test to assert Phase 3 activation

## Decisions Made
- RETURNING COMMENTER section gated on comment_count >= 2 — count=1 treated as first-timer (no returning commenter acknowledgment)
- Warmth calibration uses only comment_count (not dates) — per locked Phase 2 decision, avoids formatting first_seen_at Timestamps
- last_comment_text NOT quoted in the prompt — per locked decision, avoids privacy concerns and prompt injection risk
- POST TYPE section present whenever postCaption is non-empty — AI classifies from keywords, no pre-parsing in JS
- All three new sections placed only in else branch — postAiInstructions per-post override path is unaffected

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- buildSystemPrompt() now context-aware: returning commenter warmth, post type tone, reply deduplication all active
- Infrastructure (commenterHistory, postReplies from Phase 2) fully utilized
- Phase 3 requirements PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04 all satisfied
- AI replies can now vary tone based on post content, avoid repeating openers, and acknowledge loyal visitors

---
*Phase: 03-memory-variety-in-prompt*
*Completed: 2026-03-10*

## Self-Check: PASSED

All files and commits verified:
- `src/routes/instagram-webhook.js` — FOUND
- `src/routes/instagram-webhook.test.js` — FOUND
- `.planning/phases/03-memory-variety-in-prompt/03-01-SUMMARY.md` — FOUND
- Commit `1eee3a3` (RED tests) — FOUND
- Commit `760cf06` (GREEN implementation) — FOUND
