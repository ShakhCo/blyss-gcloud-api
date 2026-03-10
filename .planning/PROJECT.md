# BLYSS Instagram AI Auto-Reply

## What This Is

An AI-powered Instagram comment auto-reply system for barbershops and salons on the BLYSS platform. When someone comments on a business's Instagram post, the AI replies automatically — sounding like a witty, playful human social media manager who keeps the comments section alive and engaging. The system tracks returning commenters, adapts tone to post type, and avoids repetitive replies.

## Core Value

Every AI reply should be indistinguishable from a skilled human social media manager — engaging, witty, and natural enough that people reply back.

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

(None — next milestone not yet planned)

### Out of Scope

- DM auto-replies — different system, different Instagram permissions
- Comment moderation (hiding/deleting) — out of scope for this iteration
- Scheduled replies / delayed posting — adds complexity, not needed now
- Multi-language within single reply — match one language per reply
- AI-generated hashtags in replies — no human puts hashtags in comment replies
- Self-introduction in replies — account name is visible, introducing yourself is absurd
- Commenter's previous comment text quoted in prompt — privacy concerns and prompt injection risk
- AI classification sub-call for post type — keyword heuristics work well enough for now

## Context

**Current state:** v1.0 shipped (2026-03-10). The Instagram auto-reply system now produces human-quality replies with commenter memory, reply variety, and post-type awareness. 127 unit tests cover all behavior.

**Codebase:**
- `src/routes/instagram-webhook.js` — 706 lines, main auto-reply logic with `buildSystemPrompt()`, `buildBusinessInfo()`, `getCommenterHistory()`, `getPostReplies()`, `updateCommenterHistory()`, `updatePostReplies()`
- `src/routes/instagram-webhook.test.js` — 1,415 lines, 127 unit tests
- `firestore.indexes.json` — TTL policies for commenter and post reply collections

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
*Last updated: 2026-03-10 after v1.0 milestone*
