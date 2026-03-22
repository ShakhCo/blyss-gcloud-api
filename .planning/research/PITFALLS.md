# Pitfalls Research

**Domain:** Instagram DM Booking Automation added to existing Instagram comment reply system
**Researched:** 2026-03-22
**Confidence:** HIGH (API limits, permission requirements, webhook structure verified against official Meta docs; MEDIUM for race condition patterns from general distributed systems literature)

---

## Critical Pitfalls

### Pitfall 1: Missing `instagram_business_manage_messages` — App Blocked in Production

**What goes wrong:**
The current OAuth scope (`instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_insights`) does not include `instagram_business_manage_messages`. Without this scope the app cannot send DMs, receive DM webhooks, or read conversation state. The app works fine in dev/test mode with test accounts — then silently fails or throws `(#200) App does not have Advanced Access to instagram_manage_messages permission` in production when a real business user messages the connected account.

**Why it happens:**
The existing comment reply system only needed `instagram_business_manage_comments`. Adding DM capability looks like just a code change — developers forget that Meta treats messaging as a separate, heavily reviewed permission requiring Advanced Access approval. The app review process for `instagram_business_manage_messages` takes 2–6 weeks and requires a privacy policy URL, a screencast of the full flow, and a completed data handling questionnaire. Scopes deprecated on January 27, 2025 — old scope names also break silently.

**How to avoid:**
1. Add `instagram_business_manage_messages` to the OAuth scope string in `src/utils/instagram.js` `getOAuthUrl()` immediately on day 1.
2. Submit the Meta App Review for Advanced Access on day 1 — before writing a single line of DM code. A 2–6 week review is the longest lead time in this entire milestone.
3. During development, add all team Instagram accounts as app testers in the Meta dashboard so the app functions in development mode while review is pending.
4. Businesses that already connected will need to re-authorize after the scope change — plan a re-auth prompt in the existing settings flow.

**Warning signs:**
- App works for accounts with the app tester role but not for real connected businesses
- Webhook delivers comment events but no `messaging` events appear in logs
- API call to send DM returns `(#200) App does not have Advanced Access`

**Phase to address:** Phase 1 — must be the first action before any DM code is written

---

### Pitfall 2: DM Events Use `entry.messaging`, Comments Use `entry.changes` — Same Webhook URL, Different Payload Shape

**What goes wrong:**
The existing handler in `instagram-webhook.js` iterates `entry.changes` and routes on `change.field === 'comments'`. DM message events arrive in `entry.messaging` (an array directly under `entry`), not in `entry.changes`. If you only look at `entry.changes`, DM events are silently ignored — no log, no error, no reply. Additionally, quick reply taps fire as `messaging_postbacks` events, not `messages` events, requiring a second branch in the handler.

**Why it happens:**
Comment events and DM events are conceptually both "Instagram events" but use entirely different payload structures — a Meta design artifact from when Instagram messaging was built on top of the Messenger Platform. Developers assume the webhook payload is uniform across all Instagram event types.

**How to avoid:**
Extend the existing `router.post('/')` handler to check both shapes in the same request body:
```js
// Existing comments path — entry.changes
if (change.field === 'comments') { handleCommentEvent(...) }

// New DMs and postbacks path — entry.messaging
if (Array.isArray(entry.messaging)) {
  for (const event of entry.messaging) {
    if (event.message?.is_echo) continue; // CRITICAL: filter bot's own messages
    if (event.message) { handleDmEvent(...) }
    if (event.postback) { handlePostbackEvent(...) }
  }
}
```
Also subscribe to `messages` and `messaging_postbacks` in the Meta webhook dashboard — the existing subscription only covers `comments`.

**Warning signs:**
- DMs sent to the connected account produce zero log output from the webhook handler
- Quick reply button taps never trigger any server-side action
- Test DMs sent via the Graph API Explorer succeed but no webhook events appear in logs

**Phase to address:** Phase 1 — foundational webhook routing, must work before anything else

---

### Pitfall 3: Not Filtering `is_echo` Messages Causes Infinite Bot Reply Loop

