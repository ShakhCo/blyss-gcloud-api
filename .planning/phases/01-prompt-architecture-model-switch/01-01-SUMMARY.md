---
phase: 01-prompt-architecture-model-switch
plan: 01
subsystem: api
tags: [openai, instagram, webhook, prompt-engineering, firestore, testing, vitest]

# Dependency graph
requires: []
provides:
  - buildSystemPrompt() named export — pure function, fully testable, accepts structured options
  - Parallel Firestore reads in buildBusinessInfo() — 2 round trips instead of 2+N sequential
  - OpenAI API call switched from responses.create(o4-mini) to chat.completions.create(gpt-4.1-mini)
  - Solo vs team voice differentiation via isSolo param
  - Robust __SKIP__ guard including .includes() check
  - 26 unit tests covering prompt construction and API integration
affects:
  - 01-02-PLAN (prompt content rewrite — builds on this structural foundation)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - TDD with RED → GREEN commits for infrastructure refactors
    - Pure function extraction for prompt builders — enables unit testing without mocks
    - Promise.all for parallel Firestore collection reads
    - vi.mock for OpenAI and Firestore isolation in tests

key-files:
  created:
    - src/routes/instagram-webhook.test.js
  modified:
    - src/routes/instagram-webhook.js

key-decisions:
  - "buildSystemPrompt is a named export (pure function) — no side effects, no mocks needed for unit tests"
  - "bookingLink appears only in booking-intent rules (not unconditionally in every section)"
  - "Default example replies baked into prompt when aiExampleReplies is empty — 4 built-in examples uz/ru"
  - "Robust __SKIP__ guard uses .includes() in addition to exact match — handles model wrapping"
  - "buildBusinessInfo parallelization: 2 Promise.all calls — (services + employees) then (all employee services)"

patterns-established:
  - "Pure function extraction: business logic that can be tested without DB/API mocks is exported directly"
  - "Conditional prompt sections: bookingLink, username, aiInstructions, aiExampleReplies all conditionally included"
  - "TDD commit pattern: test(phase-plan) commit for RED, feat(phase-plan) commit for GREEN"

requirements-completed: [INFR-01, INFR-02, INFR-03]

# Metrics
duration: 5min
completed: 2026-03-10
---

# Phase 1 Plan 01: Prompt Architecture Refactor Summary

**Extracted `buildSystemPrompt()` as a pure named export, parallelized `buildBusinessInfo()` Firestore reads with `Promise.all`, and switched OpenAI from `responses.create(o4-mini)` to `chat.completions.create(gpt-4.1-mini, temperature=0.9)` — all with 26 passing unit tests**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T09:29:00Z
- **Completed:** 2026-03-10T09:34:10Z
- **Tasks:** 2 (4 commits including TDD RED/GREEN)
- **Files modified:** 2

## Accomplishments

- `buildSystemPrompt()` extracted from inline string concatenation in `handleCommentEvent` — now a pure named export with zero side effects, directly testable without mocks
- `buildBusinessInfo()` parallelized — services and employees fetched concurrently in 1 round trip, then all employee services fetched in a second round trip (was 2+N sequential round trips before)
- OpenAI API call switched from deprecated `responses.create()` with `o4-mini` to `chat.completions.create()` with `gpt-4.1-mini` at `temperature: 0.9`, response parsed from `choices[0]?.message?.content`
- Solo vs team voice differentiation added (`isSolo` param → "I" vs "We" voice note in prompt)
- `@username` personalization added to prompt when commenter username is available
- Booking link appears only in booking-intent rules, not unconditionally in every section
- Default example replies (4 built-in uz/ru examples) baked into prompt when `aiExampleReplies` is empty
- Robust `__SKIP__` guard: checks `=== '__SKIP__'` and `.includes('__SKIP__')` to handle model wrapping

## Task Commits

Each task was committed atomically following TDD:

1. **Task 1 RED: Add failing tests for buildSystemPrompt** - `def4613` (test)
2. **Task 1 GREEN: Extract buildSystemPrompt() implementation** - `f53b7c6` (feat)
3. **Task 2: Add tests for buildBusinessInfo and chat completions API** - `dd0f814` (test)

