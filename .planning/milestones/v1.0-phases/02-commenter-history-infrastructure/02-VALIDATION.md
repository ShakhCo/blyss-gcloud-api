---
phase: 2
slug: commenter-history-infrastructure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.16 |
| **Config file** | none — default vitest config; `npm test` runs `vitest run` |
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
| PERS-02 (read: no doc) | 01 | 1 | PERS-02 | unit (mock Firestore) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (read: expired) | 01 | 1 | PERS-02 | unit (mock Firestore) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (read: valid doc) | 01 | 1 | PERS-02 | unit (mock Firestore) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (replies: no doc) | 01 | 1 | PERS-02 | unit (mock Firestore) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (replies: expired) | 01 | 1 | PERS-02 | unit (mock Firestore) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (replies: valid) | 01 | 1 | PERS-02 | unit (mock Firestore) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (parallel) | 01 | 1 | PERS-02 | unit (mock all) | `npm test` | ❌ W0 | ⬜ pending |
| PERS-02 (no regression) | 01 | 1 | PERS-02 | unit (existing tests) | `npm test` | ✅ existing 64 tests | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/routes/instagram-webhook.test.js` — add `getCommenterHistory` and `getPostReplies` test cases; update Firestore mock to support `.collection('commenters').doc(id).get()` and `.collection('instagram_post_replies').doc(id).get()` paths
- [ ] `src/routes/instagram-webhook.test.js` — add test verifying `commenterHistory` and `postReplies` are passed to `buildSystemPrompt` without changing prompt output (regression guard for Phase 3)

*(Existing test infrastructure covers all other requirements. No new files needed.)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| TTL policy active in Firestore | PERS-02 | Requires deployed Firestore instance | Deploy `firestore.indexes.json`, verify TTL policy in Firebase Console |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
