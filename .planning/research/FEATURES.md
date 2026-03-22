# Feature Research: Instagram DM Booking Automation

**Domain:** Button-based Instagram DM booking flow for barbershop/salon businesses
**Researched:** 2026-03-22
**Confidence:** HIGH (direct codebase analysis + Instagram Graph API official docs + ecosystem research)

---

## Context: What This Milestone Adds

v1.0 shipped a comment auto-reply system. v2.0 adds a fully self-contained booking flow inside Instagram DMs — no web redirect, no app download, no phone call. A customer messages the barbershop, navigates quick-reply buttons, and ends with a confirmed appointment, all within the Instagram conversation thread.

**Critical API constraint discovered in research:** The existing OAuth scope
(`instagram_business_manage_comments`) does NOT include messaging. Sending DMs requires the
`instagram_business_manage_messages` scope. This scope must be added to the OAuth flow before
any DM feature works. This is the single highest-risk dependency for the entire milestone.

**Existing infrastructure that DM booking reuses directly:**
- `GET /public/businesses/:slug/services` — services with employee assignments
- `GET /public/businesses/:businessId/available-slots-v2` — 15-min slot availability
- `GET /public/businesses/:businessId/slot-employees` — employee availability per slot
- `POST /public/businesses/:businessId/bookings-v2` — create booking (needs JWT)
- `POST /bot/bookings` — create booking (HMAC only — no JWT needed, better fit for bot)
- OTP send/verify already in `/public/send-otp` and `/public/verify-otp`
- Existing Firestore connection structure at `businesses/{id}/instagram_connection/connection`

---

## Table Stakes

Features users (customers) expect from any booking bot on any messaging platform. Missing these
makes the flow feel broken or untrustworthy. The bar is set by WhatsApp Business bots and
Telegram bots — Instagram DM bots are compared to those.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Any message triggers the flow** | Users don't know what keyword to use; the bot must work regardless of what they type | LOW | Match on any incoming DM event, not on specific keywords |
| **Language selection on first interaction** | Barbershop customers in Uzbekistan expect uz/ru choice before anything else | LOW | Two quick-reply buttons: "O'zbek" / "Русский"; store choice on conversation state |
| **Main menu with named buttons** | Standard chatbot UX since Facebook Messenger 2016; users refuse to type commands | LOW | 4 buttons: Book, Location, Working Hours, Contact |
| **Service list as selectable buttons** | Users will not type service names; they need to tap | MEDIUM | Quick replies (max 13) cover most barbershop menus; overflow needs pagination strategy |
| **Date selection for next 7 days** | Time horizon that feels relevant without overwhelming; Telegram booking bots all use 7 days | MEDIUM | Show day names (Today, Tomorrow, Monday...) not date strings |
| **Time slot display** | Users need to see available windows, not enter a time manually | MEDIUM | Calls existing `/available-slots-v2`; must format 15-min slots into readable groups |
| **Employee selection** | Barbershop customers often have a preferred barber; skipping this loses a key trust signal | MEDIUM | Calls existing `/slot-employees`; "Any barber" fallback if user doesn't care |
| **Phone number collection** | Required for booking creation and OTP; users expect to be asked once | LOW | Prompt as plain text request; validate format before sending OTP |
| **OTP verification within DM** | Standard auth for Uzbek market (Eskiz SMS); users expect this pattern | MEDIUM | OTP is 6 digits sent via SMS; user types it back into the DM; reuse existing OTP infra |
| **Booking confirmation message** | Users need a clear "you're booked" summary or they'll assume it failed | LOW | Text message: service, date, time, employee, reference number |
| **Info responses: Location** | First question most new customers ask; must be instant | LOW | Pull from `businessData.location`; format as text + Google Maps link |
| **Info responses: Working Hours** | Second most common question | LOW | Pull from `businessData.working_hours`; format by day |
| **Info responses: Contact** | Users want a phone number to call if something goes wrong | LOW | Pull from `businessData.business_phone_number` |
| **"Go back to main menu" option** | Users make wrong selections; no back button = abandoned conversation | LOW | Include a "Back" / "Main menu" quick reply at every step |
| **Graceful timeout / session reset** | Idle conversations must not block the flow for hours; industry standard is 30 min | MEDIUM | Firestore TTL or timestamp comparison on each incoming event |
| **Per-business toggle** | Not all businesses want DM automation; must be opt-in | LOW | `dm_automation_enabled` boolean on `instagram_connection` document |

