---
phase: 4
slug: history-writes-persistence-loop
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 4 — Validation Strategy

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
| 04-01-01 | 01 | 0 | SC-1 | unit | `npm test` | No W0 | pending |
| 04-01-02 | 01 | 0 | SC-2 | unit | `npm test` | No W0 | pending |
| 04-01-03 | 01 | 0 | SC-3 | unit | `npm test` | No W0 | pending |
| 04-01-04 | 01 | 0 | SC-4 | unit | `npm test` | No W0 | pending |

*Status: pending · green · red · flaky*

---

## Wave 0 Requirements

- [ ] New test coverage in `instagram-webhook.test.js` for updateCommenterHistory, updatePostReplies, fire-and-forget call site
- [ ] Mock pattern: `vi.mock('../db/db.js')` matching existing test infrastructure

*Existing test file and framework cover all phase requirements — no new test files or framework installs needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Data persists across Cloud Run restart | SC-4 | Requires actual Cloud Run deployment | Deploy, send comment, restart instance, verify Firestore doc exists |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