**What goes wrong:**
Every message the bot sends is echoed back to the webhook as a `messages` event with `message.is_echo === true`. Without filtering these, the webhook handler treats the bot's own DM as a user message, responds to it, which creates another echo, which triggers another response — a self-amplifying loop that exhausts the 200 messages/hour rate limit in seconds and gets the Instagram account flagged.

**Why it happens:**
The Instagram Messaging API is built on the Messenger Platform, which sends echo events for every outbound message your app sends. Developers implementing the `messages` subscription receive these echoes but don't know to filter them until the loop starts.

**How to avoid:**
The very first check in every DM event handler must be:
```js
if (event.message?.is_echo === true) return; // Drop echoes unconditionally
```
Add a unit test that constructs a synthetic `is_echo: true` event and verifies no outbound message is sent.

**Warning signs:**
- Logs show hundreds of identical DM events per minute
- Rate limit error `(#551)` or `(#4)` appears immediately after the first bot message
- Instagram account receives its own messages appearing in the inbox

**Phase to address:** Phase 1 — must be the first line of DM event handler code

---

### Pitfall 4: IGSID Is Scoped Per Business Account, Not Per Platform User

**What goes wrong:**
The `sender.id` in a DM webhook event is an Instagram Scoped User ID (IGSID). The same physical Instagram user has a **different IGSID for each business account they message**. If BLYSS has two barbershops connected (businessA and businessB), a user who messages both will have IGSID `111` for businessA and IGSID `222` for businessB. Storing conversation state keyed only on `sender.id` without also keying on `businessId` merges state across businesses — a user in the middle of booking at businessA sees businessB's conversation state.

**Why it happens:**
Developers familiar with Telegram or WhatsApp expect a globally stable user ID. Instagram intentionally scopes IDs for privacy. The comment system uses `igCommenterId` which has the same scoping but has not caused problems because comments are always tied to a specific media object that implicitly scopes to one business.

**How to avoid:**
Always use a composite Firestore path for conversation state: `businesses/{businessId}/dm_conversations/{igsid}`. Never query `dm_conversations` without scoping to a specific `businessId`. The Firestore subcollection structure naturally enforces this if the path is designed correctly from day 1.

**Warning signs:**
- Same user booking at two BLYSS businesses ends up in the same conversation state
- Unexpected step jumps when a user messages a second connected account
- `dm_conversations` documents accumulate at a top-level collection path, not under a business

**Phase to address:** Phase 1 — data model design, must be correct before conversation state code is written

---

### Pitfall 5: The 24-Hour Messaging Window Kills Mid-Booking Conversations

**What goes wrong:**
Instagram only allows sending a DM to a user if that user sent a message within the past 24 hours. If a user starts the booking flow, selects a service, but goes idle overnight, the next message the bot sends will fail with an error. The user's conversation state in Firestore still holds their partial booking, but the bot cannot continue. The user has no idea why the bot stopped responding.

**Why it happens:**
Booking flows take time — users start on a lunch break and return in the evening. Instagram's 24-hour window was designed for customer support responses, not multi-step transactional flows. Developers assume they can send a message whenever they need to.

**How to avoid:**
1. Store `last_user_message_at` timestamp on every conversation state document update.
2. Before sending any bot message, check if `Date.now() - last_user_message_at > 23 * 60 * 60 * 1000`. If expired, do not attempt the send — wait for the user to send a new message, then resume or restart.
3. Design the flow to be completable in a single session. Show all available time slots and employees in one step rather than spreading them across turns. Fewer round-trips = smaller window expiry risk.
4. Use 23 hours (not 24) as the threshold to account for clock drift between your server and Meta's servers.

**Warning signs:**
- API errors with error code `551` when sending messages to users who were active hours ago
- Partial bookings stuck in Firestore with stale `current_step` values from the previous day
- Users message again and receive a mid-flow response instead of a fresh start

**Phase to address:** Phase 2 — conversation state management

---

### Pitfall 6: Booking Slot Race Condition — Two Users Confirm the Same Slot

