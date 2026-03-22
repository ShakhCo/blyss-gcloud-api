# Project Research Summary

**Project:** BLYSS Instagram DM Booking Automation (v2.0)
**Domain:** Conversational booking automation via Instagram Messaging API
**Researched:** 2026-03-22
**Confidence:** HIGH

## Executive Summary

BLYSS v2.0 adds a complete booking flow inside Instagram DMs — no web redirect, no app download. A customer messages a barbershop, taps quick-reply buttons to select a service, date, time, and employee, verifies via OTP, and receives a confirmed booking without leaving Instagram. The existing codebase already handles the hardest parts: webhook ingress, HMAC verification, OTP/SMS via Eskiz, Firestore state, and booking creation. The implementation is an extension of the existing comment-reply system — same webhook URL, same handler file, same patterns — with zero new npm packages required.

The single most critical external dependency is the Meta App Review for the `instagram_business_manage_messages` permission. This review takes 2–6 weeks and cannot be skipped. Development must start on day 1 with the OAuth scope update and review submission, otherwise the entire milestone can be blocked by a third-party queue. All other development can proceed in parallel using Meta test accounts while the review is pending. All existing connected businesses must re-authorize after the scope change — a re-auth prompt must be added to the business settings flow as part of Phase 1.

The recommended build order is three strict phases driven by hard dependencies: (1) infrastructure and permissions — OAuth scope, webhook subscriptions, Firestore data model, echo filter — because every subsequent line of code depends on these being correct from the start; (2) message construction and conversation state engine — the step-routing dispatcher, quick-reply builder with 20-char truncation and 13-button overflow handling, and TTL-enforced session management; (3) the booking flow itself — language selection through booking confirmation — built sequentially because each step can only be tested by completing the previous step in a real DM conversation. A fourth phase handles post-launch improvements once real usage signals justify them.

## Key Findings

### Recommended Stack

No new dependencies are needed. The existing stack — Express.js v5, Firestore, built-in crypto, Eskiz SMS, and the existing `fetch`-based Instagram Graph API client — handles everything the DM feature requires. The only stack changes are an OAuth scope addition and a new Firestore collection (`dm_conversations`).

**Core technologies:**
- **Express.js v5 + existing webhook handler** — DM events arrive at the same URL as comment events (`POST /instagram-webhook/`); add a second `entry.messaging` branch, not a second route
- **Firestore `dm_conversations` collection** — conversation state per `{businessId}_{senderIgScopedId}` composite key with 30-minute TTL; same TTL pattern as the existing `commenters` collection
- **Instagram Graph API v21.0 `/{igId}/messages`** — new endpoint for sending quick-reply messages and generic templates; uses existing page access token
- **`instagram_business_manage_messages` OAuth scope** — the only new API permission; requires Meta Advanced Access review (2–6 weeks lead time)
- **`src/utils/createBooking.js` + `src/utils/otpAuth.js` (extractions)** — booking logic extracted from `bot.js` and OTP logic standardized into shared utilities; reused by both `bot.js` and the DM handler

### Expected Features

**Must have (table stakes — v2.0 launch):**
- Any message triggers the flow — no keyword required; bot responds to all incoming DMs
- Language selection (Uzbek / Russian) as the first interaction — two quick-reply buttons
- Main menu with Book, Location, Working Hours, Contact quick-reply buttons
- Service selection as quick-reply buttons with automatic carousel fallback for businesses with 13+ services
- Date selection showing next 7 days with day names in chosen language, not date strings
- Time slot selection calling existing `/available-slots-v2` with total selected duration
- Employee selection calling existing `/slot-employees` with "Any barber" fallback
- Phone number collection with format validation before OTP send
- OTP verification via existing Eskiz SMS infrastructure
- Booking confirmation message including service, date, time, employee, and reference number
- Info responses: location (Google Maps link), working hours by day, contact phone number
- Per-business toggle (`dm_automation_enabled`) on `instagram_connection` document for safe rollout

**Should have (differentiators — add after v2.0 validation):**
- Multiple service selection with accumulated duration before proceeding to date (upsell path)
- Return user recognition — skip OTP for users previously verified in the same business
- Language preference persistence across sessions — skip language prompt for returning users
- Graceful out-of-slots handling — auto-suggest next available date instead of empty state
- Admin Telegram notification on DM booking — reuse existing `sendTelegramMessage` utility

