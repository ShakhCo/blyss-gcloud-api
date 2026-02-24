# External Integrations

**Analysis Date:** 2026-02-24

## APIs & External Services

**SMS Delivery:**
- Eskiz.uz - SMS OTP delivery and transactional messages
  - SDK/Client: HTTP fetch API (no dedicated SDK)
  - Auth: Bearer token in `Authorization` header
  - Env var: `ESKIZ_TOKEN`
  - Endpoint: `https://notify.eskiz.uz/api/message/sms/send`
  - Used by: `src/utils/eskiz.js`
  - Functions: `sendSms()`, `sendOtpSms()`, `sendBusinessInvitationSms()`
  - Sender ID: '4546'

**AI & Language Models:**
- OpenAI - Text translation and validation
  - SDK/Client: `openai` npm package v6.17.0
  - Auth: API key in `OPENAI_API_KEY` env var
  - Model: `gpt-4o-2024-08-06`
  - Used by: `src/routes/ai.js`
  - Features:
    - POST `/ai/translate` - Translate text to Uzbek or Russian
    - POST `/ai/validate` - Validate content appropriateness
    - Uses structured output parsing with Zod schemas

**Location & Distance:**
- OpenRouteService - Distance calculations and routing
  - SDK/Client: HTTP fetch API (no dedicated SDK)
  - Auth: API key in `Authorization` header
  - Env var: `OPENROUTESERVICE_API_KEY`
  - Base URL: `https://api.openrouteservice.org/v2/directions/driving`
  - Used by: `src/routes/distance.js`, `src/routes/public.js`, `src/routes/telegram.js`
  - Caching: In-memory LRU cache (1000 entries, 4 decimal place coordinate precision)
  - Returns: Distance in km and duration in seconds

**Messaging Platforms:**
- Telegram Bot API - OTP delivery and customer notifications
  - SDK/Client: HTTP fetch API (no dedicated SDK)
  - Auth: Two bot tokens required
    - `TELEGRAM_BUSINESS_BOT_TOKEN` - Business notifications
    - `TELEGRAM_BOT_TOKEN` - Customer notifications
  - Base URLs:
    - Business: `https://api.telegram.org/bot{TELEGRAM_BUSINESS_BOT_TOKEN}`
    - Customer: `https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}`
  - Used by: `src/utils/telegram.js`, `src/utils/eskiz.js` (fallback)
  - Functions: `sendTelegramMessage()`
  - Used for: OTP delivery fallback, appointment notifications, reminders
  - Mini App: Integration with Telegram Mini Apps via init data validation

**Social Media:**
- Instagram Graph API - Business account integration and webhooks
  - SDK/Client: HTTP fetch API (no dedicated SDK)
  - Auth: OAuth 2.0 authorization code flow
  - Env vars:
    - `INSTAGRAM_APP_ID` - App client ID
    - `INSTAGRAM_APP_SECRET` - App client secret
    - `INSTAGRAM_CALLBACK_URL` - OAuth redirect URI
  - Base URLs:
    - OAuth: `https://www.instagram.com/oauth/authorize`
    - Token: `https://api.instagram.com/oauth/access_token`
    - Graph: `https://graph.instagram.com`
  - Used by:
    - `src/routes/instagram.js` - Business login and token management
    - `src/routes/instagram-webhook.js` - Webhook event handling
  - Scopes: `instagram_business_basic`, `instagram_business_manage_comments`
  - Token Types: Short-lived (1 hour), Long-lived (~60 days)
  - Webhook: Signature verification with HMAC-SHA256

## Data Storage

**Databases:**
- Google Cloud Firestore
  - Connection: Via `@google-cloud/firestore` SDK v8.0.0
  - Env vars:
    - `DATABASE_ID` - Firestore database ID (optional, uses default)
  - Client: `src/db/db.js` - Singleton Firestore instance
  - Collections:
    - `users` - Customer user profiles
    - `business_owners` - Business owner accounts
    - `businesses` - Business information
    - `businesses/{id}/services` - Services offered
    - `businesses/{id}/employees` - Staff members
    - `businesses/{id}/employees/{empId}/employeeServices` - Employee service pricing
    - `businesses/{id}/customer_conversations/{telegram_id}/messages` - Chat history
    - `bookings` - Appointment records
    - `otps` - OTP codes (legacy, plaintext or bcrypt hash)
    - `bot_otps` - Bot OTP tracking with rate limiting
    - `telegram_otps` - Telegram-specific OTP tracking