**What goes wrong:**
Two users are each in the DM booking flow for the same business. Both reach the "confirm 14:00 slot" step simultaneously. Both saw the slot as available (the availability check was performed 30 seconds earlier). Both send their confirmation. Both receive "booking confirmed." One booking is a ghost — the slot is double-booked. The barber shows two clients at 14:00.

**Why it happens:**
The available-slot check (`/public/businesses/:businessId/available-slots-v2`) and the booking creation (`/bot/bookings`) are two separate operations with a gap of several webhook round-trips and user interactions between them. In a popular barbershop on a Friday morning, multiple simultaneous conversations are common.

**How to avoid:**
1. Use a Firestore transaction in the booking creation step that atomically reads existing bookings for the slot and writes only if no conflict exists.
2. Never rely on the slot availability snapshot from the "show slots" step — always re-verify availability at the exact moment of confirmation, immediately before writing the booking document.
3. Return a specific error code (`SLOT_TAKEN`) from the booking endpoint and handle it in the DM flow: send a message saying "that slot was just taken" and immediately fetch and show updated available slots.
4. Keep conversation state TTL at 15 minutes from the slot-selection step — if a user takes longer than 15 minutes to confirm a slot, require them to re-select.

**Warning signs:**
- Double bookings visible in the admin panel for the same time at the same business
- Two Telegram admin notifications for the same slot at the same business with timestamps seconds apart
- Bot sends "booking confirmed" but the Firestore `created_at` timestamps differ by less than 5 seconds

**Phase to address:** Phase 3 — booking confirmation step

---

### Pitfall 7: Quick Reply Button Text Truncated at 20 Characters

**What goes wrong:**
Instagram enforces a hard 20-character limit on quick reply button text. Text exceeding 20 characters is silently truncated in the Instagram UI. Service names like "Стрижка + борода (комбо)" or "Haircut + Beard Combo" exceed 20 characters and display as garbled truncated labels. The user taps the button, the postback fires correctly, but the label they saw was meaningless or confusing.

**Why it happens:**
Service names and descriptions are written by business owners for display in the web booking app where horizontal space is plentiful. The 20-character limit is Instagram-specific with no equivalent in the web or Telegram flows. Developers building the flow use raw service names without truncation logic.

**How to avoid:**
1. Write a `truncateForQuickReply(text, maxLength = 20)` utility — measure character count, not byte count (Cyrillic is multi-byte but Instagram counts characters, not bytes).
2. Use abbreviated forms as button labels when the full name is too long: "Стрижка", "Борода", "Комбо" rather than the full description.
3. For time slots, use compact format "14:00" or "14:00 (Ravshan)" — never include price or duration in the button label.
4. Test the full flow with actual Uzbek and Russian service names from real BLYSS businesses before shipping.

**Warning signs:**
- Quick reply buttons display with "…" at the end in the Instagram mobile app
- Users tap a button but cannot understand what they selected from the truncated label
- Service names longer than 20 characters appear in the business's services list

**Phase to address:** Phase 2 — button/template message construction utility

---

### Pitfall 8: More Than 13 Quick Replies Breaks the Flow for Multi-Service Businesses

**What goes wrong:**
Instagram allows a maximum of 13 quick reply buttons per message. A business with 14+ active services cannot show all services as quick replies. Attempting to send more than 13 quick replies results in an API error, the message is never delivered, and the user's conversation goes silent with no explanation. The bot appears broken.

**Why it happens:**
BLYSS businesses with full menus (haircut + beard + coloring + treatments + package combos) easily exceed 13 services. The web booking app handles this with scrollable lists. Quick replies cannot scroll — 13 is a hard ceiling. The same problem applies to date selection (7 days + pagination button = up to 8 buttons, fine) and time slots (potentially 20+ slots in a day, definitely not fine).

**How to avoid:**
1. Use the generic template (carousel) for service selection when there are more than 10 services. The generic template supports up to 10 cards, each with up to 3 postback buttons — up to 30 service options across cards, displayed as a horizontal scrollable carousel.
2. For time slots: show only the first 6–8 slots as quick replies plus a "More times" button. On "More times" tap, show the next page.
3. Add a pre-send count check in the message builder: if `buttons.length > 13`, automatically switch to carousel mode or paginate.
4. Test specifically with the largest-menu business in the BLYSS database.

