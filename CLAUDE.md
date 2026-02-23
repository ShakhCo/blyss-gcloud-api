# CLAUDE.md

## Project Overview

**blyss-gcloud-api** is a multi-tenant booking and appointment management REST API for businesses in Uzbekistan. It runs on Google Cloud Run and uses Firestore as its database. The API serves three client types: a Telegram Mini App, a Telegram bot server, and a web frontend.

## Tech Stack

- **Runtime:** Node.js with ES modules (`"type": "module"` in package.json)
- **Framework:** Express.js v5
- **Database:** Google Cloud Firestore (NoSQL)
- **File Storage:** Google Cloud Storage
- **Validation:** Zod v4
- **Auth:** JWT + HMAC-SHA256 request signing + Telegram init data
- **Testing:** Vitest + Supertest
- **Deployment:** Google Cloud Run (containerized)

## Commands

```bash
npm start        # Start production server (node src/server.js)
npm run dev      # Start dev server with hot reload (nodemon)
npm run test     # Run test suite (vitest run)
```

## Project Structure

```
src/
├── server.js              # Express app entry point (port from PORT env, default 3000)
├── server.test.js          # Test suite
├── config/
│   └── multer.js           # File upload config (JPEG/PNG/WebP, 5MB max)
├── db/
│   └── db.js               # Firestore client initialization
├── middleware/
│   ├── authenticate.js     # HMAC signature verification + JWT auth
│   ├── telegramAuth.js     # Telegram Mini App init data validation
│   └── validate.js         # Zod schema validation middleware
├── routes/                 # Route handlers (one file per domain)
│   ├── index.js            # Route mounting and middleware assignment
│   ├── auth.js             # OTP, login, register, token refresh
│   ├── bookings.js         # Booking CRUD and availability
│   ├── businesses.js       # Business profiles, services, employees
│   ├── telegram.js         # Telegram Mini App endpoints
│   ├── bot.js              # Telegram bot server endpoints
│   ├── public.js           # Unauthenticated public endpoints
│   ├── cron.js             # Cloud Scheduler jobs
│   ├── instagram.js        # Instagram OAuth and integration
│   ├── instagram-webhook.js # Instagram webhook receiver
│   └── ...                 # users, employees, places, distance, ai, etc.
├── schemas/                # Zod validation schemas (one file per domain)
│   ├── booking.js
│   ├── business.js
│   ├── auth.js
│   └── ...
└── utils/                  # Shared utilities
    ├── jwt.js              # Token generation and verification
    ├── storage.js          # GCS upload/delete helpers
    ├── telegram.js         # Telegram bot messaging
    ├── eskiz.js            # SMS via Eskiz API
    ├── bookingLimits.js    # Booking limit enforcement
    └── ...
functions/                  # Firebase Cloud Functions (separate package.json)
```

## Architecture and Conventions

### Authentication Layers

Routes are protected by different auth strategies depending on the client. See `src/routes/index.js` for the mapping:

| Route prefix | Auth method | Client |
|---|---|---|
| `/public/*` | None | Web frontend |
| `/telegram/*` | Telegram init data | Telegram Mini App |
| `/bot/*` | HMAC-SHA256 signature | Telegram bot server |
| `/cron/*` | Bearer token | Cloud Scheduler |
| `/instagram/webhook/*` | Meta signature | Instagram |
| All others (`/auth`, `/users`, `/businesses`, etc.) | HMAC-SHA256 signature + JWT | Mobile/web apps |

### Request Signing (HMAC-SHA256)

Most routes require signed requests with two headers:
- `X-Signature`: HMAC-SHA256 of `(rawBody + timestamp)` using `API_SECRET`
- `X-Timestamp`: Unix timestamp (max 120s drift allowed)

Multipart form-data requests bypass body signing (signature covers empty string + timestamp).

### JWT Tokens

