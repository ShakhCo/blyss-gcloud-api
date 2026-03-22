# BLYSS Instagram Automation

## What This Is

Instagram automation for barbershops and salons on the BLYSS platform. Two systems: (1) AI-powered comment auto-replies that sound like a skilled human social media manager, and (2) static button-based DM booking automation that walks customers through the full booking flow — service selection, date, time, employee, and confirmation — entirely within Instagram DMs.

## Core Value

Turn Instagram engagement into real bookings — comments get human-quality replies, DMs convert to confirmed appointments.

## Current Milestone: v2.0 Instagram DM Booking Automation

**Goal:** Enable customers to book appointments entirely through Instagram DMs using a static, button-driven flow — no AI, no web redirect needed.

**Target features:**
- Language selection (uz/ru) as first interaction
- Main menu with quick-reply buttons (Book, Location, Working Hours, Contact)
- Full booking flow: services → date → time slot → employee → confirmation
- Multiple service selection support
- Phone + OTP authentication in DMs
- Conversation state management with timeout handling
- Optional per-business toggle in instagram_connection settings

## Requirements

### Validated

- ✓ Instagram webhook receives comment events — existing
- ✓ AI-generated replies via OpenAI — existing
- ✓ Business context in prompts (name, bio, location, hours, services, employees, booking link) — existing
- ✓ Post caption and timestamp awareness — existing
- ✓ Static template and AI reply modes with per-post overrides — existing
- ✓ Language matching (uz/ru/en) based on comment — existing
- ✓ Spam detection and skip (__SKIP__) — existing
- ✓ Dedup via hasExistingReply check — existing
- ✓ Admin Telegram notifications for each reply — existing
- ✓ Custom AI instructions and example replies per business — existing
- ✓ AI personality overhaul — warm, playful, human persona — v1.0
- ✓ Commenter name personalization — @username used naturally — v1.0
- ✓ Comment history awareness — returning commenters acknowledged differently — v1.0
- ✓ Richer post context — post type classification (promo, before/after, milestone) — v1.0
- ✓ Reply variety — deduplication via recent replies tracking — v1.0
- ✓ Engagement-driving replies — follow-up questions on genuine praise — v1.0
- ✓ AI model optimized — gpt-4.1-mini with temperature 0.9 — v1.0
- ✓ Prompt architecture — buildSystemPrompt() pure function with layered sections — v1.0
- ✓ Parallel Firestore reads — Promise.all for business info + history — v1.0
- ✓ Commenter memory persistence — fire-and-forget Firestore writes with TTL — v1.0
- ✓ Booking link routing — only on booking intent, not on praise/emoji/negative — v1.0

### Active

- [ ] Language selection buttons (uz/ru) on first DM interaction
- [ ] Main menu with quick-reply buttons (Book, Location, Working Hours, Contact)
- [ ] Service selection with multiple service support
- [ ] Date selection (next 7 days)
- [ ] Time slot selection from available slots
- [ ] Employee selection from available employees per service
- [ ] Phone + OTP authentication within DM flow
- [ ] Booking creation and confirmation message
- [ ] Conversation state management with timeout handling
- [ ] Per-business DM automation toggle in instagram_connection settings
- [ ] Info responses for Location, Working Hours, and Contact buttons

### Out of Scope

- ~~DM auto-replies~~ — moved to Active for v2.0
- Comment moderation (hiding/deleting) — out of scope for this iteration
- Scheduled replies / delayed posting — adds complexity, not needed now
- Multi-language within single reply — match one language per reply
- AI-generated hashtags in replies — no human puts hashtags in comment replies
- Self-introduction in replies — account name is visible, introducing yourself is absurd
- Commenter's previous comment text quoted in prompt — privacy concerns and prompt injection risk
- AI classification sub-call for post type — keyword heuristics work well enough for now

## Context

**Current state:** v1.0 shipped (2026-03-10). The Instagram auto-reply system now produces human-quality replies with commenter memory, reply variety, and post-type awareness. 127 unit tests cover all behavior. v2.0 adds DM booking automation.

**Codebase:**
- `src/routes/instagram-webhook.js` — 706 lines, comment auto-reply logic
- `src/routes/instagram-webhook.test.js` — 1,415 lines, 127 unit tests
- `src/routes/instagram.js` — Instagram OAuth, settings, post management
- `src/routes/public.js` — Available slots, slot employees, booking creation endpoints
- `src/routes/bot.js` — Bot booking creation (HMAC only, no JWT)
- `firestore.indexes.json` — TTL policies for commenter and post reply collections

**Landing page booking flow (reference for DM flow):**
- GET `/public/businesses/:businessId/services` — services, employees, photos
- GET `/public/businesses/:businessId/available-slots-v2` — 15-min time slots
- GET `/public/businesses/:businessId/slot-employees` — employees at specific slot
- POST `/public/businesses/:businessId/bookings-v2` — create booking (JWT required)
- POST `/bot/bookings` — create booking (HMAC only, no JWT)

**Known issues:**
- `server.test.js` fails without `JWT_SECRET` env var (pre-existing, unrelated)
- `first_seen_at` overwritten on each write due to merge:true semantics (documented decision)
- Instagram OAuth token expiry silently kills auto-reply — token alerting/refresh not yet addressed

## Constraints

- **API**: Instagram Graph API v21.0, comment reply endpoint
- **Model**: OpenAI gpt-4.1-mini with temperature 0.9 via chat.completions.create
- **Latency**: Webhook must respond quickly — Cloud Run CPU allocated during processing
- **Rate limits**: Instagram API rate limits on comment replies
- **Token cost**: Replies are high volume; gpt-4.1-mini balances cost vs quality

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Switch from o4-mini to gpt-4.1-mini | Balance cost vs quality for chat-style replies | ✓ Good — better persona quality at lower cost |
| buildSystemPrompt() as pure named export | Enable unit testing without mocks | ✓ Good — 127 tests, zero mock complexity |
| Personality via prompt engineering | Cheapest path — improve prompts before changing architecture | ✓ Good — dramatic quality improvement with no new infrastructure |
| Track commenter history in Firestore | Need to know if commenter has interacted before | ✓ Good — enables personalization with TTL auto-cleanup |
| Booking link only in BOOKING-INTENT section | Stop booking link spam on praise/emoji/negative comments | ✓ Good — core quality improvement |
| Fire-and-forget writes | Don't delay webhook response for history persistence | ✓ Good — zero latency impact, catch() prevents crashes |
| merge:true for commenter docs | Preserve first_seen_at on subsequent writes | ⚠️ Revisit — actually overwrites first_seen_at |
| read-modify-write for post replies | Enforce slice(-8) cap (arrayUnion has no length limit) | ✓ Good — predictable cap, no unbounded growth |
| All sections in else branch only | Per-post AI instructions override path unaffected | ✓ Good — clean separation of concerns |

---
*Last updated: 2026-03-22 after v2.0 milestone start*
