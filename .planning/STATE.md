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

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Pre-Phase 1]: Switch AI model from o4-mini (reasoning) to gpt-4.1-mini (chat completions) — balance cost vs quality; verify pricing at platform.openai.com before implementation
- [Pre-Phase 1]: Track commenter history in Firestore (single document per commenter per business, not one per comment) — TTL: delete records older than 90 days
- [Pre-Phase 1]: Personality via prompt engineering first — improve prompts before changing architecture

### Pending Todos

None yet.

### Blockers/Concerns

- gpt-4.1-mini pricing and availability should be verified before Phase 1 implementation (fallback: gpt-4o-mini already in codebase at src/routes/ai.js)
- Instagram OAuth token expiry silently kills auto-reply — token alerting/refresh should be addressed during or before Phase 1
- Most businesses may have empty ai_example_replies — consider providing default examples per language to anchor Phase 1 persona quality

## Session Continuity

Last session: 2026-03-10
Stopped at: Roadmap created, ready to plan Phase 1
Resume file: None