**Defer (v3+):**
- Booking cancellation via DM — requires conversation lookup of existing bookings and cancellation logic; high error risk
- Reschedule via DM — builds on cancellation; even more complex
- Booking reminders — use Eskiz SMS, not DM (Instagram's 24-hour messaging window makes DM reminders technically non-compliant unless the customer messages first)

### Architecture Approach

The DM handler lives in the existing `src/routes/instagram-webhook.js` file alongside the comment handler. The POST webhook handler is extended with an `entry.messaging` branch that invokes `handleDmEvent()` — a pure addition that leaves `handleCommentEvent()` completely unchanged. Conversation state flows through a `routeDmStep()` function that returns `{ newState, messages }` without direct Firestore writes, enabling unit testing of each step in isolation. The orchestrator writes state and sends DM replies after receiving the step result.

**Major components:**
1. **`handleDmEvent()` in `instagram-webhook.js`** — DM orchestration: resolve business via `collectionGroup` query, check `dm_automation_enabled`, load conversation state, route step, write state, send replies; same never-throw error contract as comment handler
2. **`routeDmStep()` + per-step handlers** — linear state machine (LANGUAGE_SELECT → MAIN_MENU → SERVICE_SELECT → DATE_SELECT → TIME_SELECT → EMPLOYEE_SELECT → AUTH_PHONE_REQUEST → AUTH_OTP_VERIFY → BOOKING_CONFIRM → DONE); each `handle*Step()` function returns `{ newState, messages }` with no side effects
3. **`dm_conversations` Firestore collection** — document keyed by `{businessId}_{senderIgScopedId}`; 30-minute TTL via `expires_at` field with Firestore TTL policy; stores all accumulated booking data across multiple DM exchanges
4. **`sendDmMessage()` in `src/utils/instagram.js`** — new export for POSTing to `/{igId}/messages` with quick-reply and generic template support; max 13 quick replies, 20-char titles
5. **`src/utils/createBooking.js` + `src/utils/otpAuth.js`** — extracted shared utilities; enables both `bot.js` and the DM handler to create bookings and handle OTP without code duplication

### Critical Pitfalls

1. **Missing `instagram_business_manage_messages` permission blocks all DM features in production** — the app works with test accounts in dev mode but fails with `(#200) App does not have Advanced Access` for real businesses. Submit Meta App Review on day 1; add all team members as app testers for dev. The 2–6 week review is the milestone's single longest dependency.

2. **`is_echo: true` events cause an infinite bot reply loop** — every message the bot sends is echoed back as a webhook `messages` event. Without filtering, the bot replies to its own messages, hits the 200 DMs/hour rate limit in seconds, and gets the Instagram account flagged. The very first check in every DM event handler must be: `if (event.message?.is_echo === true) return;`.

3. **DM events are in `entry.messaging`, not `entry.changes` — same webhook URL, different payload shape** — the existing handler only reads `entry.changes`. DM events are silently ignored without the `entry.messaging` branch. Also requires subscribing to both `messages` AND `messaging_postbacks` in the Meta webhook dashboard — without `messaging_postbacks`, quick reply button taps never trigger server-side handling.

4. **IGSID is scoped per business, not per user** — the same Instagram user has a different `sender.id` for every business they message. Conversation state keyed only on `sender.id` without `businessId` merges state across unrelated businesses. All `dm_conversations` paths must be `businesses/{businessId}/dm_conversations/{igsid}` or a composite top-level key `{businessId}_{igsid}`.

5. **Slot race condition — two users confirm the same slot simultaneously** — the availability snapshot shown to the user is stale by the time they confirm. The booking confirmation step must re-verify slot availability inside a Firestore transaction and return `SLOT_TAKEN` on conflict, then immediately offer updated available slots.

6. **Quick reply titles truncated at 20 characters; max 13 buttons per message** — service names longer than 20 characters display as garbled labels. Businesses with 14+ services cause API errors if sent as quick replies. Implement `truncateForQuickReply()` utility and automatic generic template (carousel) fallback before any step that shows variable-length lists.

## Implications for Roadmap

The build has a clear hard dependency chain that drives phase structure. All infrastructure decisions (permissions, data model, echo filter, webhook payload handling) must be correct before any conversational logic can be tested. The Meta App Review timeline is the only external dependency and must be started immediately — it is the only thing that cannot be done in parallel with code writing.

### Phase 1: Infrastructure and Permissions

**Rationale:** Every subsequent phase depends on these decisions being correct from the start. Getting the Firestore path wrong (unscoped IGSID) requires a data migration later. Not submitting the Meta App Review now risks blocking the entire milestone for 2–6 weeks. The echo filter must be in place before the webhook receives any real DM events. All four actions in this phase must complete before Phase 2 code can be meaningfully tested.

**Delivers:** A fully wired DM event pipeline that safely receives and routes DM events, filters echo events, and checks per-business feature flags — but sends no replies yet. Meta App Review submitted. Existing connected businesses notified to re-authorize via an updated re-auth flow in business settings.

**Addresses:** OAuth scope upgrade (`instagram_business_manage_messages`), webhook `messages` and `messaging_postbacks` subscriptions, `dm_automation_enabled` toggle on `instagram_connection`, `dm_conversations` Firestore schema and TTL policy, `sendDmMessage()` utility stub.

**Avoids:** Pitfall 1 (missing permission), Pitfall 2 (echo infinite loop), Pitfall 3 (wrong webhook payload branch), Pitfall 4 (unscoped IGSID), token expiry silent failure.

### Phase 2: Message Construction and Conversation State Engine

**Rationale:** All step handlers in Phase 3 depend on the same message-building and routing infrastructure. Building `routeDmStep()`, the quick-reply builder with limit handling, and session timeout/reset before any step handler is written means Phase 3 steps slot in cleanly and the 13-button and 20-character constraints are solved once, not re-solved per step. This phase ends with a working language selection + main menu that can be tested end-to-end via a real DM.

**Delivers:** Working `routeDmStep()` dispatcher with per-step function stubs; `sendDmMessage()` sending actual quick-reply messages; 24-hour window check before every outbound send; session timeout and clean restart on TTL expiry; `truncateForQuickReply()` and carousel fallback for 13+ buttons; language selection and main menu as the first fully functional user-visible steps.

**Addresses:** Language selection, main menu, conversation state schema, session timeout, button/message construction utilities.

**Avoids:** Pitfall 5 (24-hour messaging window), Pitfall 7 (button text truncation), Pitfall 8 (13-button overflow to carousel), UX pitfall of no timeout recovery.

**Research flag:** Standard patterns — fully documented by Meta API docs and comparable to the existing Telegram bot inline keyboard patterns in `bot.js`. No additional phase research needed.

### Phase 3: Booking Flow Steps

**Rationale:** Each step advances the conversation to the next step — you cannot test `handleTimeSelect` without having completed `handleServiceSelect` and `handleDateSelect` in the same DM conversation. Steps must be implemented in dependency order: service → date → time → employee → phone/OTP → confirm. Booking confirmation requires the `createBooking.js` utility to be extracted from `bot.js` first, and the slot re-check transaction must be implemented in the confirmation step (not deferred).

**Delivers:** The complete end-to-end booking flow: a customer can message any connected barbershop via Instagram DM and complete a full appointment booking without leaving the Instagram app.

**Addresses:** All P1 features from FEATURES.md — service selection (with multi-service accumulation), date/time/employee selection, OTP auth, booking creation via `/bot/bookings`, booking confirmation message, location/hours/contact info responses.

**Avoids:** Pitfall 6 (slot race condition via Firestore transaction at confirmation), OTP security pitfall (no OTP values in postback payloads), N+1 employee reads (use existing `/slot-employees` endpoint), duplicate booking logic (extract to `createBooking.js`).

**Research flag:** No additional research needed — all API endpoints (`/available-slots-v2`, `/slot-employees`, `/bot/bookings`) are existing and verified by direct codebase analysis. Booking logic extraction from `bot.js` is straightforward refactoring.

### Phase 4: Post-Launch Improvements (v2.x)

**Rationale:** These features add meaningful UX value but none are blockers for launch. They are appropriately triggered by real usage signals: users complaining about re-entering their phone number on every booking (return user recognition), businesses requesting instant notifications (Telegram notify), or testing revealing dead-end states (out-of-slots handling). Shipping them before these signals appear would be premature optimization.

**Delivers:** Return user recognition with OTP skip for previously verified users; language preference persistence across sessions; graceful out-of-slots handling with next-available-date suggestion; admin Telegram notification on DM booking creation via existing `sendTelegramMessage` utility.

**Addresses:** All P2 features from FEATURES.md.

### Phase Ordering Rationale

- **Phase 1 before Phase 2:** The Firestore data model (IGSID scoping) and OAuth scope must be set correctly before any conversation state code is written. Changing the Firestore path after conversations exist requires a full data migration.
- **Phase 2 before Phase 3:** All step handlers share the same message-building and routing infrastructure. Building the infrastructure first with a simple step (language selection) allows Phase 3 steps to slot in without re-solving the same constraints.
- **Phase 3 in strict step order:** Each step is tested by completing the previous step in a real DM conversation — the dependency is inherent to how the state machine works, not just a convenience.
- **Phase 4 after Phase 3 ships:** Trigger conditions for v2.x improvements (user feedback, business owner requests) are not observable until Phase 3 is in production.
- **Meta App Review submitted in Phase 1:** The 2–6 week review is the only external timeline dependency. Delaying submission by even one sprint risks blocking all three implementation phases.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1 — Meta App Review submission:** The review documentation is clear, but the specific submission checklist (video demo requirements, privacy policy format, data handling questionnaire for `instagram_business_manage_messages`) should be reviewed in detail before submission to avoid a rejection that adds another 2-week cycle.

Phases with standard patterns (skip research-phase):
- **Phase 2:** Quick reply and carousel message construction is fully documented in Meta API docs and the patterns are comparable to the Telegram inline keyboard handling already in `bot.js`.
- **Phase 3:** All API endpoints are existing and verified by direct code analysis. Booking and OTP extraction from `bot.js` is standard Node.js refactoring with no new patterns.
- **Phase 4:** All v2.x features reuse existing infrastructure (Firestore lookups, `sendTelegramMessage` utility). No new patterns introduced.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new packages; all existing integrations verified against live codebase and official Meta API docs; Instagram Graph API v21.0 endpoints confirmed |
| Features | HIGH | Feature set derived directly from `.planning/PROJECT.md` Active list + official Instagram API capability inventory; anti-features are reasoned against hard API constraints (24-hour window, no payment API) |
| Architecture | HIGH | Based on direct source code analysis of `instagram-webhook.js`, `bot.js`, `utils/instagram.js` plus verified Meta webhook payload documentation; build order follows hard dependency chain |
| Pitfalls | HIGH (critical), MEDIUM (rate limits, race conditions) | Permission, echo, webhook shape, IGSID scoping pitfalls verified against official Meta docs; 200 DMs/hour rate limit and race condition patterns from MEDIUM-confidence secondary sources |

**Overall confidence:** HIGH

### Gaps to Address

- **Meta App Review timeline:** The 2–6 week range is cited from multiple sources but actual duration varies. If the review is rejected on the first submission, the retry cycle could extend the milestone significantly. Mitigation: submit with a complete video demo of the full flow, a clear privacy policy URL, and a thorough data handling questionnaire on the first attempt.
- **Instagram rate limit (200 DMs/hour):** Cited in multiple secondary sources but not confirmed in a single primary Meta docs URL during this research session. At current BLYSS barbershop scale this limit is not a concern, but should be verified before any high-volume or enterprise business deployment.
- **`messaging_postbacks` webhook field requirement:** Research confirms that quick reply button taps fire as `messaging_postbacks` events (not `messages`), requiring both fields to be subscribed in the Meta webhook dashboard. The exact field names should be verified against the current app configuration in the Meta Developer Console during Phase 1.
- **OTP collection key for DM users:** The existing `bot_otps` collection uses `telegram_id` as the user key. DM users have no Telegram ID — a separate field (`ig_sender_id`) must be added to support DM-originated OTP requests without conflicting with the Telegram bot's OTP flow.

## Sources

### Primary (HIGH confidence)
- Codebase: `src/routes/instagram-webhook.js`, `src/routes/instagram.js`, `src/routes/bot.js`, `src/routes/public.js`, `src/utils/instagram.js`, `firestore.indexes.json`
- `.planning/PROJECT.md` — milestone scope, active features list, existing infrastructure inventory
- [Instagram Messaging API — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/) — required permissions, message types, 24-hour window constraint
- [Instagram Webhooks — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/webhooks/) — `messages` subscription field, `entry.messaging` payload structure
- [Instagram Generic Template Limits — Meta Docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template/) — 10 elements max, 3 buttons per element, 80-char title
- [Instagram Messaging Webhooks — Messenger Platform Docs](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/) — `is_echo` field, postback events, `entry.messaging` payload
- [Instagram App Review — Meta Docs](https://developers.facebook.com/docs/instagram-platform/app-review/) — Advanced Access requirements, review process

### Secondary (MEDIUM confidence)
- [Quick Replies Guide — GoHighLevel](https://help.gohighlevel.com/support/solutions/articles/155000004035-guide-to-quick-replies-for-facebook-instagram) — 13 button limit, 20-character title limit (consistent with multiple sources)
- [Instagram API Rate Limits — CreatorFlow 2026](https://creatorflow.so/blog/instagram-api-rate-limits-explained/) — 200 DMs/hour rate limit
- [Race Conditions in Firestore — QuintoAndar Tech Blog](https://medium.com/quintoandar-tech-blog/race-conditions-in-firestore-how-to-solve-it-5d6ff9e69ba7) — transaction patterns for concurrent booking
- [24-Hour Messaging Window — Manychat Help](https://help.manychat.com/hc/en-us/articles/14281199732892) — window behavior, expiry implications for multi-step flows
- [IGSID Scoping — CM.com Instagram Messaging Docs](https://developers.cm.com/messaging/docs/instagram-messaging) — per-business IGSID scoping confirmed
- [ManyChat Instagram Booking Flow — FletchApp](https://fletchapp.com/instagram-dm-automation-with-manychat-how-it-works/) — industry booking flow pattern reference

---
*Research completed: 2026-03-22*
*Ready for roadmap: yes*
