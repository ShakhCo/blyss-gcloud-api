# Architecture

**Analysis Date:** 2026-02-24

## Pattern Overview

**Overall:** Layered MVC-style REST API with Express.js

**Key Characteristics:**
- Request signature verification (HMAC-SHA256) for security
- JWT-based session management (access + refresh tokens)
- Multiple authentication paths (signature, JWT, Telegram Mini App init data)
- Zod schema validation for all input
- Firestore as primary database with in-memory caching for tokens/lists
- Centralized error responses with standardized error codes

## Layers

**Presentation Layer (Routes):**
- Purpose: Handle HTTP requests, parse inputs, return JSON responses
- Location: `src/routes/`
- Contains: 17 route modules (auth.js, bookings.js, businesses.js, telegram.js, ai.js, etc.)
- Depends on: Middleware, schemas, utils, database
- Used by: Express router at `src/server.js`

**Middleware Layer:**
- Purpose: Cross-cutting concerns (authentication, validation, security)
- Location: `src/middleware/`
- Contains:
  - `authenticate.js`: JWT verification and user data enrichment (required and optional)
  - `telegramAuth.js`: Telegram Mini App init data validation with dual-token fallback
  - `validate.js`: Zod schema validation middleware
- Depends on: Database, utils (JWT)
- Used by: All routes via Express middleware stack

**Validation Layer:**
- Purpose: Define and enforce request/response schemas
- Location: `src/schemas/`
- Contains: 12 schema files (auth.js, booking.js, business.js, etc.) using Zod
- Depends on: Zod library
- Used by: Routes via validate middleware

**Business Logic / Utilities:**
- Purpose: Reusable functions for domain logic
- Location: `src/utils/`
- Contains:
  - `jwt.js`: Token generation and verification
  - `eskiz.js`: SMS OTP delivery integration
  - `telegram.js`: Telegram notifications
  - `storage.js`: Google Cloud Storage file operations
  - `bookingLimits.js`: User booking limit enforcement
  - `businessStatus.js`: Business active/inactive status checks
  - `instagram.js`: Instagram webhook handling
  - `encryption.js`: Field-level encryption
  - `cloudflare.js`: Cloudflare integration
  - `tokenBlacklist.js`: Token revocation tracking
  - `refreshTokens.js`: Token rotation
- Depends on: Database, external services
- Used by: Routes and other utilities

**Data Access Layer:**
- Purpose: Database connection and initialization
- Location: `src/db/db.js`
- Contains: Firestore instance initialization
- Depends on: @google-cloud/firestore
- Used by: All routes and middleware

**Configuration:**
- Purpose: Non-sensitive environment setup
- Location: `src/config/`
- Contains: `multer.js` - file upload configuration
- Depends on: Multer library
- Used by: Routes that handle file uploads

**Application Entry Point:**
- Purpose: Express app initialization, middleware setup, CORS configuration
- Location: `src/server.js`
- Depends on: All middleware, routes, config
- Used by: Node runtime (npm start / npm run dev)

## Data Flow

**Authentication Flow (Signature Verification):**

1. Client sends request with `X-Timestamp` and `X-Signature` headers
2. `verifySignature` middleware in `src/middleware/authenticate.js` intercepts
3. Middleware reconstructs HMAC-SHA256(`body + timestamp`, `API_SECRET`)
4. If valid, request continues; if invalid, 401 with `INVALID_SIGNATURE` error code
5. For protected routes, `authenticate` middleware then verifies JWT token

**Request Processing Flow:**

1. Express receives request → applies security headers (helmet)
2. Signature verification middleware (`verifySignature`)
3. Route handler receives request
4. Input validation via `validate(schema)` middleware → sets `req.validated`
5. Authentication middleware (`authenticate` or `telegramAuth`)
6. Route handler executes business logic
7. Database queries via `db` instance
8. Utility functions called for SMS, notifications, etc.
9. Response formatted as JSON with id field (success) or error_code (error)
10. Response sent to client

**Booking Creation Flow:**

1. Request: `POST /bookings` with booking details
2. Rate limiting check (10 requests per 15 minutes)
3. Signature + JWT verification
4. Zod schema validation
5. Business and employee existence checks in Firestore
6. Availability checking (working hours, existing bookings)
7. User booking limit validation (max concurrent bookings per user)
8. Booking document creation in `bookings` collection
9. Telegram notifications sent to business
10. Response: `{ id, business_id, customer_name, ... }`

