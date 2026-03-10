# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Instagram AI Auto-Reply

**Shipped:** 2026-03-10
**Phases:** 4 | **Plans:** 5 | **Sessions:** 6

### What Was Built
- Pure function `buildSystemPrompt()` with layered prompt architecture (identity, context, rules, routing, examples, overrides)
- Warm human AI persona replacing corporate booking-bot language, with proportional replies and emoji mirroring
- Firestore infrastructure for commenter history (90-day TTL) and post reply tracking (30-day TTL, 8-entry cap)
- Returning commenter warmth calibration and post type classification injected into AI prompt
- Fire-and-forget Firestore writes closing the commenter memory feedback loop
- 127 unit tests covering all requirements with TDD RED/GREEN discipline

### What Worked
- **TDD RED/GREEN commits** — every plan produced predictable, atomic commits with clear test-first discipline; no regressions across 4 phases
- **Pure function extraction** — `buildSystemPrompt()` as a pure named export made all prompt behavior trivially testable without mocks
- **Phase dependency chain** — read infrastructure (Phase 2) → prompt injection (Phase 3) → write persistence (Phase 4) was a clean, modular decomposition
- **Single-file scope** — all 4 phases modified only `instagram-webhook.js` + its test file, keeping cognitive load low
- **Parallel reads** — `Promise.all` for `buildBusinessInfo` + `getCommenterHistory` + `getPostReplies` added zero latency for new features

### What Was Inefficient
- **STATE.md not auto-updated during execution** — velocity metrics and progress bar stayed at 0% throughout the milestone despite all phases completing
- **Summary one_liner extraction failed** — `summary-extract --fields one_liner` returned null for all summaries, suggesting frontmatter format didn't match expected schema
- **Duplicate decisions in STATE.md** — several Phase 1 decisions were recorded twice (NEGATIVE routing, default examples)

### Patterns Established
- **Conditional prompt sections:** `if (param && param.field >= threshold) { systemPrompt += section }` — clean null-safe injection pattern
- **Phase boundary params:** extend function signature in Phase N, activate in body in Phase N+1 — prevents coupling between phases
- **Graceful degradation reads:** `try/catch → return null` for all Firestore reads — webhook never crashes on history miss
- **Fire-and-forget writes:** `Promise.all([...]).catch(...)` without `await` — persistence doesn't block response
- **TDD commit naming:** `test(phase-plan): description` for RED, `feat(phase-plan): description` for GREEN

### Key Lessons
1. **Pure function extraction pays off immediately** — buildSystemPrompt was testable from day 1 with zero mock complexity, enabling 127 tests that caught real issues
2. **Booking link spam was the #1 quality problem** — removing it from REACTIONS and NEGATIVE routing was the single biggest improvement to reply quality
3. **Prompt engineering > model switching** — the persona quality improvement came from rewriting the prompt, not from changing models; gpt-4.1-mini was adequate
4. **TTL policies should be set at infrastructure time** — configuring firestore.indexes.json in Phase 2 meant Phase 4 writes auto-expired without extra code

### Cost Observations
- Model mix: ~40% opus (planning/verification), ~60% sonnet (execution/research)
- Sessions: 6 (1 per plan + 1 for context/research)
- Notable: Entire milestone completed in ~86 min of execution time across a single day

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 6 | 4 | First milestone — established TDD + pure function patterns |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 127 | High (all requirements) | 0 (used existing deps) |

### Top Lessons (Verified Across Milestones)

1. Pure function extraction enables comprehensive testing with zero mock complexity
2. TDD RED/GREEN commits prevent regressions across dependent phases