*Note: Task 2 infrastructure changes (Promise.all + API switch) were implemented atomically with Task 1 GREEN since both modify the same file and the full rewrite was cleaner than piecemeal edits.*

**Plan metadata:** (this commit — docs)

## Files Created/Modified

- `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/src/routes/instagram-webhook.js` — Refactored with `buildSystemPrompt()` named export, `Promise.all` parallelization, `chat.completions.create` API switch
- `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/src/routes/instagram-webhook.test.js` — Created: 26 unit tests covering all buildSystemPrompt branches and API integration verification

## Decisions Made

- **buildSystemPrompt as pure export:** No database calls, no side effects — makes it directly testable with zero mocks. This was the core structural goal of Plan 01.
- **bookingLink conditionally included:** Only in booking-intent rules (QUESTIONS, REACTIONS sections) rather than unconditionally appended everywhere. This aligns with the Phase 1 goal of fixing booking link spam.
- **Default examples added now:** Rather than deferring to Plan 02, built-in uz/ru example replies are baked into the prompt when `aiExampleReplies` is empty — anchors persona quality immediately.
- **isSolo voice differentiation included:** The `is_solo` business field was already fetched — adding "I" vs "We" voice note costs nothing and improves persona immediately.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added solo/team voice differentiation in buildSystemPrompt**
- **Found during:** Task 1 (implementing buildSystemPrompt)
- **Issue:** Plan specified `isSolo` as a parameter but didn't specify how it should affect the prompt text. The CONTEXT.md decision was clear: solo = "I" voice, team = "We" voice.
- **Fix:** Added voice note line to the prompt header: "You are the owner — speak as 'I'" vs "You represent the business team — speak as 'We'"
- **Files modified:** src/routes/instagram-webhook.js
- **Verification:** Tests for "I/solo/owner" with isSolo=true and "we/team/business" with isSolo=false pass
- **Committed in:** f53b7c6

**2. [Rule 2 - Missing Critical] Conditional booking link in global rules sections**
- **Found during:** Task 1 (extracting inline prompt to buildSystemPrompt)
- **Issue:** The original inline code hardcoded `${bookingLink}` directly into template strings without checking if bookingLink is set. This would result in "https://" (empty) in prompts for businesses without a tenant URL.
- **Fix:** All booking link references in the global rules path are now conditional on `bookingLink` being truthy
- **Files modified:** src/routes/instagram-webhook.js
- **Verification:** Test "omits booking link section entirely when bookingLink is empty" passes
- **Committed in:** f53b7c6

---

**Total deviations:** 2 auto-fixed (both Rule 2 — missing critical functionality)
**Impact on plan:** Both fixes improve correctness and were natural extensions of the extraction refactor. No scope creep.

## Issues Encountered

- **Pre-existing test failure:** `src/server.test.js` fails without `JWT_SECRET` env var — this was pre-existing before our changes, documented in `deferred-items.md`. Does not affect Plan 01 deliverables.

## Next Phase Readiness

- **Plan 02 (prompt content rewrite):** Fully ready. `buildSystemPrompt()` is now a pure, testable function — Plan 02 can rewrite the prompt content without touching infrastructure. Tests provide regression guard.
- **No blockers:** All infrastructure changes (model, API, parallel reads) are complete and passing.
- **Concern:** `server.test.js` pre-existing failure should be fixed before CI is enforced — add `JWT_SECRET=test` to test environment.

## Self-Check: PASSED

- [x] `src/routes/instagram-webhook.js` exists and contains `export function buildSystemPrompt`
- [x] `src/routes/instagram-webhook.test.js` exists with 26 tests
- [x] All 3 task commits exist: def4613, f53b7c6, dd0f814
- [x] `buildSystemPrompt` is a named export
- [x] `Promise.all` present at lines 444 and 463
- [x] No `responses.create` calls (grep returns empty)
- [x] `chat.completions.create` with `gpt-4.1-mini` and `temperature: 0.9` at lines 356-358
- [x] `choices[0]?.message?.content` at line 364

---
*Phase: 01-prompt-architecture-model-switch*
*Completed: 2026-03-10*