**Telegram Mini App Flow:**

1. Frontend sends request with `Authorization: tma <initDataRaw>` header
2. `telegramAuth` middleware validates init data
3. Tries main bot token first (fast path) via `validate()` from @tma.js/init-data-node
4. Falls back to business-specific bot tokens (slow path, cached)
5. Parses init data to extract Telegram user ID and metadata
6. Attaches `req.telegramUser` and `req.telegramInitData`
7. Route handler processes request with Telegram user context
8. Response includes data relevant to Telegram Mini App

**Authentication Token Management:**

1. User login: `generateTokenPair(payload)` creates access (24h) + refresh (30d) tokens
2. Tokens set as httpOnly cookies with secure/sameSite flags
3. Each subsequent request: middleware extracts token from cookie or Authorization header
4. `verifyAccessToken()` confirms token type and expiry
5. User document fetched from Firestore (users or business_owners collection)
6. User data attached to `req.user`
7. Token refresh: POST /auth/refresh-token with refresh token generates new access token

**State Management:**

- **In-Memory Caching:** Token blacklist (`src/utils/tokenBlacklist.js`), business bot token list (5-minute TTL in `telegramAuth.js`)
- **Firestore State:** User sessions stored implicitly via JWT (stateless); tokens not persisted
- **File Storage:** Google Cloud Storage for photos, documents; references stored in Firestore
- **Request State:** Validated data in `req.validated`, authenticated user in `req.user`, Telegram user in `req.telegramUser`

## Key Abstractions

**Middleware Chain Pattern:**

Layered middleware composition allows cross-cutting concerns:
```javascript
// Order matters: signature → validate body → authenticate → route handler
router.post('/path',
    verifySignature,           // Auth boundary
    validate(schema),           // Input validation
    authenticate,               // User context
    (req, res) => { ... }       // Handler
);
```

**Schema-Driven Validation:**

All input validated with Zod schemas before reaching handler:
- `src/schemas/auth.js`: Login, OTP, register schemas
- `src/schemas/booking.js`: Booking creation, queries
- `src/schemas/business.js`: Business CRUD
- All schemas use `.safeParse()` for non-throwing validation
- Validation errors returned with field-level details

**Error Response Standardization:**

All errors follow pattern:
```javascript
// Error response
res.status(4xx).json({
    error: "Human readable message",
    error_code: "SCREAMING_SNAKE_CASE"  // For client error handling
})

// Success response
res.json({
    id: "...",           // Document ID from Firestore
    ...documentData      // Spread document fields
})
```

Common error codes: `INVALID_SIGNATURE`, `NO_TOKEN`, `INVALID_TOKEN`, `USER_NOT_FOUND`, `INVALID_OTP`, `SLOT_NOT_AVAILABLE`, `USER_TIME_CONFLICT`, `RATE_LIMITED`, `VALIDATION_ERROR`

**Dual-Token JWT Strategy:**

- `ACCESS_TOKEN` (24h): For regular API requests, short-lived, httpOnly cookie
- `REFRESH_TOKEN` (30d): For obtaining new access token, long-lived, httpOnly cookie
- Tokens store `user_id`, `user_type` (user vs business_owner), and `type` field
- `verifyAccessToken()` confirms type === 'access' before allowing request
- `verifyRefreshToken()` confirms type === 'refresh' when rotating tokens

**External Service Integration Patterns:**

- **Eskiz SMS:** `sendOtpSms()` in `src/utils/eskiz.js` wraps API
- **Telegram Bot:** `sendBookingCancellationNotification()` in `src/utils/telegram.js` sends messages to users
- **Google Cloud Storage:** `uploadFile()`, `deleteFile()` in `src/utils/storage.js`
- **OpenAI:** Integrated in `src/routes/ai.js` with structured output via Zod
- Each integration has error handling and is optional (e.g., AI routes fail gracefully if OPENAI_API_KEY missing)

## Entry Points

**HTTP Server:**
- Location: `src/server.js`
- Triggers: `npm start` or `npm run dev`
- Responsibilities:
  - Initialize Express app
  - Load environment variables via dotenv
  - Apply global middleware (helmet, CORS, body parsing)
  - Mount all route handlers
  - Listen on PORT (default 3000)

**Public Route Handler:**
- Location: `src/routes/public.js` (mounted as `/public/*`)
- Triggers: Requests without signature or auth headers
- Responsibilities: Search businesses, get services, filters (no authentication required)

