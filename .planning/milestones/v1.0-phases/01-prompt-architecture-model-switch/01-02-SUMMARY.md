---
phase: 01-prompt-architecture-model-switch
plan: 02
subsystem: api
tags: [openai, instagram, webhook, prompt-engineering, persona, tone, testing, vitest]

# Dependency graph
requires:
  - phase: 01-prompt-architecture-model-switch
    plan: 01
    provides: buildSystemPrompt() named export pure function with all structural parameters
affects:
  - Phase 2 (commenter history) — persona quality now baseline-anchored
  - Phase 3 (caption classification) — comment-type routing sections established

provides:
  - Warm human AI persona in buildSystemPrompt() — not a corporate booking bot
  - TONE-01: solo "I" voice vs team "we" voice with Uzbek examples (Sizni kutaman / Sizni kutamiz)
  - TONE-02: BOOKING-INTENT routing — bookingLink only in this section, never elsewhere
  - TONE-03: REACTIONS/PRAISE routing — explicitly prohibits booking link, witty one-liner instruction
  - TONE-04: NEGATIVE routing — empathy + DM invite (DMga yozing, hal qilamiz), no booking link
  - TONE-05: Reply length proportionality rules (1-3 words → 1 sentence, 3-sentence hard cap)
  - TONE-06: Emoji mirroring rules — mirrors commenter energy, cap at 2, never lead with emoji
  - PERS-01: @username natural placement — once only, contextual, section omitted when empty
  - Script matching: Cyrillic Uzbek → Cyrillic reply, Latin → Latin, Russian → Russian
  - Default example replies in Uzbek and Russian (warm & balanced tone anchors)
  - 64 unit tests covering all TONE and PERS requirements

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Layered prompt architecture: Identity → Context → Core rules → Comment routing → Examples → Owner overrides
    - Conditional prompt sections: bookingLink, username, aiInstructions, aiExampleReplies all gated
    - TDD with RED commits then GREEN commits for each task
    - Requirement-tagged test descriptions (TONE-01, TONE-05, etc.) for --reporter filtering

key-files:
  created: []
  modified:
    - src/routes/instagram-webhook.js
    - src/routes/instagram-webhook.test.js

key-decisions:
  - "Booking link appears ONLY in BOOKING-INTENT section — removed from REACTIONS and NEGATIVE routing entirely"
  - "Default examples use real Uzbek (Rahmat! Har doim xush kelibsiz) and Russian (Спасибо! Всегда рады видеть вас) — warm & balanced tone"
  - "Emoji cap enforced at 2 with explicit no-lead-emoji rule — mirrors commenter energy not exceeds it"
  - "@username placement is contextual (start/middle/end) never mechanical — section omitted entirely when username empty"
  - "NEGATIVE routing prohibits booking link explicitly — empathy + DM invite only"

patterns-established:
  - "Comment-type routing pattern: BOOKING-INTENT / REACTIONS / NEGATIVE / SPAM as named sections"
  - "Dual-prohibition pattern: DO NOT include the booking link appears in both REACTIONS and NEGATIVE sections"
  - "Proportional reply length: comment word count drives reply sentence count"

requirements-completed: [TONE-01, TONE-02, TONE-03, TONE-04, TONE-05, TONE-06, PERS-01]

# Metrics
duration: 15min
completed: 2026-03-10
---

# Phase 1 Plan 02: Prompt Content Rewrite Summary

**Rewrote buildSystemPrompt() from corporate booking-bot language into a warm human social media manager persona — with solo/team voice, proportional reply length, emoji mirroring, @username placement, comment-type routing, and default Uzbek/Russian example replies, verified by 64 unit tests**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-10T14:36:00Z
- **Completed:** 2026-03-10T14:40:58Z
- **Tasks:** 3 (2 auto + 1 human-verify — approved)
- **Files modified:** 2

## Accomplishments

- Section 1 (TONE-01): Identity rewritten — "Tone: warm, confident, and human. Not corporate. Not a bot." with solo "first person singular — I, men, ya" vs team "first person plural — we, biz, my" and Uzbek voice examples
- Section 3 (TONE-05): Reply length proportionality — 1-3 words/emoji-only → 1 sentence, 4-10 words → 1-2 sentences, 11+ words → 2-3 sentences, hard 3-sentence cap
- Section 3 (TONE-06): Emoji mirroring — mirrors commenter energy, cap at 2 per reply, never lead with emoji as first character
- Section 3 (PERS-01): @username natural placement — once only, placed where a human would address someone, section omitted when username is empty/null
- Script matching: Cyrillic Uzbek → Cyrillic reply, Latin Uzbek → Latin reply, Russian → Russian
- Section 4 (TONE-02): BOOKING-INTENT routing — bookingLink only here, with intent keywords (qancha, yozilish, zapisatsya)
- Section 4 (TONE-03): REACTIONS/PRAISE routing — witty one-liner, explicitly "DO NOT include the booking link. Ever."
- Section 4 (TONE-04): NEGATIVE routing — empathy + DM invite ("DMga yozing, hal qilamiz"), explicitly "DO NOT include the booking link"
- Section 4: SPAM routing — returns exactly `__SKIP__`
- Section 5: Default examples in Uzbek and Russian (Rahmat!/Спасибо!, DMga yozing, Sizni kutamiz, booking-intent examples with link)
- Time-relative word warning, no-discounts, no-hashtags rules preserved from original
- Per-post override path still functional and tested

