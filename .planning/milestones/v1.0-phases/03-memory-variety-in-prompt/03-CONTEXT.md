# Phase 3: Memory & Variety in Prompt - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Inject commenter history and post reply data into `buildSystemPrompt()` to enable returning-commenter recognition, reply variety (no duplicate openers), post type adaptation, and engagement follow-up questions. No new Firestore reads or writes — data is already wired in from Phase 2; writes happen in Phase 4.

</domain>

<decisions>
## Implementation Decisions

### Returning Commenter Recognition (PERS-03)
- Threshold: `comment_count >= 2` triggers returning-commenter path
- Include actual `comment_count` and `first_seen_at` in prompt — AI calibrates warmth (2-3: casual nod, 4+: warmer)
- Acknowledge return subtly, ~1 in 3 replies — not every time (gets robotic)
- Do NOT quote their `last_comment_text` — just recognize their return ("glad to see you again")
- First-timers (null commenterHistory or count < 2): standard warm reply, no special treatment

### Follow-up Question Behavior (PERS-04)
- Trigger on: genuine praise, curiosity comments, experience sharing — but ONLY for returning visitors (comment_count >= 2)
- First-timers never get follow-up questions — keep it simple for new faces
- Question style: service-related — naturally leads to exploring the business ("Qaysi uslubni yoqtirasiz?", "Sizga ham sinab ko'rmoqchimisiz?")
- Not every qualifying comment gets a question — AI's discretion on when it feels natural

### Post Type Classification (QUAL-03, QUAL-04)
- Classification via prompt-based heuristics — no code logic, no separate API call
- AI self-classifies from caption keywords:
  - Promo: aksiya, chegirma, discount, sale, skidka
  - Before/after: oldin/keyin, result, natija, transformation
  - Milestone: anniversary, yil, oy, 1000, congratulations
  - General: everything else
- Tone adaptation per type:
  - Promo → urgency language ("Hozir band bo'ling!")
  - Before/after → celebrate transformation ("Zo'r natija!")
  - Milestone → celebratory ("Tabriklaymiz!")
  - General → standard warm persona

### Reply Deduplication (QUAL-01, QUAL-02)
- Inject last 5 recent reply texts from `postReplies.recent_replies` as negative examples in prompt
- Full reply text, not just openers — gives AI style context for broader variety
- Explicit instruction: "Do NOT start your reply with the same word as any of these"
- When `postReplies` is null (no prior replies on this post): skip section entirely

### Claude's Discretion
- Exact prompt section wording and placement within `buildSystemPrompt()`
- How to format the recent replies list (numbered, bulleted, etc.)
- Whether to include post type classification as a separate section or inline with existing routing rules
- Balance between follow-up question frequency and natural conversation flow

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildSystemPrompt()` in `instagram-webhook.js` — already accepts `commenterHistory` and `postReplies` params (ignored since Phase 2). This phase adds prompt sections that use them.
- `postCaption` already available in prompt — post type classification reads from this
- Existing comment-type routing sections (BOOKING-INTENT, REACTIONS, NEGATIVE, SPAM) — follow-up question rules integrate alongside these

### Established Patterns
- Prompt sections use uppercase headers (e.g., `REPLY LENGTH:`, `EMOJI USAGE:`)
- Conditional sections: `if (username)` pattern for optional prompt blocks
- 78 existing tests in `instagram-webhook.test.js` with Firestore mocks

### Integration Points
- `buildSystemPrompt()` lines 118-119 — `commenterHistory` and `postReplies` params ready to use
- New prompt sections slot between existing Section 4 (comment-type routing) and Section 5 (example replies)
- `postCaption` already injected in Section 2 — post type classification references it

</code_context>

<specifics>
## Specific Ideas

- Follow-up questions should feel like a skilled barber/stylist making conversation, not a marketing bot probing for leads
- "Qaysi uslubni yoqtirasiz?" is the gold standard — service-relevant, conversational, not pushy
- The ~1-in-3 frequency for returning commenter acknowledgment keeps it from feeling programmatic

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-memory-variety-in-prompt*
*Context gathered: 2026-03-10*
