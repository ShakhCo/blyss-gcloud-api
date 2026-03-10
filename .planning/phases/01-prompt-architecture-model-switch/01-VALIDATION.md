---
phase: 1
slug: prompt-architecture-model-switch
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.16 |
| **Config file** | package.json (test script) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01 | 01 | 1 | INFR-01 | manual | Model switch verified by reply output | N/A | ⬜ pending |
| 01-02 | 01 | 1 | INFR-02 | manual | buildSystemPrompt function exists and is called | N/A | ⬜ pending |
| 01-03 | 01 | 1 | INFR-03 | manual | Promise.all in buildBusinessInfo | N/A | ⬜ pending |
| 01-04 | 01 | 1 | TONE-01 | manual | Persona-first prompt structure | N/A | ⬜ pending |
| 01-05 | 01 | 1 | TONE-02 | manual | Booking link only on intent | N/A | ⬜ pending |
| 01-06 | 01 | 1 | TONE-03 | manual | Witty emoji replies | N/A | ⬜ pending |
| 01-07 | 01 | 1 | TONE-04 | manual | Empathetic negative handling | N/A | ⬜ pending |
| 01-08 | 01 | 1 | TONE-05 | manual | Proportional reply length | N/A | ⬜ pending |
| 01-09 | 01 | 1 | TONE-06 | manual | Emoji cap at 2 | N/A | ⬜ pending |
| 01-10 | 01 | 1 | PERS-01 | manual | @username in replies | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. This phase is primarily prompt engineering and API call changes — automated tests verify code doesn't break, manual verification confirms AI output quality.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Witty emoji reply | TONE-03 | AI output quality | Send 🔥 comment, verify no booking link, reply is witty one-liner |
| Booking link discipline | TONE-02 | AI output quality | Send "zo'r!" comment, verify no booking link; send "narxi qancha?" verify link present |
| @username natural | PERS-01 | AI output quality | Send comment, verify @username appears once naturally |
| Reply proportionality | TONE-05 | AI output quality | Send 2-word vs paragraph comment, compare reply lengths |
| Persona voice | TONE-01 | AI output quality | Verify solo business uses "I", team uses "We" |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