---

## Differentiators

Features that go beyond what a basic booking bot provides. These are not required to ship, but
they convert casual interactions into confirmed bookings at a higher rate.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Multiple service selection** | Customers often want a haircut + beard trim; forcing one service loses the upsell | MEDIUM | Multi-select state in conversation; accumulate selected services before date step |
| **"Any available barber" option** | Reduces abandonment when the preferred barber is unavailable | LOW | If user selects "Any", use any employee with availability; already supported by `/bookings-v2` |
| **Booking summary before confirm** | Show a summary card (services, date, time, barber, price) and ask for confirmation before creating the booking | LOW | One extra step; dramatically reduces "I made a mistake" cancellations |
| **Return user recognition** | Users who have booked before should not re-authenticate from scratch | MEDIUM | Store ig_user_id → phone_number mapping in Firestore after first successful auth; skip OTP on subsequent bookings |
| **Graceful out-of-slots handling** | If no slots exist for the chosen date, say so and offer the next available date rather than showing an empty list | MEDIUM | Requires checking multiple days in sequence; much better UX than empty state |
| **Booking cancellation via DM** | Users who need to cancel currently have no self-service option from Instagram | HIGH | Requires conversation state for looking up existing bookings by user; complex to implement safely |
| **Language persistence across sessions** | If a user previously chose Russian, they should not be asked again | LOW | Store language preference on the ig_user conversation document in Firestore |
| **Admin Telegram notification on booking** | Existing pattern from landing page bookings; business owner gets notified instantly | LOW | Reuse existing `sendTelegramMessage` utility; minimal new code |

---

## Anti-Features

Features that seem reasonable but create real problems in this context. Explicitly out of scope.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **AI-generated responses in the DM flow** | "Feels more natural" | Introduces hallucination risk on appointment data (wrong times, wrong services); AI latency conflicts with webhook 24h window; exponentially harder to test | Static button flow with fixed templates; AI is already serving the comment reply use case |
| **Sending booking reminders via DM** | "Reduce no-shows" | Instagram's 24-hour messaging window makes this technically illegal unless the customer messages first; violating this risks account restriction | If reminders are needed, use SMS (Eskiz already integrated) |
| **Accepting free-text at each booking step** | "More flexible UX" | Dramatically increases parsing complexity; "next tuesday" in Uzbek/Russian requires NLP; failure modes visible to customer | Quick-reply buttons only at structured steps; free text only for phone number entry |
| **Payment collection via DM** | "Complete transaction in chat" | Instagram DMs have no payment API; any payment link opens a browser (defeats the DM-native goal); PCI scope explodes | Collect payment at the barbershop; booking is the confirmation |
| **Showing full employee profiles with photos** | "Help customer choose barber" | Instagram DM API does not support card/template messages with images for non-Meta business products; workaround is complex | Show employee name + position text only |
| **Syncing booking to Google Calendar** | "Nice to have" | Out of scope for this milestone; adds OAuth complexity for a third system | Already deferred in PROJECT.md |
| **Letting users reschedule via DM** | "Convenient" | Requires identifying and modifying an existing booking record via a conversational interface; high error risk | Build reschedule after cancellation flow works reliably |

---

## Feature Dependencies

```
[OAuth scope: instagram_business_manage_messages]
    └──required by──> [All DM send/receive features]

[Conversation state in Firestore]
    └──required by──> [Language selection persistence]
    └──required by──> [Booking flow step tracking]
    └──required by──> [Timeout/reset logic]
    └──required by──> [Return user recognition]

[Language selection]
    └──required by──> [All user-facing messages]
    └──required by──> [Service list display]
    └──required by──> [Date display (day names in uz/ru)]

[Service selection step]
    └──required by──> [Multiple service selection]
    └──required by──> [Date step — duration affects slot availability]

[Date selection]
    └──required by──> [Time slot display]

[Time slot selection]
    └──required by──> [Employee selection]

[Employee selection]
    └──required by──> [Booking summary]

[Phone + OTP auth]
    └──required by──> [Booking creation via /bot/bookings]

[Booking creation]
    └──required by──> [Confirmation message]
    └──required by──> [Admin Telegram notification]

[Return user recognition]
    └──enhances──> [Phone + OTP auth (skips it for known users)]

[Per-business toggle]
    └──gate on──> [All DM automation features]
```

### Dependency Notes