## Task Commits

Each task was committed atomically following TDD:

1. **Task 1A RED: Add failing tests for Sections 1-3** - `8141ac1` (test)
2. **Task 1A GREEN: Rewrite buildSystemPrompt Sections 1-3 + 4-5** - `5ac8977` (feat)
3. **Task 1B: Add TONE-02/03/04, SPAM, default-examples tests** - `ae87d52` (test)

*Note: Sections 4-5 were implemented during Task 1A GREEN since they're tightly integrated in the same function. Task 1B tests confirmed the implementation was correct.*

**Plan metadata:** (this commit — docs)

## Files Created/Modified

- `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/src/routes/instagram-webhook.js` — buildSystemPrompt() content rewritten with 6 sections: identity, context, core rules, comment-type routing, examples, owner overrides
- `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/src/routes/instagram-webhook.test.js` — Expanded from 26 to 64 tests: 38 new tests covering all TONE-01 through TONE-06 and PERS-01 requirements

## Decisions Made

- **Booking link removed from REACTIONS section:** Original prompt had "Thank warmly + booking link. Always." — replaced with "DO NOT include the booking link. Ever." This is the core fix for booking link spam.
- **Default Uzbek/Russian examples use proper script:** Uzbek examples in Latin Uzbek (Rahmat! Har doim xush kelibsiz), Russian in Cyrillic (Спасибо! Всегда рады видеть вас) — demonstrates script-matching behavior
- **NEGATIVE routing has no booking link:** Changed from "Bir tashrif buyurib ko'ring + link" to empathy + DM invite only — respects the human frustration of negative commenters
- **Emoji mirroring cap strictly 2:** Original had "1-2 emojis max" without mirror instruction — now explicitly mirrors commenter energy with hard 2-cap and no-lead rule

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Behavior] Sections 4-5 implemented during Task 1A GREEN instead of Task 1B**
- **Found during:** Task 1A GREEN (implementing buildSystemPrompt)
- **Issue:** Sections 1-3 and 4-5 are in the same function body — separating implementation into two commits would require partial function rewrites and create a non-functional intermediate state
- **Fix:** Implemented all sections atomically in Task 1A GREEN. Task 1B RED tests were written after implementation was already correct, and all passed immediately.
- **Files modified:** src/routes/instagram-webhook.js
- **Verification:** 64 tests pass, all TONE-02/03/04 requirements verified by Task 1B tests
- **Committed in:** 5ac8977 (Task 1A GREEN)

**2. [Rule 1 - Test Update] Updated "Drive bookings" test to match new human-focused prompt**
- **Found during:** Task 1A GREEN (running tests)
- **Issue:** Existing test `uses global rules path when postAiInstructions is empty` checked for "Drive bookings" — the old corporate language being replaced
- **Fix:** Updated test to check for "BOOKING-INTENT|REACTIONS|NEGATIVE" — the actual global path markers in the new prompt
- **Files modified:** src/routes/instagram-webhook.test.js
- **Verification:** Test passes and accurately reflects new prompt structure
- **Committed in:** 5ac8977 (Task 1A GREEN)

---

**Total deviations:** 2 (both Rule 1 — behavior alignment during implementation)
**Impact on plan:** Both deviations improved delivery quality. No scope creep.

## Issues Encountered

- **Pre-existing server.test.js failure:** Requires `JWT_SECRET` env var, fails without it. Pre-existing before Plan 01, documented in deferred-items.md. Does not affect any Plan 02 deliverables.

## Next Phase Readiness

- **Phase 1 complete:** Human-verify checkpoint approved — buildSystemPrompt() persona quality confirmed as warm/human social media manager
- **Phase 2 readiness:** Phase 2 (commenter history) can begin — the persona foundation is solid, function signature supports history injection
- **No blockers:** All 64 automated tests pass, human verification approved

## Self-Check: PASSED (Updated after human approval)

- [x] `src/routes/instagram-webhook.js` contains Section 1 with "first person singular" and "first person plural"
- [x] `src/routes/instagram-webhook.js` contains REPLY LENGTH section with 1-3 words rule
- [x] `src/routes/instagram-webhook.js` contains EMOJI USAGE section with "never more than 2"
- [x] `src/routes/instagram-webhook.js` contains @USERNAME PLACEMENT with "once only"
- [x] `src/routes/instagram-webhook.js` contains BOOKING-INTENT section
- [x] `src/routes/instagram-webhook.js` contains "DO NOT include the booking link. Ever." in REACTIONS
- [x] `src/routes/instagram-webhook.js` contains "DO NOT include the booking link." in NEGATIVE
- [x] `src/routes/instagram-webhook.js` contains Uzbek default examples (Rahmat!)
- [x] `src/routes/instagram-webhook.js` contains Russian default examples (Спасибо!)
- [x] All 3 task commits exist: 8141ac1, 5ac8977, ae87d52
- [x] 64 tests passing (up from 26)

---
*Phase: 01-prompt-architecture-model-switch*
*Completed: 2026-03-10*