**Warning signs:**
- Bot sends no response after the user taps "Book" for a large-menu business
- API error in logs referencing quick reply or button count limit
- Flow works in testing with a small 3-service test business but fails with a real 15-service business

**Phase to address:** Phase 2 — service selection step and message builder

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store conversation state without TTL | Simpler code | Unbounded Firestore growth, old states never cleaned | Never — always set TTL, 1 hour is sufficient |
| Re-use comment system's `igCommenterId` field for DM sender ID | Avoid adding new fields | Conceptually wrong — they are different ID spaces; confuses future devs | Never |
| Skip re-checking slot availability at booking confirmation | One fewer API call | Double bookings on busy mornings — unrecoverable UX damage | Never for the booking confirmation step |
| Fire-and-forget DM sends (no error handling) | Simpler async code | Silent failures — user gets no response, conversation hangs indefinitely | Never — DM sends must be awaited and errors must reset state |
| Store OTP code in quick reply postback payload | Simpler UX implementation | OTP appears in webhook logs and is replayable by anyone with log access | Never |
| Query all businesses' `dm_conversations` without scoping to `businessId` | Simpler queries | Cross-business state leakage, impossible to isolate per tenant | Never |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Instagram Messaging API | Sending DMs with a token that lacks `instagram_business_manage_messages` | Add permission to OAuth scope AND get Advanced Access approved — both must be true |
| Instagram Messaging API | Assuming `entry.changes` contains DM events | DM events are in `entry.messaging` — extend webhook handler to check both shapes |
| Instagram Messaging API | Not filtering `is_echo: true` events | First line of every DM event handler: `if (event.message?.is_echo) return` |
| Instagram Messaging API | Using message ID (`mid`) as sole idempotency key | `mid` is per-message not per-conversation-step; use Firestore transaction to prevent duplicate state writes |
| Instagram Token (60-day expiry) | Token silently expires, DM sends fail with auth error but webhook still receives events | Proactive token refresh via cron — `refreshLongLivedToken()` already exists in `src/utils/instagram.js`; add alert at ≤10 days remaining |
| Eskiz OTP via DM flow | Sending OTP SMS and waiting indefinitely for webhook reply | Store `otp_expires_at` (5 minutes) in conversation state; check expiry before validating; send expiry message if check occurs after deadline |
| Firestore conversation state | Read-modify-write state transitions without transaction | Under concurrent DM events from same user (double-tap), state corrupts — use Firestore transaction for all step transitions |
| Bot bookings endpoint | Using JWT-protected booking endpoint for DM flow (user has no JWT token) | Use `POST /bot/bookings` which uses HMAC-only auth — already exists for exactly this use case |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Fetching all available slots for all 7 days at conversation start | 1–3s first response, expensive reads on businesses with many bookings | Only fetch slots for the selected date, not all 7 days upfront | Any busy business, day 1 |
| N+1 employee reads during "select employee" step | Slow response after time slot selection | Use the existing `/public/businesses/:businessId/slot-employees` endpoint which batches this efficiently | Businesses with 5+ employees |
| No conversation state TTL cleanup | Firestore collection grows unbounded, billable read costs increase | Set TTL on all `dm_conversations` documents (1 hour from last message), use Firestore TTL policy | After ~1 month of operation |
| Awaiting each multi-message DM send sequentially | Total send time = sum of all individual message latencies | Batch independent sends; use sequential only when ordering strictly matters | Every multi-message flow response |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing OTP code in quick reply postback payload | OTP visible in webhook payload logs; replayable by anyone with log access | Store OTP hash in Firestore; validate user's text input against it; never put OTP in button payloads |
| Trusting phone number text sent by user without format validation | User can send any string as a phone number, including another person's number | Validate phone format (Uzbek: +998XXXXXXXXX) before sending OTP; reject malformed input immediately |
| Not verifying webhook signature for DM events | Forged DM events could trigger fake booking creation | The existing HMAC-SHA256 signature check in `verifyWebhookSignature()` already applies to all POST events at the Instagram webhook URL — do not bypass it |
| Storing IGSID in a Firestore path not scoped to a business | Cross-business state leakage; one business's conversation accessible to another | All `dm_conversations` paths must be `businesses/{businessId}/dm_conversations/{igsid}` |
| Logging full DM message text unconditionally | PII exposure in Cloud Logging — messages contain phone numbers, OTP codes | Truncate or redact log output: `message.text.substring(0, 20) + '...'` for DM content; never log OTP digits |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing all 7 days of time slots as quick replies | More than 13 buttons — message fails to send entirely | Show only next 3–5 days as buttons plus a "More dates" option |
| No timeout recovery when user abandons mid-flow | User returns hours later and gets a confusing mid-flow response | On next message after TTL expiry, detect stale state and restart cleanly with a friendly "session expired" message |
| Asking for phone number without context | Confusion or drop-off — users don't want to share their number without knowing why | Send a brief explanation before the phone prompt: "To confirm the booking we'll send a verification code to your number" |
| Sending OTP with no expiry indication | User tries code 10 minutes later, gets "invalid OTP" with no context | Always include "Code valid for 5 minutes" in the OTP message |
| Final confirmation message with no booking details | User unsure what was confirmed, may book again via web | Final message must include: service name, date, time, employee name, and how to cancel (phone or DM) |
| Quick reply buttons disappear after user taps one | Instagram removes quick reply buttons after selection — user cannot go back or review | Always re-offer navigation quick replies ("Main Menu", "Start Over") in the next bot message |

