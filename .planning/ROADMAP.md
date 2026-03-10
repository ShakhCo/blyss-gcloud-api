# Roadmap: BLYSS Instagram AI Auto-Reply

## Overview

Transform the existing Instagram auto-reply system from a detectable booking bot into an AI that sounds like a skilled human social media manager. The work proceeds in four dependency-ordered phases: first fix the root causes (wrong model, corporate prompt framing) with no new infrastructure; then design and wire in the Firestore history reads; then inject that data into the prompt to enable commenter memory and reply variety; finally close the loop with fire-and-forget history writes that feed future replies.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Prompt Architecture & Model Switch** - Rewrite the AI persona, switch to gpt-4.1-mini, extract buildSystemPrompt(), and fix infrastructure prerequisites
- [ ] **Phase 2: Commenter History Infrastructure** - Design and implement Firestore subcollections for commenter memory and post reply log; wire reads into the pipeline
- [ ] **Phase 3: Memory & Variety in Prompt** - Inject commenter history and post reply data into the prompt; add post type classification and engagement questions
- [ ] **Phase 4: History Writes & Persistence Loop** - Add fire-and-forget Firestore writes after each reply to close the memory loop

## Phase Details

### Phase 1: Prompt Architecture & Model Switch
**Goal**: Replies sound human — warm, playful, and proportional — with no universal booking link spam, @username used naturally, and the AI model matched to the task
**Depends on**: Nothing (first phase)
**Requirements**: INFR-01, INFR-02, INFR-03, TONE-01, TONE-02, TONE-03, TONE-04, TONE-05, TONE-06, PERS-01
**Success Criteria** (what must be TRUE):
  1. A reply to an emoji-only comment (e.g., "🔥") is a witty one-liner with no booking link
  2. A reply to a booking-intent comment (e.g., "how much?") includes the booking link; a reply to a generic compliment does not
  3. @username appears naturally in replies — once, placed where a human would put it
  4. A reply to a 2-word comment is one sentence; a reply to a paragraph-length comment is proportionally longer
  5. No two consecutive replies on a fresh test post start with the same opener word
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Extract buildSystemPrompt(), parallelize buildBusinessInfo(), switch to gpt-4.1-mini
- [ ] 01-02-PLAN.md — Rewrite AI persona prompt with all TONE and PERS requirements + human verification

### Phase 2: Commenter History Infrastructure
**Goal**: Firestore subcollections for commenter memory and post reply log exist with correct schema, parallel reads are wired into the pipeline, and reply behavior is unchanged (reads fetched but not yet used in prompt)
**Depends on**: Phase 1
**Requirements**: PERS-02
**Success Criteria** (what must be TRUE):
  1. A commenter's username, comment_count, first_seen_at, last_seen_at, and last_comment_text are readable from Firestore after their first comment is processed (once writes are added in Phase 4 — this phase validates schema correctness)
  2. The two new Firestore reads execute in parallel with existing buildBusinessInfo() reads and do not increase webhook response time by more than 200ms
  3. Reply content is identical to Phase 1 output — reads are fetched but not yet injected into the prompt
**Plans**: TBD

### Phase 3: Memory & Variety in Prompt
**Goal**: Replies acknowledge returning commenters differently from first-timers, avoid repeating recent openers on the same post, and adapt tone to post type (promo, before/after, milestone, general)
**Depends on**: Phase 2
**Requirements**: PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04
**Success Criteria** (what must be TRUE):
  1. A returning commenter (comment_count > 1) receives a reply that references their return ("glad you're back" or equivalent) rather than a generic opener
  2. The 4th reply on a single post does not start with the same word as any of the previous 3 replies on that post
  3. A before/after post generates a reply celebrating transformation; a promo post generates a reply with urgency language; a milestone post generates a celebratory reply
  4. A genuine praise or curiosity comment receives a reply that ends with a follow-up question rather than a booking link
**Plans**: TBD

### Phase 4: History Writes & Persistence Loop
**Goal**: Commenter memory and post reply log accumulate persistently across all sessions and instance restarts, closing the feedback loop that Phases 2-3 read from
**Depends on**: Phase 3
**Requirements**: (closes the loop started by PERS-02 — infrastructure complement)
**Success Criteria** (what must be TRUE):
  1. After a comment is replied to, a Firestore document for that commenter exists under the business's subcollection with updated comment_count and last_seen_at
  2. After a reply is posted, the post's recent_replies array in Firestore is updated and capped at 8 entries
  3. Writes happen fire-and-forget after replyToComment() succeeds and do not delay the webhook response
  4. Commenter history persists correctly after a Cloud Run instance restart (i.e., the in-memory Map fallback is replaced by durable Firestore state)
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Prompt Architecture & Model Switch | 0/2 | Planning complete | - |
| 2. Commenter History Infrastructure | 0/? | Not started | - |
| 3. Memory & Variety in Prompt | 0/? | Not started | - |
| 4. History Writes & Persistence Loop | 0/? | Not started | - |