**File Storage:**
- Google Cloud Storage
  - SDK/Client: `@google-cloud/storage` v7.18.0
  - Env vars:
    - `GCS_BUCKET_NAME` - Bucket name (default: 'blyss')
  - Access: Public via `https://storage.googleapis.com/{bucket}/{filename}`
  - Used by: `src/utils/storage.js`, `src/routes/businesses.js`
  - Operations: Upload with cache headers (max-age=31536000), delete
  - File types: Business images, employee photos, service images

**Caching:**
- In-memory (Node.js Map) - Distance/routing results
  - Location: `src/routes/distance.js`
  - Strategy: LRU eviction at 1000 entries
  - Key: Rounded coordinates (4 decimal places)
- Token blacklist - `src/utils/tokenBlacklist.js`
  - Stores invalidated JWT tokens

## Authentication & Identity

**Auth Methods:**
1. **HMAC-SHA256 Signature Verification** (primary for server-to-server)
   - Headers: `X-Timestamp`, `X-Signature`
   - Shared secret: `API_SECRET` env var
   - Implementation: `src/middleware/authenticate.js` - `verifyRequestSignature()`
   - Timestamp tolerance: 120 seconds
   - Used by: Bot endpoints, business endpoints, public bookings API

2. **JWT Tokens** (user sessions)
   - Secret: `JWT_SECRET` env var
   - Access token: 24 hours (in cookies or Bearer header)
   - Refresh token: 30 days (in cookies)
   - Implementation: `src/utils/jwt.js`
   - Cookie names: `access_token`, `refresh_token`
   - Used by: User profile endpoints, business management, bookings

3. **Telegram Mini App Auth**
   - Init data validation: `@tma.js/init-data-node` v2.0.6
   - Implementation: `src/middleware/telegramAuth.js`
   - Extracts user data from Telegram Mini App init_data
   - Used by: `/telegram/*` routes

## Monitoring & Observability

**Error Tracking:**
- Not detected

**Logs:**
- Console logging (console.error, console.warn, console.log)
- Approach: Direct Node.js console output
- No centralized logging system detected

## CI/CD & Deployment

**Hosting:**
- Google Cloud Run (implied by Cloud Firestore/Storage integration and project structure)
- Firebase configuration: `firebase.json`

**CI Pipeline:**
- Not detected

**Container:**
- `.dockerignore` present (suggests Docker containerization)
- No `Dockerfile` found in repository root

## Environment Configuration

**Required env vars (startup critical):**
- `API_SECRET` - HMAC signing key (throws fatal error if missing)
- `JWT_SECRET` - JWT signing key (throws fatal error if missing)

**Required for full functionality:**
- `ESKIZ_TOKEN` - SMS delivery (warns if missing)
- `OPENROUTESERVICE_API_KEY` - Distance service (warns if missing)
- `OPENAI_API_KEY` - AI features (disables routes if missing)
- `TELEGRAM_BUSINESS_BOT_TOKEN` - Business notifications
- `TELEGRAM_BOT_TOKEN` - Customer bot notifications
- `INSTAGRAM_APP_ID` - Instagram OAuth
- `INSTAGRAM_APP_SECRET` - Instagram OAuth
- `INSTAGRAM_CALLBACK_URL` - Instagram OAuth callback

**Optional:**
- `DATABASE_ID` - Firestore database (uses default if not set)
- `GCS_BUCKET_NAME` - Storage bucket (default: 'blyss')
- `PORT` - Server port (default: 3000)

**Secrets location:**
- `.env` file in project root (not committed to git)
- Google Cloud credentials: Implicit via application default credentials (Cloud Run/Compute Engine)

## Webhooks & Callbacks

**Incoming:**
- Instagram webhook - `POST /instagram/webhook`
  - Path: `src/routes/instagram-webhook.js`
  - Purpose: Receive Instagram business account events
  - Challenge: Responds to Meta webhook verification request
  - Signature: HMAC-SHA256 verification with Instagram webhook token
  - Event processing: AI-powered response generation for comments

**Outgoing:**
- Eskiz SMS provider - Callback URL configured but not actively used
  - Potential for delivery status callbacks
- Telegram Bot API - Polling or webhook (not configured as incoming webhook)
- Instagram Graph API - Direct API calls, no callbacks expected

---

*Integration audit: 2026-02-24*
