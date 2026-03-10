# BLYSS Instagram AI Auto-Reply

## What This Is

An AI-powered Instagram comment auto-reply system for barbershops and salons on the BLYSS platform. When someone comments on a business's Instagram post, the AI replies automatically — sounding like a witty, playful human social media manager who keeps the comments section alive and engaging.

## Core Value

Every AI reply should be indistinguishable from a skilled human social media manager — engaging, witty, and natural enough that people reply back.

## Requirements

### Validated

- ✓ Instagram webhook receives comment events — existing
- ✓ AI-generated replies via OpenAI (o4-mini) — existing
- ✓ Business context in prompts (name, bio, location, hours, services, employees, booking link) — existing
- ✓ Post caption and timestamp awareness — existing
- ✓ Static template and AI reply modes with per-post overrides — existing
- ✓ Language matching (uz/ru/en) based on comment — existing
- ✓ Spam detection and skip (__SKIP__) — existing
- ✓ Dedup via hasExistingReply check — existing
- ✓ Admin Telegram notifications for each reply — existing
- ✓ Custom AI instructions and example replies per business — existing

### Active

- [ ] AI personality overhaul — replies sound like a witty, playful friend, not a formal business
- [ ] Commenter name personalization — use @username naturally in replies
- [ ] Comment history awareness — know if someone has commented before, reference past interactions
- [ ] Richer post context — understand what the post is about (promo, before/after, new service, etc.)
- [ ] Reply variety — prevent repetitive patterns across comments on the same post
- [ ] Engagement-driving replies — ask follow-up questions, spark conversation, not just answer and link

### Out of Scope

- DM auto-replies — different system, different Instagram permissions
- Comment moderation (hiding/deleting) — out of scope for this iteration
- Scheduled replies / delayed posting — adds complexity, not needed now
- Multi-language within single reply — match one language per reply

## Context

The current system (`src/routes/instagram-webhook.js`) already handles the full pipeline: webhook verification, comment routing, business context building, AI generation, and reply posting. The AI prompt is detailed but produces replies that feel too corporate — every reply pushes a booking link, uses formal language, and follows a rigid template structure.

The business context builder (`buildBusinessInfo`) already fetches services, employees, working hours, and location. Post captions and timestamps are fetched. The commenter's username is available from the webhook payload (`commentData.from.username`).

What's missing: comment history (no tracking of previous commenters), and the prompt itself needs a personality overhaul from "helpful business bot" to "engaging social media person."

Key files:
- `src/routes/instagram-webhook.js` — main auto-reply logic and AI prompt
- `src/utils/instagram.js` — Instagram Graph API utilities
- `src/routes/ai.js` — separate AI routes (translate/validate)

## Constraints

- **API**: Instagram Graph API v21.0, comment reply endpoint
- **Model**: Currently using OpenAI o4-mini with low reasoning effort
- **Latency**: Webhook must respond quickly — Cloud Run CPU allocated during processing
- **Rate limits**: Instagram API rate limits on comment replies
- **Token cost**: Replies are high volume; model choice matters for cost

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Use o4-mini for replies | Balance cost vs quality for high-volume comment replies | — Pending (may need stronger model for personality) |
| Track comment history in Firestore | Need to know if commenter has interacted before | — Pending |
| Personality via prompt engineering | Cheapest path — improve prompts before changing architecture | — Pending |

---
*Last updated: 2026-03-10 after initialization*
