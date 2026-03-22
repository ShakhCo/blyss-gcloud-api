# Technology Stack: Instagram DM Booking Automation

**Project:** BLYSS Instagram DM Booking Automation (v2.0)
**Researched:** 2026-03-22
**Scope:** Stack additions for static button-based DM booking flow

---

## Critical Finding: No New Dependencies Needed

The existing stack handles everything required for DM automation. Zero new npm packages.

---

## Existing Stack (Reuse As-Is)

| Capability | Package/Service | Version | Used For |
|-----------|----------------|---------|----------|
| HTTP server | Express.js | v5 | Webhook endpoint already exists |
| Database | @google-cloud/firestore | 8.x | Conversation state (same pattern as commenter history) |
| HTTP client | node-fetch / built-in | — | Instagram Graph API calls |
| OTP/SMS | Eskiz API (`src/utils/sms.js`) | — | Phone verification in DM flow |
| HMAC verification | built-in crypto | — | Webhook signature verification |
| Booking creation | `src/routes/bot.js` | — | HMAC-only booking endpoint |
| Encryption | built-in crypto (AES-256-CBC) | — | Access token storage |

---

## Instagram Messaging API (New Endpoints to Call)

### Send Message
```
POST https://graph.instagram.com/v21.0/me/messages
Authorization: Bearer {page_access_token}
Content-Type: application/json
```

### Message Types

**1. Text with Quick Replies (primary interaction method):**
```json
{
  "recipient": { "id": "{igsid}" },
  "message": {
    "text": "Xizmatni tanlang:",
    "quick_replies": [
      { "content_type": "text", "title": "Soch olish", "payload": "SERVICE_abc123" },
      { "content_type": "text", "title": "Soqol olish", "payload": "SERVICE_def456" }
    ]
  }
}
```

**Constraints:**
- Max **13** quick reply buttons per message
- Title max **20** characters
- Payload max **1000** characters

**2. Generic Template / Carousel (fallback for 13+ items):**
```json
{
  "recipient": { "id": "{igsid}" },
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "generic",
        "elements": [{
          "title": "Soch olish",
          "subtitle": "50,000 UZS · 30 min",
          "buttons": [{ "type": "postback", "title": "Tanlash", "payload": "SERVICE_abc123" }]
        }]
      }
    }
  }
}
```

**Constraints:**
- Max **10** elements (carousel cards)
- Max **3** buttons per element
- Title max **80** characters

### Webhook DM Event Structure (Received)

DM events arrive at the **same webhook URL** as comment events (`POST /instagram-webhook/`), but use `entry.messaging[]` instead of `entry.changes[]`:

```json
{
  "object": "instagram",
  "entry": [{
    "id": "ig_page_id",
    "time": 1711108800,
    "messaging": [{
      "sender": { "id": "igsid_customer" },
      "recipient": { "id": "igsid_business" },
      "timestamp": 1711108800,
      "message": {
        "mid": "msg_id_abc",
        "text": "hello",
        "quick_reply": { "payload": "BOOK" },
        "is_echo": false
      }
    }]
  }]
}
```

**Critical:** `is_echo: true` messages are the bot's own outgoing messages echoed back. Must filter these immediately to prevent infinite loops.

### Postback Events (from template buttons)
```json
{
  "sender": { "id": "igsid_customer" },
  "recipient": { "id": "igsid_business" },
  "timestamp": 1711108800,
  "postback": {
    "title": "Tanlash",
    "payload": "SERVICE_abc123"
  }
}
```

---

## OAuth Scope Change Required

**Current scopes:** `instagram_basic`, `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`

**Must add:** `instagram_business_manage_messages`

**Impact:**
1. Update `getOAuthUrl()` in `src/routes/instagram.js` to include new scope
2. All existing connected businesses must re-authorize
3. Meta App Review required for Advanced Access (2-6 week lead time)
4. Must also subscribe webhook to `messages` field (currently only `comments`)

---

## Firestore — New Collection

```
businesses/{businessId}/dm_conversations/{igsid}
{
  step: "language" | "menu" | "services" | "date" | "time" | "employee" | "phone" | "otp" | "confirm",
  language: "uz" | "ru",
  selected_services: [{ id, name, price, duration_minutes }],
  selected_date: "YYYY-MM-DD",
  selected_time: 12345,           // seconds from midnight
  selected_employees: [{ service_id, employee_id, employee_name }],
  phone: "998...",
  otp_attempts: 0,
  updated_at: Timestamp,
  expires_at: Timestamp            // TTL — 24 hours from last interaction
}
```

Key: `{igsid}` (Instagram Scoped ID) — unique per business-user pair.
TTL via `expires_at` field — same pattern as existing `commenters` collection.

---

## Utility Extraction Candidates

Two existing pieces of logic should be extracted for DM handler reuse:

1. **Booking creation** from `src/routes/bot.js` → `src/utils/createBooking.js`
2. **OTP send/verify** from `src/routes/public.js` / `src/utils/sms.js` — already modular

---

## What NOT to Add

| Rejected | Why |
|----------|-----|
| ManyChat / Chatfuel SDK | We're building natively against Instagram Graph API — no third-party bot platform needed |
| AI/LLM for DM responses | Explicitly out of scope — static button-based flow only |
| Redis for conversation state | Firestore with TTL is sufficient at barbershop scale |
| Message queue (Bull, RabbitMQ) | Webhook handler is fast enough inline — no async processing needed |
| Separate DM microservice | Same Express.js app, same webhook URL — just a new code branch |
| WebSocket | Instagram uses push webhooks, not WebSocket connections |
| State machine library (XState) | Simple switch/case on `step` field is sufficient for linear flow |

---

## Summary

| Change | Type | Effort | Confidence |
|--------|------|--------|------------|
| Add `instagram_business_manage_messages` OAuth scope | Config change in `getOAuthUrl()` | Trivial | HIGH |
| Subscribe webhook to `messages` field | API call or Meta dashboard | Trivial | HIGH |
| Handle `entry.messaging[]` in webhook handler | New code branch | Medium | HIGH |
| `sendDmMessage()` utility function | New utility | Low | HIGH |
| `dm_conversations` Firestore collection | New schema + CRUD | Medium | HIGH |
| Reuse booking/OTP logic from bot.js | Extract + call | Low | HIGH |
| Quick reply message builder | New utility | Low | HIGH |
| Generic template fallback for 13+ items | New utility | Low | HIGH |

---

## Sources

- Codebase: `src/routes/instagram-webhook.js`, `src/routes/instagram.js`, `src/routes/bot.js`, `src/routes/public.js`
- [Instagram Messaging API — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
- [Instagram Webhooks — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/webhooks/)
- Architecture, Features, and Pitfalls research from parallel agents (2026-03-22)
