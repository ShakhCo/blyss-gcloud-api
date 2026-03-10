---
phase: 3
slug: memory-variety-in-prompt
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.16 |
| **Config file** | none — `"test": "vitest run"` in package.json scripts |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 0 | PERS-03 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 0 | PERS-03 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 0 | PERS-03 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 0 | PERS-04 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-05 | 01 | 0 | PERS-04 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-06 | 01 | 0 | QUAL-01 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-07 | 01 | 0 | QUAL-02 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-08 | 01 | 0 | QUAL-02 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-09 | 01 | 0 | QUAL-02 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-10 | 01 | 0 | QUAL-03 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-11 | 01 | 0 | QUAL-03 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-01-12 | 01 | 0 | QUAL-04 | unit | `npm test` | ❌ W0 | ⬜ pending |
| 03-regression | 01 | 0 | PERS-03 | unit | `npm test` | ✅ (update) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] New `describe` blocks in `instagram-webhook.test.js` for PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04
- [ ] Update/remove the Phase 2 "params ignored" test (line 878) that asserts opposite of Phase 3 behavior

*Existing infrastructure covers all phase requirements — no new test files or framework installs needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| AI actually says "glad you're back" for returning commenter | PERS-03 | Tests AI judgment, not prompt content | Send real comment from returning user, verify reply tone |
| AI ends with follow-up question on praise from returning visitor | PERS-04 | Tests AI judgment, not prompt content | Send praise comment from comment_count >= 2 user, check for question |
| AI uses urgency language on promo post | QUAL-04 | Tests AI compliance with tone guidance | Create promo caption post, send comment, verify reply tone |
| 4th reply on same post avoids opener duplication | QUAL-01 | Requires sequential AI calls | Send 4+ comments on same post, verify no duplicate openers |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