- **OAuth scope before everything:** The `instagram_business_manage_messages` scope is a hard prerequisite. Without it, no DM can be sent or received programmatically. This requires an API scope change AND users to re-authorize via OAuth.
- **Conversation state before flow steps:** Every booking step depends on knowing where in the flow the user is. Firestore is the right store (Cloud Run is stateless; in-memory state is lost between webhook invocations).
- **`/bot/bookings` instead of `/public/businesses/:id/bookings-v2`:** The bot endpoint takes HMAC-only auth, which fits the webhook context where no JWT is available. The public endpoint requires JWT (which the OTP flow creates), making it usable if OTP is completed first.
- **Multiple service selection requires careful date-step design:** When multiple services are selected, total duration must be calculated and passed to `/available-slots-v2` so slots that cannot accommodate the combined duration are excluded.

---

## MVP Definition

### Launch With (v2.0 — what the PROJECT.md Active list describes)

These are the features defined as Active in the milestone. Nothing more, nothing less.

- [ ] **OAuth scope upgrade** — Add `instagram_business_manage_messages` to the authorization request; existing connected businesses need re-authorization
- [ ] **DM webhook handling** — Subscribe to `messages` webhook field; route incoming DM events to the DM handler (separate from comment handler)
- [ ] **Conversation state management** — Firestore document per `(businessId, igUserId)` storing: language, current_step, selected_services, selected_date, selected_slot, selected_employee, phone, session_started_at; 30-minute timeout resets state
- [ ] **Language selection** — First DM interaction shows two quick-reply buttons; user choice stored on state; all subsequent messages in chosen language
- [ ] **Main menu** — After language selection (and after any "back to menu"): Book, Location, Working Hours, Contact quick-reply buttons
- [ ] **Service selection** — Fetch active services via existing API; display as quick-reply buttons (up to 13); user taps to select; "Done" button to confirm and proceed
- [ ] **Multiple service selection** — Allow selecting more than one service before proceeding to date
- [ ] **Date selection** — Show next 7 days as quick-reply buttons with day names (Today, Ertaga / Завтра, and day names in uz/ru)
- [ ] **Time slot selection** — Call `/available-slots-v2` with selected services' total duration; display available slots as quick-reply buttons grouped by hour
- [ ] **Employee selection** — Call `/slot-employees` for selected slot; display employees + "Any barber" option
- [ ] **Phone collection** — Prompt user to type their phone number; validate format
- [ ] **OTP send and verify** — Call existing OTP send; prompt user to type 6-digit code; verify; create/fetch user JWT
- [ ] **Booking creation** — Call `/bot/bookings` or `/public/businesses/:id/bookings-v2` with all selected data; send confirmation message
- [ ] **Location info response** — Format and send business location when user taps Location
- [ ] **Working hours info response** — Format and send business hours when user taps Working Hours
- [ ] **Contact info response** — Send business phone number when user taps Contact
- [ ] **Per-business toggle** — `dm_automation_enabled` field on `instagram_connection`; only handle DMs for businesses with this enabled

### Add After Validation (v2.x)

- [ ] **Return user recognition** — Trigger: users complain about re-entering phone on every booking. Store ig_user_id → phone_number after first OTP success; skip OTP for subsequent bookings.
- [ ] **Language persistence across sessions** — Trigger: multilingual users report always seeing the language prompt. Store preference; skip on return.
- [ ] **Out-of-slots graceful handling** — Trigger: user testing reveals dead-end UX when no slots available. Auto-suggest next available date.
- [ ] **Admin Telegram notification on booking** — Trigger: business owners request. Reuse existing Telegram notify utility.

### Future Consideration (v3+)