---

## "Looks Done But Isn't" Checklist

- [ ] **DM Permission scope:** `instagram_business_manage_messages` added to OAuth scope in `getOAuthUrl()` AND Meta App Review for Advanced Access submitted — verify both, not just one
- [ ] **Webhook subscriptions:** Both `messages` and `messaging_postbacks` added in Meta webhook dashboard — without `messaging_postbacks`, quick reply button taps are silently ignored
- [ ] **Echo filter:** Every DM handler path has `if (event.message?.is_echo) return` as the first check — without this, the bot replies to its own messages in a loop
- [ ] **Re-auth flow:** Existing connected businesses are prompted to re-authorize after the OAuth scope change — verify the re-auth banner exists and the re-auth flow works end-to-end
- [ ] **24-hour window handling:** Every code path that sends a DM checks `last_user_message_at` and handles expired window gracefully — verify by grepping for all `sendDmMessage` call sites
- [ ] **Slot re-check at confirmation:** The booking confirmation step re-queries available slots at that moment, not the cached value from the "show slots" step — verify by code inspection
- [ ] **DM automation toggle:** `dm_automation_enabled` flag on `instagram_connection` is checked before any state is written, not just before the final booking creation
- [ ] **IGSID scoping:** All Firestore reads/writes for conversation state use `businesses/{businessId}/dm_conversations/{igsid}` — no top-level or unscoped `dm_conversations` paths in the codebase
- [ ] **OTP timeout:** `otp_expires_at` stored when OTP is sent, checked before every verification attempt — not just on the first attempt
- [ ] **Token expiry monitoring:** A cron check or alert fires when the Instagram access token has ≤10 days remaining before the 60-day expiry

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Wrong OAuth scope shipped to production | HIGH | Deploy scope fix; show re-auth banner in business app settings; every business owner must tap "Reconnect Instagram" to grant messaging permission |
| Meta App Review rejected | HIGH | Address rejection reason (usually: missing video demo, incomplete privacy policy, or unclear data handling docs); resubmit; allow 2-week buffer; no DM features can ship until approved |
| Double booking from race condition | MEDIUM | Admin panel must flag same-slot conflicts; implement cron that checks for same-slot bookings and sends Telegram alert to business owner; manual resolution required |
| Conversation state corruption (wrong step) | LOW | Add a "Start Over" quick reply visible at every step; on detecting an invalid state transition, auto-reset to main menu with a friendly message |
| Token expired before proactive refresh | MEDIUM | `refreshLongLivedToken()` already exists in utils; if token is fully expired: business owner must reconnect; add expiry alert at 10-day mark before this happens |
| Echo loop hits rate limit | MEDIUM | Rate limit clears in 1 hour; deploy `is_echo` filter immediately; no lasting damage if caught within minutes; Instagram does not permanently penalize for this |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Missing `instagram_business_manage_messages` permission | Phase 1 (permissions & OAuth scope) | OAuth flow successfully connects and DM API call returns 200 in dev mode |
| Wrong webhook payload shape for DMs vs comments | Phase 1 (webhook routing) | Test DM from Instagram app triggers `handleDmEvent` log output |
| `is_echo` infinite loop | Phase 1 (webhook routing) | Unit test: `is_echo: true` event → zero outbound messages sent |
| IGSID per-business scoping | Phase 1 (data model) | Two test businesses, same test user — verify separate Firestore document paths |
| 24-hour messaging window expiry | Phase 2 (conversation state) | Unit test: `last_user_message_at` > 23h ago → no send attempted, graceful reset |
| Slot race condition | Phase 3 (booking confirmation) | Load test: two concurrent booking confirmations for same slot → exactly one succeeds, one gets `SLOT_TAKEN` |
| Quick reply text truncation | Phase 2 (message construction) | Test with longest Uzbek/Russian service name — no "…" truncation in Instagram app |
| More than 13 quick replies | Phase 2 (service selection) | Test with 15-service business — falls back to carousel automatically, no API error |
| OTP in postback payload security | Phase 2 (OTP flow) | Code review: grep for `postback.payload` — no OTP value appears in button payload |
| Token expiry silent failure | Phase 1 (token management cron) | Cron alert fires when token has ≤10 days remaining |