- Access token: 24h expiry, sent via `Authorization: Bearer` header or `access_token` httpOnly cookie
- Refresh token: 30d expiry, stored in Firestore `refresh_tokens` collection
- Claims include: `user_id`, `user_type` (`"user"` or `"business_owner"`), `type` (`"ACCESS"` or `"REFRESH"`)

### Validation Pattern

All request validation uses Zod schemas through the `validate` middleware:

```js
import { validate } from '../middleware/validate.js';
import { createBookingSchema } from '../schemas/booking.js';

router.post('/', validate(createBookingSchema), async (req, res) => {
    const data = req.validated; // Parsed and validated data
});
```

- Schemas live in `src/schemas/`, one file per domain
- Validated data is available on `req.validated`
- Query params: use `validate(schema, 'query')`
- Body validation: use `validate(schema)` (default)
- Validation errors return 400 with `{ validation_errors: [...], error_code: 'VALIDATION_ERROR' }`

### Error Response Format

All errors follow a consistent shape:

```json
{
    "error": "Human-readable message",
    "error_code": "MACHINE_READABLE_CODE"
}
```

Validation errors add a `validation_errors` array with `{ field, error }` objects.

### Firestore Patterns

- Firestore client is initialized in `src/db/db.js` and imported as `{ db }`
- User/business owner documents are keyed by Telegram ID (as a string)
- Businesses use hierarchical subcollections: `businesses/{id}/services`, `businesses/{id}/employees`, `businesses/{id}/bookings`
- Composite indexes are defined in `firestore.indexes.json`

### Localization

Service names and some content use localized objects: `{ uz: "...", ru: "..." }` (Uzbek and Russian).

### Phone Numbers

All phone numbers use Uzbek format: `998XXXXXXXXX` (12 digits, no `+` prefix). Validated by regex `^998\d{9}$`.

## Environment Variables

**Required (server won't start without these):**
- `API_SECRET` — HMAC secret for request signing
- `JWT_SECRET` — JWT signing secret
- `DATABASE_ID` — Firestore database ID

**Optional:**
- `PORT` — Server port (default: `3000`)
- `NODE_ENV` — `development` or `production` (affects cookie `secure` flag)
- `TELEGRAM_BOT_TOKEN` — Customer-facing Telegram bot
- `TELEGRAM_BUSINESS_BOT_TOKEN` — Business-facing Telegram bot
- `ESKIZ_TOKEN` — SMS service token
- `OPENAI_API_KEY` — OpenAI API key
- `OPENROUTESERVICE_API_KEY` — Distance calculation API
- `GCS_BUCKET_NAME` — GCS bucket (default: `blyss`)
- `ADMIN_GROUP_ID` — Telegram admin group for notifications

## Testing

Tests are in `src/server.test.js` using Vitest and Supertest. Run with `npm test`.

The test suite covers CORS configuration and basic API routes. When adding new endpoints, add corresponding tests following the existing patterns (describe/it blocks with supertest requests).

## Key Conventions to Follow

1. **ES modules only** — Use `import`/`export`, never `require()`
2. **One route file per domain** — Add new routes in `src/routes/`, register them in `src/routes/index.js`
3. **One schema file per domain** — Add validation schemas in `src/schemas/`
4. **Always validate input** — Use Zod schemas with the `validate` middleware for all endpoints accepting user input
5. **Use `req.validated`** — After validation middleware, read from `req.validated`, not `req.body`
6. **Consistent error codes** — Return `error` (string) and `error_code` (UPPER_SNAKE_CASE) in all error responses
7. **Rate limiting** — Apply `rateLimit` from `express-rate-limit` to sensitive endpoints (OTP, bookings)
8. **File uploads** — Use multer config from `src/config/multer.js`; only JPEG, PNG, WebP up to 5MB
9. **No secrets in code** — All secrets come from environment variables
10. **Firestore subcollections** — Business-scoped data goes under `businesses/{id}/` subcollections