- [ ] **Booking cancellation via DM** — High value but complex; requires conversation lookup of existing bookings, confirmation step, and cancellation logic. Defer until core flow is proven reliable.
- [ ] **Reschedule via DM** — Builds on cancellation; even more complex. Defer.
- [ ] **Booking reminder via SMS** — Use Eskiz (already integrated) not DM; separate feature from this milestone.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| OAuth scope upgrade | HIGH | LOW | P1 — blocker for everything |
| DM webhook routing | HIGH | LOW | P1 — required infrastructure |
| Conversation state (Firestore) | HIGH | MEDIUM | P1 — all flow steps depend on it |
| Language selection | HIGH | LOW | P1 — first UX touchpoint |
| Main menu buttons | HIGH | LOW | P1 — entry to all flows |
| Service selection | HIGH | MEDIUM | P1 — core booking step |
| Date selection | HIGH | MEDIUM | P1 — core booking step |
| Time slot selection | HIGH | MEDIUM | P1 — core booking step |
| Employee selection | MEDIUM | MEDIUM | P1 — important for salon UX |
| Phone + OTP auth | HIGH | MEDIUM | P1 — required for booking creation |
| Booking confirmation message | HIGH | LOW | P1 — required for user confidence |
| Location / Hours / Contact info | MEDIUM | LOW | P1 — main menu promises these |
| Per-business toggle | MEDIUM | LOW | P1 — required for safe rollout |
| Multiple service selection | MEDIUM | MEDIUM | P2 — upsell value; adds flow complexity |
| Booking summary before confirm | MEDIUM | LOW | P2 — reduces errors |
| Return user recognition | HIGH | MEDIUM | P2 — major UX improvement for returning users |
| Language persistence | MEDIUM | LOW | P2 — reduces friction on return |
| Out-of-slots graceful handling | MEDIUM | MEDIUM | P2 — eliminates dead-end UX |
| Admin notification on booking | MEDIUM | LOW | P2 — business owner expectation |
| Booking cancellation via DM | HIGH | HIGH | P3 — future milestone |

---

## Competitor Feature Analysis

The comparable products are WhatsApp Business bots (e.g., via Twilio), Telegram booking bots,
and Instagram automation platforms like ManyChat used for appointment booking.

| Feature | ManyChat / WhatsApp Bots | Telegram Bots (e.g., existing BLYSS Telegram) | Our DM Flow |
|---------|--------------------------|----------------------------------------------|-------------|
| Language selection | Usually keyword-triggered or auto-detected | Explicit /start flow with language buttons | Explicit buttons on first message (same as Telegram) |
| Service selection | Quick replies or list messages | Inline keyboard buttons | Quick reply buttons (Instagram's equivalent) |
| Date selection | Date picker widgets or quick replies | Custom inline keyboard | Quick reply buttons (7-day window) |
| Time slots | Formatted text or quick replies | Grid-style inline keyboard | Quick reply buttons grouped by hour |
| Auth in conversation | Collect email/phone as text, no OTP | Phone share button or typed phone + OTP | Typed phone + OTP via SMS (Eskiz — same as web flow) |
| Confirmation | Summary message | Summary message with confirm/cancel buttons | Summary text + confirm button |
| State management | Platform-managed (ManyChat handles it) | Per-user session in database | Firestore document per (businessId, igUserId) |
| Timeout | Platform-managed | Explicit TTL | Firestore timestamp comparison on each event |

**Key observation:** The phone-number-in-DM-then-SMS-OTP pattern is unusual compared to most booking bots (which typically avoid OTP and rely on email or no verification). It is, however, what BLYSS uses across Telegram and web — maintaining this consistency is the right call for the Uzbek market where phone is the identity anchor.

---

## Sources

- Direct codebase analysis: `src/routes/instagram-webhook.js`, `src/utils/instagram.js`, `src/routes/public.js`, `src/routes/bot.js`
- `.planning/PROJECT.md` — milestone scope, active features list, existing infrastructure inventory
- [Instagram Messaging API — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/) — required permissions, message types, 24-hour window constraint (HIGH confidence)
- [Instagram DM API Guide — bot.space](https://www.bot.space/blog/the-instagram-dm-api-your-ultimate-guide-to-automation-sales-and-customer-loyalty-svpt5) — quick reply limits (13 max), text limit (1000 bytes), message types (MEDIUM confidence — third party)
- [Instagram DM Automation Best Practices 2025 — instantdm.com](https://instantdm.com/blog/instagram-dm-automation-rules-best-practices-2025) — compliant automation patterns, what's banned (MEDIUM confidence)
- [Instagram API Rate Limits — creatorflow.so](https://creatorflow.so/blog/instagram-api-rate-limits-explained/) — 200 DMs/hour rate limit, 24-hour window details (MEDIUM confidence)
- [ManyChat Instagram Booking Flow — fletchapp.com](https://fletchapp.com/instagram-dm-automation-with-manychat-how-it-works/) — industry booking flow pattern reference (MEDIUM confidence)
- [Instagram DM Automation 2025 — inro.social](https://www.inro.social/blog/instagram-dm-automation-2025) — market patterns, use case validation (MEDIUM confidence)

---

*Feature research for: Instagram DM Booking Automation (BLYSS v2.0)*
*Researched: 2026-03-22*
