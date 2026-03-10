---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
stopped_at: Completed 01-02-PLAN.md — Phase 1 complete, human-verify approved
last_updated: "2026-03-10T09:48:38.679Z"
last_activity: 2026-03-10 — Roadmap created
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-10)

**Core value:** Every AI reply should be indistinguishable from a skilled human social media manager
**Current focus:** Phase 1 — Prompt Architecture & Model Switch

## Current Position

Phase: 1 of 4 (Prompt Architecture & Model Switch)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-10 — Roadmap created

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01-prompt-architecture-model-switch P01 | 6min | 2 tasks | 2 files |
| Phase 01-prompt-architecture-model-switch P02 | 15min | 2 tasks | 2 files |
| Phase 01-prompt-architecture-model-switch P02 | 20min | 3 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Pre-Phase 1]: Switch AI model from o4-mini (reasoning) to gpt-4.1-mini (chat completions) — balance cost vs quality; verify pricing at platform.openai.com before implementation
- [Pre-Phase 1]: Track commenter history in Firestore (single document per commenter per business, not one per comment) — TTL: delete records older than 90 days
- [Pre-Phase 1]: Personality via prompt engineering first — improve prompts before changing architecture
- [Phase 01-prompt-architecture-model-switch]: buildSystemPrompt() is a named export pure function — enables unit testing without mocks, extracted from inline construction in handleCommentEvent
- [Phase 01-prompt-architecture-model-switch]: Switched OpenAI API from responses.create(o4-mini) to chat.completions.create(gpt-4.1-mini, temperature=0.9) — balances cost vs quality
- [Phase 01-prompt-architecture-model-switch]: bookingLink conditionally included in prompt — only in booking-intent rules sections, not unconditionally
- [Phase 01-prompt-architecture-model-switch]: Booking link removed from REACTIONS/NEGATIVE routing — only in BOOKING-INTENT section; DO NOT include the booking link rule explicit in both sections
- [Phase 01-prompt-architecture-model-switch]: NEGATIVE comments get empathy + DM invite (DMga yozing, hal qilamiz) with no booking link — respects human frustration, builds trust
- [Phase 01-prompt-architecture-model-switch]: Default examples use real Uzbek (Rahmat! Har doim xush kelibsiz) and Russian (Спасибо! Всегда рады видеть вас) — warm & balanced tone with script-matching demonstration
- [Phase 01-prompt-architecture-model-switch]: Booking link appears ONLY in BOOKING-INTENT section — removed from REACTIONS and NEGATIVE routing entirely
- [Phase 01-prompt-architecture-model-switch]: NEGATIVE comments get empathy + DM invite (DMga yozing, hal qilamiz) with no booking link — respects human frustration, builds trust
- [Phase 01-prompt-architecture-model-switch]: Default examples use real Uzbek (Rahmat! Har doim xush kelibsiz) and Russian (Спасибо! Всегда рады видеть вас) — warm & balanced tone with script-matching demonstration

### Pending Todos

None yet.

### Blockers/Concerns

- gpt-4.1-mini pricing and availability should be verified before Phase 1 implementation (fallback: gpt-4o-mini already in codebase at src/routes/ai.js)
- Instagram OAuth token expiry silently kills auto-reply — token alerting/refresh should be addressed during or before Phase 1
- Most businesses may have empty ai_example_replies — consider providing default examples per language to anchor Phase 1 persona quality

## Session Continuity

Last session: 2026-03-10T09:48:38.677Z
Stopped at: Completed 01-02-PLAN.md — Phase 1 complete, human-verify approved
Resume file: None