**Auth Route Handler:**
- Location: `src/routes/auth.js` (mounted as `/auth/*` with `verifySignature`)
- Triggers: OTP requests, login, register, token refresh
- Responsibilities: Generate OTP, verify OTP, authenticate user, issue tokens

**Telegram Mini App Route Handler:**
- Location: `src/routes/telegram.js` (mounted as `/telegram/*` with `telegramAuth`)
- Triggers: Requests from Telegram Mini App client
- Responsibilities: Get businesses, available slots, create booking, with Telegram user context

**Bot Route Handler:**
- Location: `src/routes/bot.js` (mounted as `/bot/*` with `verifySignature`)
- Triggers: Telegram bot server sending webhook events
- Responsibilities: Process bot commands, business messages

**Cron Route Handler:**
- Location: `src/routes/cron.js` (mounted as `/cron/*`)
- Triggers: Google Cloud Scheduler jobs
- Responsibilities: Cleanup expired OTPs, update booking statuses, send reminders

## Error Handling

**Strategy:** Defensive error handling with consistent response format

**Patterns:**

1. **Validation Errors (400):**
   - Zod schema validation failures return detailed field errors
   - Response: `{ validation_errors: [{ field, error }], error_code: 'VALIDATION_ERROR' }`

2. **Authentication Errors (401):**
   - Missing token: `{ error: 'Authorization token required', error_code: 'NO_TOKEN' }`
   - Invalid signature: `{ error: 'Invalid signature', error_code: 'INVALID_SIGNATURE' }`
   - Expired/invalid token: `{ error: 'Invalid or expired token', error_code: 'INVALID_TOKEN' }`

3. **Rate Limiting (429):**
   - Express-rate-limit middleware catches excessive requests
   - Response: `{ error: 'Too many X requests...', error_code: 'RATE_LIMITED' }`

4. **Resource Not Found (404):**
   - Business/user/booking not found in Firestore
   - Response: `{ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' }`

5. **Business Logic Errors (400/409):**
   - Slot not available: `{ error: 'No available slots', error_code: 'SLOT_NOT_AVAILABLE' }`
   - User time conflict: `{ error: 'User has conflicting booking', error_code: 'USER_TIME_CONFLICT' }`
   - Invalid OTP: `{ error: 'Invalid OTP', error_code: 'INVALID_OTP' }`

6. **Internal Server Errors (500):**
   - All uncaught errors logged to console
   - Response: `{ error: 'Internal server error', error_code: 'INTERNAL_ERROR' }`
   - Database errors, external service failures caught in try-catch

7. **Service Unavailable (503):**
   - External service not configured (e.g., OPENAI_API_KEY missing)
   - Response: `{ error: 'AI service not configured', error_code: 'SERVICE_UNAVAILABLE' }`

## Cross-Cutting Concerns

**Logging:**
- Console.error for exceptions and important events
- No centralized logging framework (direct to stdout for Cloud Run)

**Validation:**
- Zod schemas define all input contracts
- Validate middleware enforces schemas before handlers
- Coercion (e.g., string to number) handled in schema definitions

**Authentication:**
- HMAC-SHA256 signature verification for client→server security
- JWT for stateless session management
- Telegram init data validation for Mini App routes
- Three auth levels: none (public), signature only, signature + JWT

**Authorization:**
- Implicit via `req.user.user_type` ('user' vs 'business_owner')
- Routes check user type and ownership before allowing operations
- Example: Only business owner can edit their business's employees

**Rate Limiting:**
- Applied per route (booking creation, OTP send/verify)
- Express-rate-limit with IP-based tracking
- Different limits per operation (5 OTP requests per 5 min, 10 bookings per 15 min)

**Security Headers:**
- Helmet middleware applies default security headers
- CORS whitelists specific origins (blyss.uz domain + custom mini-app domains)
- Cookie flags: httpOnly, secure (production), sameSite=strict

**File Upload:**
- Multer configured for image uploads only (JPEG, PNG, WebP)
- Memory storage, 5MB file size limit
- Files uploaded to Google Cloud Storage
- File URLs stored in Firestore documents

**Token Blacklist / Revocation:**
- `src/utils/tokenBlacklist.js` maintains in-memory set of revoked tokens
- Used on logout to prevent token reuse
- Tokens still verified for expiry independently

---

*Architecture analysis: 2026-02-24*