---

## Sources

- [Instagram Messaging API — Official Meta Docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/) — permission requirements, 24-hour window, text limit (HIGH confidence)
- [Instagram Generic Template Limits — Meta Docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template/) — 10 elements max, 3 buttons per element, 80-char title (HIGH confidence)
- [Instagram Messaging Webhooks — Messenger Platform Docs](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/) — `entry.messaging` payload structure, `is_echo` field (HIGH confidence)
- [Instagram Platform Webhooks — Meta Docs](https://developers.facebook.com/docs/instagram-platform/webhooks/) — available webhook fields, `comments` vs `messages` subscription (HIGH confidence)
- [Instagram App Review — Meta Docs](https://developers.facebook.com/docs/instagram-platform/app-review/) — review process, permission requirements (HIGH confidence)
- [Quick Replies Guide for Facebook & Instagram — GoHighLevel](https://help.gohighlevel.com/support/solutions/articles/155000004035-guide-to-quick-replies-for-facebook-instagram) — 13 button limit, 20-character limit (MEDIUM confidence, consistent with multiple sources)
- [Instagram API Rate Limits: 200 DMs/Hour — CreatorFlow 2026](https://creatorflow.so/blog/instagram-api-rate-limits-explained/) — rate limit details (MEDIUM confidence)
- [Race Conditions in Firestore — QuintoAndar Tech Blog](https://medium.com/quintoandar-tech-blog/race-conditions-in-firestore-how-to-solve-it-5d6ff9e69ba7) — transaction patterns for concurrent booking (MEDIUM confidence)
- [24-Hour Messaging Window — Manychat Help](https://help.manychat.com/hc/en-us/articles/14281199732892-How-to-send-messages-outside-the-24-hour-and-7-day-messaging-windows-in-Messenger-and-Instagram) — window behavior, HUMAN_AGENT extension (MEDIUM confidence)
- [IGSID Scoping — CM.com Instagram Messaging Docs](https://developers.cm.com/messaging/docs/instagram-messaging) — per-business IGSID scoping confirmed (MEDIUM confidence)
- [Chatwoot Instagram App Review Guide](https://developers.chatwoot.com/self-hosted/instagram-app-review) — real-world app review documentation (MEDIUM confidence)
- Codebase analysis: `src/routes/instagram-webhook.js`, `src/utils/instagram.js`, `src/routes/bot.js`, `.planning/PROJECT.md` — existing patterns, known issues, token handling (HIGH confidence)

---
*Pitfalls research for: Instagram DM Booking Automation on existing BLYSS comment reply system*
*Researched: 2026-03-22*
