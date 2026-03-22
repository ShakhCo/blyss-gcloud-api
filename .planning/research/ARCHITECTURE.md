# Architecture Research

**Domain:** Instagram DM booking automation — webhook event routing, conversation state, booking flow integration
**Researched:** 2026-03-22
**Confidence:** HIGH (based on direct source code analysis + verified Meta API docs)

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Meta Instagram Platform                        │
│   POST /instagram/webhook  (same URL for comments AND DMs)            │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ X-Hub-Signature-256 verified
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     instagram-webhook.js (router)                     │
│                                                                        │
│   entry.changes[].field === 'comments'  ──► handleCommentEvent()      │
│   entry.messaging[]                     ──► handleDmEvent()  [NEW]    │
└──────────┬───────────────────────────────────────┬───────────────────┘
           │                                       │
           ▼                                       ▼
┌──────────────────┐                  ┌────────────────────────────────┐
│  Comment Handler  │                  │      DM Handler  [NEW]          │
│  (existing, v1.0) │                  │                                │
│                  │                  │  1. Resolve business by         │
│  AI reply to     │                  │     sender.recipient.id         │
│  public comments │                  │  2. Load conversation state     │
└──────────────────┘                  │     from Firestore              │
                                      │  3. Route to flow step          │
                                      │  4. Send DM reply + buttons     │
                                      │  5. Update conversation state   │
                                      └──────────────┬─────────────────┘
                                                     │
                     ┌───────────────────────────────┼────────────────┐
                     ▼                               ▼                ▼
          ┌──────────────────┐           ┌──────────────────┐  ┌──────────────┐
          │   Firestore       │           │  Instagram        │  │  Existing    │
          │  dm_conversations │           │  Graph API v21.0  │  │  booking     │
          │  (new collection) │           │  POST /{ig_id}/   │  │  endpoints   │
          │                  │           │  messages         │  │  /public/*   │
          └──────────────────┘           └──────────────────┘  │  /bot/*      │
                                                                └──────────────┘
```

### Component Responsibilities

| Component | Responsibility | New or Existing |
|-----------|----------------|-----------------|
| `instagram-webhook.js` POST handler | Signature verify, route `messaging` vs `comments` events | Existing — modify (add DM branch) |
| `handleCommentEvent()` | AI reply to public comments | Existing — unchanged |
| `handleDmEvent()` | DM flow orchestration: load state → route step → send reply → save state | New — add to same file |
| `dm_conversations` Firestore collection | Persist conversation state per (igUserId, senderId) | New collection |
| `utils/instagram.js` `sendDmMessage()` | POST to `/{ig_id}/messages` Graph API | New utility function |
| Existing `/public/businesses/:id/services` | Fetch services for DM flow step | Existing — reuse as-is |
| Existing `/public/businesses/:id/available-slots-v2` | Fetch time slots for DM flow step | Existing — reuse as-is |
| Existing `/bot/businesses/:id/bookings` | Create booking (HMAC auth, no JWT) | Existing — reuse as-is |
| Existing `/bot/otp/send` + `/bot/otp/verify` | OTP auth within DM flow | Existing — reuse as-is |

---

## How DM Events Arrive

Instagram sends DM events to the SAME webhook URL as comment events. The disambiguation is at the entry level:

```
Comment event:
  body.entry[].changes[].field === 'comments'

DM event:
  body.entry[].messaging[].message.text (plain text)
  body.entry[].messaging[].message.quick_reply.payload (button tap)
```

**Full DM webhook payload:**

```json
{
  "object": "instagram",
  "entry": [{
    "id": "IGID",
    "time": 1569262486134,
    "messaging": [{
      "sender": { "id": "IGSID" },
      "recipient": { "id": "IGID" },
      "timestamp": 1569262485349,
      "message": {
        "mid": "MESSAGE-ID",
        "text": "MESSAGE-TEXT",
        "quick_reply": {
          "payload": "BUTTON_PAYLOAD_STRING"
        }
      }
    }]
  }]
}
```

**Where comment events have `entry[].changes[]`, DM events have `entry[].messaging[]`.** The existing webhook POST handler already iterates `entry.changes` — it must be extended to also check for `entry.messaging` on the same entry object.

**Required permission for DM events:** `instagram_business_manage_messages` — this is NOT currently in the OAuth scope. The scope must be updated from:
```
instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_insights
```
to:
```
instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_insights,instagram_business_manage_messages
```

**Required webhook subscription field:** `messages` — must be added to the app's webhook configuration in addition to the existing `comments` subscription.

---

## Conversation State: Where It Lives

### Firestore Collection: `dm_conversations`

```
dm_conversations/{convId}
```

The document ID is a composite string: `{businessId}_{senderIgScopedId}`.

This gives O(1) lookup with a single `.doc(id).get()` — no query needed.

```javascript
// dm_conversations/{businessId}_{senderIgScopedId}
{
  business_id: "abc123",
  ig_user_id: "17841401234567",       // business's IG account ID (recipient.id)
  sender_id: "9876543210",            // customer's Instagram-scoped ID (sender.id)
  language: "uz",                     // null until language step completes
  step: "LANGUAGE_SELECT",            // current flow step (see state machine)
  selected_services: [],              // accumulates service IDs during selection
  selected_date: null,                // "2026-03-25"
  selected_time: null,                // seconds from midnight (number)
  selected_employee_id: null,
  otp_id: null,                       // active OTP document ID from bot_otps
  phone_number: null,                 // filled after OTP verify
  user_id: null,                      // filled after OTP verify (users collection ID)
  customer_name: null,
  created_at: Timestamp,
  updated_at: Timestamp,
  expires_at: Timestamp,              // TTL: 30 minutes from last update
}
```

**Why Firestore for state (not in-memory):**
- Cloud Run instances scale to zero and restart between requests
- Multiple Cloud Run instances can handle different webhook deliveries for the same conversation
- Firestore is the only stateful store already in the project
- Conversation documents are small (~500 bytes) and short-lived (30-minute TTL)

**TTL enforcement:** Set `expires_at` to `now + 30 minutes` on every state update. Add a Firestore TTL policy on `dm_conversations.expires_at` (same pattern as `commenters.expires_at` already in `firestore.indexes.json`). No cron job needed.

**State machine steps:**

```
LANGUAGE_SELECT
    ↓
MAIN_MENU
    ↓ (Book button)
SERVICE_SELECT
    ↓
DATE_SELECT
    ↓
TIME_SELECT
    ↓
EMPLOYEE_SELECT
    ↓
AUTH_PHONE_REQUEST       ← skip if user already verified
    ↓
AUTH_OTP_VERIFY          ← skip if user already verified
    ↓
BOOKING_CONFIRM
    ↓
DONE (conversation ends, doc expires)
```

Info paths branch off `MAIN_MENU` and return to `MAIN_MENU` (not a booking path).

---

## DM Handler Structure

### Where it lives: same file (`instagram-webhook.js`)

The comment handler and DM handler are in the same file because:
- They share the business connection lookup pattern (query `instagram_connection` by `ig_user_id`)
- They share the `verifyWebhookSignature` and error-never-throw contract
- Splitting into a second file adds an import without adding clarity

### Integration point in the existing POST handler

```javascript
// In the existing router.post('/', ...) handler:

for (const entry of body.entry) {
  const igUserId = entry.id;

  // EXISTING: comment events
  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change.field === 'comments') {
        tasks.push(handleCommentEvent(igUserId, change.value));
      }
    }
  }

  // NEW: DM events
  if (Array.isArray(entry.messaging)) {
    for (const messagingEvent of entry.messaging) {
      tasks.push(handleDmEvent(igUserId, messagingEvent));  // NEW
    }
  }
}
```

This is a pure addition. `handleCommentEvent` is not touched.

### `handleDmEvent()` internal structure

```javascript
async function handleDmEvent(igUserId, messagingEvent) {
  try {
    const senderId = messagingEvent.sender?.id;
    const recipientId = messagingEvent.recipient?.id;  // same as igUserId
    const messageText = messagingEvent.message?.text || '';
    const quickReplyPayload = messagingEvent.message?.quick_reply?.payload || null;

    // 1. Skip echo events (bot's own messages come back as echoes)
    if (senderId === igUserId) return;

    // 2. Find business connection by ig_user_id
    const connectionSnapshot = await db
      .collectionGroup('instagram_connection')
      .where('ig_user_id', '==', String(igUserId))
      .limit(1)
      .get();
    if (connectionSnapshot.empty) return;

    const connectionDoc = connectionSnapshot.docs[0];
    const connection = connectionDoc.data();
    const businessId = connectionDoc.ref.parent.parent.id;

    // 3. Check DM automation is enabled (dm_automation_enabled flag on connection doc)
    if (!connection.dm_automation_enabled) return;

    // 4. Decrypt access token
    const accessToken = decrypt(connection.access_token);

    // 5. Load or create conversation state
    const convId = `${businessId}_${senderId}`;
    const convRef = db.collection('dm_conversations').doc(convId);
    const convDoc = await convRef.get();

    let conversation = convDoc.exists ? convDoc.data() : null;

    // 6. Route to appropriate step handler
    const input = quickReplyPayload || messageText;
    const result = await routeDmStep(conversation, input, businessId, senderId, accessToken);

    // 7. Save updated state
    await convRef.set(result.newState, { merge: false });

    // 8. Send reply message(s)
    for (const msg of result.messages) {
      await sendDmMessage(igUserId, senderId, msg, accessToken);
    }
  } catch (error) {
    console.error('Instagram DM webhook: error handling DM event:', error);
    // Never throw — webhook must always return 200
  }
}
```

### `routeDmStep()` — flow logic

This is a pure function (or near-pure): takes current state + input, returns `{ newState, messages }`. It does make Firestore reads for business data (services, slots) but has no side effects itself.

```javascript
async function routeDmStep(conversation, input, businessId, senderId, accessToken) {
  const step = conversation?.step || null;

  if (!step || step === 'DONE') {
    return buildLanguageSelectStep(businessId);
  }
  if (step === 'LANGUAGE_SELECT') {
    return handleLanguageSelect(conversation, input, businessId);
  }
  if (step === 'MAIN_MENU') {
    return handleMainMenu(conversation, input, businessId);
  }
  if (step === 'SERVICE_SELECT') {
    return handleServiceSelect(conversation, input, businessId);
  }
  if (step === 'DATE_SELECT') {
    return handleDateSelect(conversation, input, businessId);
  }
  if (step === 'TIME_SELECT') {
    return handleTimeSelect(conversation, input, businessId);
  }
  if (step === 'EMPLOYEE_SELECT') {
    return handleEmployeeSelect(conversation, input, businessId);
  }
  if (step === 'AUTH_PHONE_REQUEST') {
    return handlePhoneRequest(conversation, input, businessId, senderId);
  }
  if (step === 'AUTH_OTP_VERIFY') {
    return handleOtpVerify(conversation, input, businessId, senderId);
  }
  if (step === 'BOOKING_CONFIRM') {
    return handleBookingConfirm(conversation, businessId);
  }

  // Unknown step — reset
  return buildLanguageSelectStep(businessId);
}
```

Each `handle*` function returns `{ newState: {...}, messages: [{text, quick_replies}] }`.

---

## Sending DM Messages with Quick Replies

### New utility function in `utils/instagram.js`

```javascript
export async function sendDmMessage(igId, recipientIgScopedId, message, accessToken) {
  const body = {
    recipient: { id: recipientIgScopedId },
    message: {
      text: message.text,
    },
    access_token: accessToken,
  };

  if (message.quick_replies && message.quick_replies.length > 0) {
    body.message.quick_replies = message.quick_replies.map(qr => ({
      content_type: 'text',
      title: qr.title,          // max 20 characters
      payload: qr.payload,      // string identifier for this button
    }));
  }

  const response = await fetch(
    `https://graph.instagram.com/v21.0/${igId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(`Instagram DM send error: ${data.error.message}`);
  }
  return data;
}
```

**Quick reply constraints (Meta API):**
- Max 13 quick replies per message
- Each title: max 20 characters (truncated if longer)
- Plain text only (no emoji in payload strings, emoji OK in title)
- Quick replies disappear after one is tapped — they are not persistent buttons

---

## Data Flow: DM Received to Booking Created

```
Customer taps "Book" in Instagram DM
    │
    ▼
Meta sends POST /instagram/webhook
  body.entry[0].messaging[0] = {
    sender.id: "IGSID",
    recipient.id: "IGID",
    message.quick_reply.payload: "BOOK"
  }
    │
    ▼
verifyWebhookSignature()  (X-Hub-Signature-256)
    │
    ▼
handleDmEvent(igUserId="IGID", messagingEvent)
    │
    ├─► [READ] instagram_connection collectionGroup by ig_user_id  → businessId, accessToken
    ├─► [READ] dm_conversations/{businessId}_{senderId}            → current conversation state
    │
    ▼
routeDmStep(state, "BOOK", businessId, senderId, accessToken)
    │
    ├─► step === "MAIN_MENU", input === "BOOK"
    │   [READ] businesses/{id}/services (is_active == true)       → service list
    │   Returns: { newState: { step: "SERVICE_SELECT", ... },
    │              messages: [{ text: "Xizmatni tanlang:", quick_replies: [...services] }] }
    │
    ▼
[WRITE] dm_conversations/{convId}  (new state: step="SERVICE_SELECT")
    │
    ▼
sendDmMessage(igUserId, senderId, serviceListMessage, accessToken)
    │
    ▼
[Customer picks service]

... (DATE_SELECT → TIME_SELECT → EMPLOYEE_SELECT flow) ...

    │
    ▼
step === "AUTH_PHONE_REQUEST"
    │   If user already in users/{senderId} with is_verified=true → skip to BOOKING_CONFIRM
    │   Else → send "Telefon raqamingizni kiriting:" message, step="AUTH_OTP_VERIFY" after phone received
    │
    ▼
step === "AUTH_OTP_VERIFY"
    │   Call POST /bot/otp/send (internally, direct function call or HTTP)
    │   Customer enters OTP code
    │   Call POST /bot/otp/verify
    │   On success → update users/{senderId}.is_verified=true, step="BOOKING_CONFIRM"
    │
    ▼
step === "BOOKING_CONFIRM"
    │   [READ] business data for confirmation message
    │   Call POST /bot/businesses/{businessId}/bookings with all collected data
    │   Returns bookingId
    │   Send confirmation DM: "Bron tasdiqlandi! ✅\n{date} {time}\n{service}"
    │   [WRITE] dm_conversations/{convId} = { step: "DONE", expires_at: now+5min }
    │
    ▼
Booking exists in Firestore bookings/{bookingId}
```

---

## Recommended Project Structure

```
src/
├── routes/
│   ├── instagram-webhook.js    # MODIFIED: add DM branch + handleDmEvent() + routeDmStep()
│   │                            # + per-step handlers (handleLanguageSelect, etc.)
│   └── instagram.js            # UNCHANGED
├── utils/
│   └── instagram.js            # MODIFIED: add sendDmMessage()
└── (no new files required for DM flow — keep complexity in instagram-webhook.js)
```

**Rationale for no new files:**
- The DM handler is the same pattern as the comment handler — same file, same error contract
- Per-step handlers are small functions (20-40 lines each) that don't justify their own modules
- Splitting would require cross-file imports for shared utilities (accessToken, businessId) adding ceremony without benefit
- All 127 existing tests are in `instagram-webhook.test.js` — new tests go in the same file

**If the DM handler grows beyond ~400 lines total:** Extract step handlers into `src/utils/dmBookingFlow.js`. The `handleDmEvent()` in the route file becomes the orchestrator that imports from there. This is a clean refactor that does not require API changes.

---

## New vs. Modified Components

| Component | Status | Change |
|-----------|--------|--------|
| `src/routes/instagram-webhook.js` POST handler | **Modified** | Add `entry.messaging` loop alongside existing `entry.changes` loop |
| `handleCommentEvent()` | **Unchanged** | Zero changes |
| `handleDmEvent()` | **New** | DM orchestration function in same file |
| `routeDmStep()` | **New** | Step routing logic |
| `handle*()` step functions | **New** | One function per flow step (8-10 functions) |
| `src/utils/instagram.js` | **Modified** | Add `sendDmMessage()` export |
| `firestore.indexes.json` | **Modified** | Add TTL policy for `dm_conversations.expires_at` |
| `src/routes/instagram.js` | **Modified** | Add `dm_automation_enabled` field to settings PATCH + GET |
| OAuth scope in `utils/instagram.js` `getOAuthUrl()` | **Modified** | Add `instagram_business_manage_messages` permission |
| `bot.js` OTP endpoints | **Unchanged** | Reused internally by DM handler |
| `public.js` booking endpoints | **Unchanged** | Reused internally by DM handler (direct Firestore queries, same pattern) |
| `dm_conversations` Firestore collection | **New** | State persistence for active DM flows |

---

## Integration Points

### Business Connection Resolution

Both comment and DM handlers use the same `instagram_connection` collection group query:

```javascript
db.collectionGroup('instagram_connection')
  .where('ig_user_id', '==', String(igUserId))
  .limit(1)
  .get()
```

The DM handler adds one new check on the resulting document: `connection.dm_automation_enabled`. This is a boolean stored on the existing connection document — no new collection needed.

### Booking Creation

The DM handler creates bookings by calling the same logic as `POST /bot/businesses/:businessId/bookings`. There are two options:

**Option A (recommended): Direct Firestore writes** — duplicate the booking creation logic from `bot.js` into the DM handler, or extract it into `src/utils/createBooking.js` shared by both. This avoids an internal HTTP call.

**Option B: Internal HTTP call** — POST to `http://localhost:3000/bot/businesses/{id}/bookings` with the HMAC signature. This keeps the logic in one place but requires the server to call itself (fragile in Cloud Run).

**Recommendation: Option A with extraction.** Create `src/utils/createBooking.js` that exports `createBookingForUser()`. Both `bot.js` and the DM handler import from it. This removes duplication and is the correct architectural move regardless.

### OTP Authentication

The DM handler reuses the OTP logic from `bot.js`. Same two options apply. In this case, the OTP send/verify functions are simpler and can be called directly from Firestore rather than duplicated:

```javascript
// DM handler calls same Firestore collections bot.js uses:
// db.collection('bot_otps') — write OTP doc
// db.collection('users') — read/write user doc
```

Extract `sendOtp(telegramId, phoneNumber)` and `verifyOtp(telegramId, otpId, otpCode)` into `src/utils/otpAuth.js`. Both `bot.js` and the DM handler import from it.

**Note:** The `bot_otps` collection uses `telegram_id` as the user key. For DM users, there is no Telegram ID — use Instagram sender ID instead. The OTP collection must accept either. The simplest approach: store IG sender ID as a string in the `telegram_id` field (it is already stored as Number, so use a separate field `ig_sender_id` for DM-originated OTPs).

### Available Slots and Services

The DM handler queries Firestore directly for services and available slots, using the same collection paths as the public endpoints. No HTTP calls needed:

```javascript
// Services
db.collection('businesses').doc(businessId).collection('services')
  .where('is_active', '==', true).get()

// Available slots: reuse the slot calculation logic from public.js
// Extract into src/utils/availableSlots.js
```

---

## Architectural Patterns

### Pattern 1: Event Field Dispatch

**What:** The single webhook POST handler inspects the event structure to determine which handler to invoke. `entry.changes` → comment handler; `entry.messaging` → DM handler.

**When to use:** When a single endpoint receives structurally different events. Common in Meta webhook integrations.

**Trade-offs:** Keeps one entry point (simpler routing), requires careful null checks on optional fields, grows the router file if many event types are added.

```javascript
// Both event types run in parallel via Promise.all — same as current comment handling
const tasks = [];
for (const entry of body.entry) {
  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change.field === 'comments') tasks.push(handleCommentEvent(entry.id, change.value));
    }
  }
  if (Array.isArray(entry.messaging)) {
    for (const msg of entry.messaging) {
      tasks.push(handleDmEvent(entry.id, msg));
    }
  }
}
await Promise.all(tasks);
```

### Pattern 2: Document-Keyed State with TTL

**What:** Conversation state is stored in a Firestore document keyed by `{businessId}_{senderId}`. The document expires via TTL — no cleanup cron needed.

**When to use:** Short-lived state that should auto-expire. Stateless compute (Cloud Run) that can't hold in-memory state across requests.

**Trade-offs:** Slightly higher Firestore read/write cost per DM received. But: zero operational overhead, no memory leak risk, correct across multiple Cloud Run instances.

### Pattern 3: Step Function Returns (not mutations)

**What:** Each `handle*Step()` function returns `{ newState, messages }` rather than writing to Firestore directly. The orchestrator writes state and sends messages.

**When to use:** When steps need to be unit-tested independently. When write ordering matters (save state before sending message — or after).

**Trade-offs:** Slightly more verbose call sites. Enables testing each step without mocking Firestore writes.

---

## Data Flow

### Request Flow

```
Instagram DM sent by customer
    ↓
Meta webhook POST /instagram/webhook
    ↓
verifyWebhookSignature()
    ↓
entry.messaging[] detected → handleDmEvent(igUserId, messagingEvent)
    ↓
[READ] instagram_connection (by ig_user_id) → businessId, accessToken, dm_enabled
    ↓
[READ] dm_conversations/{businessId}_{senderId} → current step + accumulated data
    ↓
routeDmStep(state, input) → { newState, messages }
    ↓
[WRITE] dm_conversations/{convId} = newState
    ↓
sendDmMessage() for each message in result.messages
    ↓
res.status(200).send('EVENT_RECEIVED')
```

### State Management

```
dm_conversations/{convId}
    ↓ (read on each DM)
routeDmStep() ←→ handle*Step() → { newState, messages }
    ↓ (write after step)
dm_conversations/{convId}  (updated TTL: +30 minutes)
```

### Key Data Flows

1. **Business resolution:** Both comment and DM handlers do the same `collectionGroup` query. This is the only "expensive" read — 1 Firestore query per DM event.

2. **Step accumulation:** `selected_services`, `selected_date`, `selected_time`, `selected_employee_id` accumulate on the conversation document across multiple DM exchanges until `BOOKING_CONFIRM`.

3. **Booking handoff:** At `BOOKING_CONFIRM`, all accumulated state is read from the conversation doc and passed to the booking creation utility. The conversation doc then transitions to `step: "DONE"` with a short TTL.

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-50 active conversations/day | Current design is fine — Firestore reads per DM are 2-3 |
| 50-500 active conversations/day | Add Firestore index on `dm_conversations.business_id` if business-level analytics needed |
| 500+ active conversations/day | Consider Redis for state (not Firestore) to reduce cost; current design handles this volume fine at ~$0.06/1M reads |

### Scaling Priorities

1. **First bottleneck:** Instagram API rate limit on sending DMs — 200 automated DMs per hour per account. At scale, queue DM sends rather than sending synchronously in the webhook handler.

2. **Second bottleneck:** `collectionGroup` query cost. At very high volume, cache the `businessId → accessToken` mapping in a short-lived in-memory cache (if Cloud Run min-instances > 0).

---

## Anti-Patterns

### Anti-Pattern 1: Handling DMs in a Separate Webhook Route

**What people do:** Register a second webhook URL `/instagram/dm-webhook` for DM events, separate from the comment webhook.

**Why it's wrong:** Meta sends ALL Instagram webhook events to ONE configured URL. You cannot split them by event type at the platform level. Attempting this requires a separate app registration.

**Do this instead:** Handle both event types in the same POST handler by inspecting `entry.changes` vs `entry.messaging`.

### Anti-Pattern 2: Storing Conversation State In-Memory

**What people do:** Use a `Map<senderId, conversationState>` in the Node.js process.

**Why it's wrong:** Cloud Run scales to zero between requests and may run multiple instances. In-memory state is lost on cold start and not shared across instances.

**Do this instead:** Firestore `dm_conversations` collection with TTL. 30-minute expiry is sufficient for a booking flow.

### Anti-Pattern 3: Blocking the Webhook Response on DM Sends

**What people do:** `await sendDmMessage()` inside the webhook handler, causing the webhook response to be delayed by the IG API round-trip.

**Why it's wrong:** Meta expects webhook responses within 20 seconds. IG API calls typically take 200-500ms each. A multi-message flow can hit this limit.

**Do this instead:** Respond 200 immediately, then process the DM event. Use Cloud Run's `waitUntil` pattern or ensure processing completes before returning (the current comment handler already does this — same approach works for DMs since the typical DM flow is 1-2 API calls).

### Anti-Pattern 4: Duplicating Booking Logic

**What people do:** Copy the full booking creation logic from `bot.js` into the DM handler.

**Why it's wrong:** Two places to fix bugs, two places to update validation rules.

**Do this instead:** Extract `createBooking()` into `src/utils/createBooking.js`. Both `bot.js` and the DM handler import from it.

### Anti-Pattern 5: Using `message.text` Matching for Button Taps

**What people do:** Check `message.text === "Book"` to detect button taps.

**Why it's wrong:** Users can also type "Book" as free text. The distinguishing signal is `message.quick_reply.payload`, not `message.text`.

**Do this instead:** Check `quick_reply.payload` first. Fall through to text matching only for free-text input handling.

---

## Build Order (Considering Dependencies)

### Phase 1: Infrastructure (blocks everything)

1. **Add `messages` webhook subscription** — enable DM events in Meta app configuration. No code change required but blocks DM events from arriving.
2. **Update OAuth scope** — add `instagram_business_manage_messages` to `getOAuthUrl()` in `utils/instagram.js`. Businesses must re-auth after this change.
3. **Add `dm_automation_enabled` field** — add to `instagram_connection` document schema and expose on `PATCH /instagram/settings` and `GET /instagram/status`. This is the per-business feature toggle.
4. **Add `dm_conversations` TTL policy** — add to `firestore.indexes.json`. Deploy before any DM state is written.

### Phase 2: Event Routing (non-breaking addition)

5. **Add `entry.messaging` branch** to the existing POST handler. At this point, DM events arrive but `handleDmEvent` just logs and returns. Zero behavior change to comments.
6. **Add `sendDmMessage()` to `utils/instagram.js`** — needed by all step handlers.

### Phase 3: Flow Steps (implement in order, test each before next)

7. **`handleLanguageSelect` + send initial language prompt** — first user-visible behavior. Can ship and test independently.
8. **`handleMainMenu`** — depends on Step 7 (must be in MAIN_MENU step to test).
9. **`handleServiceSelect`** — depends on Step 8. Requires Firestore services read.
10. **`handleDateSelect`** — depends on Step 9.
11. **`handleTimeSelect`** — depends on Step 10. Requires available-slots logic.
12. **`handleEmployeeSelect`** — depends on Step 11. Requires slot-employees logic.
13. **`handlePhoneRequest` + `handleOtpVerify`** — depends on Steps 12. Requires OTP utility extraction.
14. **`handleBookingConfirm`** — depends on Steps 3-13. Requires booking creation utility extraction.

### Dependency Graph

```
Phase 1 (1-4): infrastructure — must complete before Phase 2
Phase 2 (5-6): routing — must complete before Phase 3

Phase 3:
  7 (language) → 8 (menu) → 9 (service) → 10 (date)
                                                ↓
                                           11 (time) → 12 (employee)
                                                              ↓
                                                    13 (phone+OTP) → 14 (confirm)
```

Steps within Phase 3 must be built sequentially because each step is tested by completing the previous step in a real DM flow.

---

## Integration Points Summary

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Meta Instagram Graph API (webhook) | Incoming POST, no auth (Meta-signed) | Existing — add `messaging` field handling |
| Meta Instagram Graph API (send DM) | POST `/{ig_id}/messages` with access token | New — `sendDmMessage()` utility |
| Firestore `instagram_connection` | Collection group query by `ig_user_id` | Existing — add `dm_automation_enabled` flag |
| Firestore `dm_conversations` | Document read/write by composite key | New collection |
| Firestore `businesses/{id}/services` | Collection read for service list | Existing — no change |
| Firestore `bookings` | Document write for booking creation | Existing — via shared utility |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `instagram-webhook.js` ↔ `utils/instagram.js` | Import — `sendDmMessage()` | New export on existing module |
| `instagram-webhook.js` ↔ booking logic | Shared utility import | Extract from `bot.js` into `utils/createBooking.js` |
| `instagram-webhook.js` ↔ OTP logic | Shared utility import | Extract from `bot.js` into `utils/otpAuth.js` |
| Comment handler ↔ DM handler | None (independent) | Both live in same file, no shared mutable state |

---

## Sources

- Source code: `src/routes/instagram-webhook.js` — verified webhook dispatch structure and comment handler pattern
- Source code: `src/routes/bot.js` — verified OTP and booking creation logic to reuse
- Source code: `src/utils/instagram.js` — verified existing OAuth scope and Graph API base URL
- Source code: `src/routes/index.js` — verified `/instagram/webhook` is public (no HMAC), correct for Meta webhook events
- Source code: `firestore.indexes.json` — verified TTL pattern on `commenters.expires_at` to replicate for `dm_conversations`
- Meta developer docs: `developers.facebook.com/docs/messenger-platform/instagram/features/webhook/` — DM webhook payload structure (HIGH confidence, fetched directly)
- Meta developer docs: `developers.facebook.com/docs/instagram-platform/webhooks/` — `messages` subscription field, permission requirements (HIGH confidence, fetched directly)
- Meta quick reply constraints: max 13 replies, 20-char title limit, plain text only (HIGH confidence, multiple sources agree)
- Instagram API rate limit: 200 automated DMs per hour (MEDIUM confidence — referenced in multiple secondary sources, not verified in primary docs during this session)

---

*Architecture research for: Instagram DM booking automation — integration with existing BLYSS webhook infrastructure*
*Researched: 2026-03-22*
