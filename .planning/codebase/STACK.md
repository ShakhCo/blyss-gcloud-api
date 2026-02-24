# Technology Stack

**Analysis Date:** 2026-02-24

## Languages

**Primary:**
- JavaScript (ES Modules) - Backend API codebase
- Node.js runtime with module type: "module" for ES6 imports/exports

## Runtime

**Environment:**
- Node.js (version not specified in package.json, inferred ≥14.x for ES modules)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- Express.js 5.2.1 - HTTP server and routing framework
- Located in: `src/server.js`

**Security:**
- Helmet 8.1.0 - HTTP security headers middleware
- Cookie-parser 1.4.7 - Cookie parsing middleware
- CORS 2.8.5 - Cross-origin request handling
- Express-rate-limit 8.2.1 - Rate limiting middleware

**Validation:**
- Zod 4.2.1 - Schema validation for request bodies
- Validation middleware: `src/middleware/validate.js`
- Schemas defined in: `src/schemas/` (ai.js, auth.js, booking.js, business.js, etc.)

**Testing:**
- Vitest 4.0.16 - Unit test runner
- Supertest 7.1.4 - HTTP assertion library for API testing
- Dev only

**Build/Dev:**
- Nodemon 3.1.11 - Auto-restart on file changes (development only)

## Key Dependencies

**Critical:**
- `@google-cloud/firestore` 8.0.0 - Firestore database client
- `@google-cloud/storage` 7.18.0 - Google Cloud Storage file uploads
- `jsonwebtoken` 9.0.3 - JWT token generation and verification
- `bcryptjs` 3.0.3 - Password hashing (bcrypt)
- `openai` 6.17.0 - OpenAI API client (gpt-4o-2024-08-06 model)
- `dotenv` 17.2.3 - Environment variable loading

**Infrastructure:**
- `multer` 2.0.2 - File upload handling, config: `src/config/multer.js`
- `@tma.js/init-data-node` 2.0.6 - Telegram Mini App init data validation

## Configuration

**Environment:**
- `.env` file present in project root (contains secrets - not shown)
- Key required variables:
  - `API_SECRET` - HMAC-SHA256 signing key (required for startup)
  - `JWT_SECRET` - JWT signing key (required for startup)
  - `OPENAI_API_KEY` - Optional, AI routes disabled if missing
  - `ESKIZ_TOKEN` - SMS provider API key
  - `OPENROUTESERVICE_API_KEY` - Distance calculation service
  - `TELEGRAM_BUSINESS_BOT_TOKEN` - Business bot token
  - `TELEGRAM_BOT_TOKEN` - Customer bot token
  - `INSTAGRAM_APP_ID` - Instagram OAuth app ID
  - `INSTAGRAM_APP_SECRET` - Instagram OAuth app secret
  - `INSTAGRAM_CALLBACK_URL` - Instagram OAuth redirect URI
  - `DATABASE_ID` - Firestore database ID
  - `GCS_BUCKET_NAME` - Google Cloud Storage bucket (default: 'blyss')
  - `PORT` - Server port (default: 3000)

**Build:**
- `package.json` - npm dependency manifest
- `.env` file (environment secrets)
- No webpack/rollup config - runs directly with Node.js ES modules

## Platform Requirements

**Development:**
- Node.js >= 14.x (for ES module support)
- npm or compatible package manager
- Google Cloud credentials (implicit via environment or Google Cloud client libraries)

**Production:**
- Google Cloud Run or similar Node.js container hosting
- Firestore database access
- Google Cloud Storage bucket access
- Environment variables for all external services (Eskiz, OpenAI, OpenRouteService, Telegram, Instagram)

## External Service Integration

**SMS Delivery:**
- Eskiz.uz API (SMS provider) - `src/utils/eskiz.js`
- HTTP endpoint: `https://notify.eskiz.uz/api/message/sms/send`
- Auth via Bearer token in `Authorization` header

**Distance Calculation:**
- OpenRouteService API - `src/routes/distance.js`
- In-memory LRU cache (max 1000 entries)
- Rounded coordinates to 4 decimal places for cache hits

**AI/LLM:**
- OpenAI API - `src/routes/ai.js`
- Model: `gpt-4o-2024-08-06`
- Used for text translation and validation with structured output parsing
- Uses Zod schema parsing with `zodTextFormat` helper

**Messaging:**
- Telegram Bot API - `src/utils/telegram.js`
- Dual bot tokens: business bot and customer bot
- Sends notifications via `sendTelegramMessage()`

**Social Media:**
- Instagram Graph API - `src/utils/instagram.js`
- OAuth 2.0 authorization flow for Business Login
- Token exchange and long-lived token generation
- Webhook integration for Instagram events

**Geolocation:**
- Telegram Mini App init data validation - `src/middleware/telegramAuth.js`
- Using `@tma.js/init-data-node` library

---

*Stack analysis: 2026-02-24*
