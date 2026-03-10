# Requirements: BLYSS Instagram AI Auto-Reply

**Defined:** 2026-03-10
**Core Value:** Every AI reply should be indistinguishable from a skilled human social media manager

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Personality & Tone

- [ ] **TONE-01**: AI replies use a persona-first prompt — warm, playful, confident voice instead of corporate booking funnel
- [ ] **TONE-02**: Booking link is only included when the commenter asks about booking, price, or availability — not on every reply
- [ ] **TONE-03**: Emoji-only comments (🔥, ❤️, 💪) get witty one-liner replies, not booking pushes
- [ ] **TONE-04**: Negative comments get empathetic acknowledgment and DM invitation, not canned deflection with booking link
- [ ] **TONE-05**: Reply length matches comment length — short comments (≤3 words) get ≤1 sentence replies
- [ ] **TONE-06**: Emoji usage mirrors the commenter's energy level and style, capped at 2 per reply

### Personalization

- [ ] **PERS-01**: AI uses @username naturally in replies — once, where a human would place it
- [ ] **PERS-02**: System tracks returning commenters per business in Firestore (username, comment_count, last_seen)
- [ ] **PERS-03**: AI acknowledges returning commenters differently from first-timers ("Glad you're back!" vs generic)
- [ ] **PERS-04**: AI asks engaging follow-up questions on genuine praise and curiosity comments to spark conversation

### Reply Quality

- [ ] **QUAL-01**: No two consecutive replies on the same post start with the same word or pattern
- [ ] **QUAL-02**: Recent replies per post are tracked in memory and injected as negative examples in the prompt
- [ ] **QUAL-03**: Post type is classified from caption (promo, before/after, new_service, milestone, general)
- [ ] **QUAL-04**: AI adapts reply style to post type — celebration for milestones, aspiration for before/after, urgency for promos

### Infrastructure

- [x] **INFR-01**: AI model switched from o4-mini (reasoning) to gpt-4.1-mini (chat completions) with temperature 0.9
- [x] **INFR-02**: Prompt construction extracted into a dedicated `buildSystemPrompt()` function with layered sections
- [x] **INFR-03**: `buildBusinessInfo()` Firestore reads parallelized with Promise.all instead of sequential awaits

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Context

- **CTX-01**: Commenter's previous comment text stored and referenced in replies
- **CTX-02**: AI classification sub-call for post type instead of keyword heuristics
- **CTX-03**: Business owner can define custom persona voice per business (beyond ai_instructions)

### Reliability

- **REL-01**: Token expiry detection and business owner notification when Instagram token expires
- **REL-02**: Token refresh cron job for proactive renewal before 60-day expiry
- **REL-03**: Post caption caching to reduce Instagram API calls on high-comment posts

## Out of Scope

| Feature | Reason |
|---------|--------|
| DM auto-replies | Different Instagram permissions and system, separate initiative |
| Comment moderation (hide/delete) | Not part of reply improvement; separate feature |
| Scheduled/delayed replies | Adds latency management complexity; not needed for engagement |
| Multi-language within single reply | Match one language per reply — mixing feels unnatural |
| AI-generated hashtags in replies | Anti-feature — no human puts hashtags in comment replies |
| Self-introduction in replies | Anti-feature — account name is visible, introducing yourself is absurd |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TONE-01 | Phase 1 | Pending |
| TONE-02 | Phase 1 | Pending |
| TONE-03 | Phase 1 | Pending |
| TONE-04 | Phase 1 | Pending |
| TONE-05 | Phase 1 | Pending |
| TONE-06 | Phase 1 | Pending |
| PERS-01 | Phase 1 | Pending |
| PERS-02 | Phase 2 | Pending |
| PERS-03 | Phase 3 | Pending |
| PERS-04 | Phase 3 | Pending |
| QUAL-01 | Phase 3 | Pending |
| QUAL-02 | Phase 3 | Pending |
| QUAL-03 | Phase 3 | Pending |
| QUAL-04 | Phase 3 | Pending |
| INFR-01 | Phase 1 | Complete |
| INFR-02 | Phase 1 | Complete |
| INFR-03 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-03-10*
*Last updated: 2026-03-10 after roadmap creation*
