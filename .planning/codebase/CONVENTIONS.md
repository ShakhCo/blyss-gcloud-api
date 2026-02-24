# Coding Conventions

**Analysis Date:** 2026-02-24

## Naming Patterns

**Files:**
- camelCase for JavaScript files: `authenticate.js`, `bookingLimits.js`, `eskiz.js`
- Index files named `index.js`: `src/routes/index.js`, `src/db/db.js`
- Utilities grouped in `utils/` with descriptive names: `jwt.js`, `telegram.js`, `storage.js`, `businessStatus.js`
- Middleware files end in descriptive name: `authenticate.js`, `validate.js`, `telegramAuth.js`
- Routes organized by domain: `auth.js`, `bookings.js`, `businesses.js`, `employees.js`, `users.js`, `ai.js`
- Schemas match route domain: `auth.js`, `booking.js`, `business.js`, `employee.js`

**Functions:**
- camelCase throughout: `generateAccessToken()`, `verifyAccessToken()`, `sendOtpSms()`, `isEmployeeOpenNow()`
- Helper functions prefixed logically: `verify*()` for validation, `send*()` for external calls, `calculate*()` for computations, `is*()` for boolean checks, `get*()` for retrievals
- Exported functions at module level use `export function`: `export async function sendSms(...)` in `src/utils/eskiz.js`
- Constants in UPPER_SNAKE_CASE: `ACCESS_TOKEN_COOKIE`, `REFRESH_TOKEN_COOKIE`, `OTP_EXPIRY_MINUTES`, `MAX_TIMESTAMP_DIFF`, `TELEGRAM_API_BASE`
- Constants for configuration: `const API_SECRET = process.env.API_SECRET` with environment variable pattern matching

**Variables:**
- camelCase for all variable declarations: `phoneNumber`, `userData`, `otpDoc`, `dateCreated`, `requestTime`
- Database document references use snake_case in schema: `business_owner_id`, `phone_number`, `is_verified`, `date_created`
- Parameter names in request bodies use snake_case: `otp_code`, `user_type`, `first_name`, `last_name`, `telegram_id`
- Firestore data fields use snake_case consistently: `is_verified`, `is_used`, `is_open`, `expires_at`, `verified_at`
- Temporary loop variables: `i`, `doc`, `user`, etc.

**Types:**
- Zod schemas use PascalCase: `sendOtpSchema`, `verifyOtpSchema`, `loginSchema`, `registerSchema`
- Enum values use lowercase: `z.enum(['user', 'business_owner'])`
- Response schemas explicit: `authResponseSchema`, `meResponseSchema`, `businessResponseSchema`
- Error codes use UPPER_SNAKE_CASE: `INVALID_SIGNATURE`, `VALIDATION_ERROR`, `OTP_EXPIRED`, `USER_NOT_FOUND`, `FORBIDDEN`

## Code Style

**Formatting:**
- No linter or formatter configured (no `.eslintrc`, `.prettierrc`, or similar files found)
- Consistent manual style observed:
  - 2-space indentation throughout (seen in all files)
  - Semicolons used consistently
  - Comments use JSDoc style with `/**` blocks for functions
  - Blank lines between logical sections (seen in `src/routes/auth.js` between endpoint handlers)

**Linting:**
- Not detected - no linting tool configured
- Style conventions are maintained manually by developers

## Import Organization

**Order:**
1. Built-in Node.js modules: `import crypto from 'crypto'`, `import jwt from 'jsonwebtoken'`
2. Third-party packages: `import express from 'express'`, `import { Router } from 'express'`, `import rateLimit from 'express-rate-limit'`, `import bcrypt from 'bcryptjs'`
3. Local modules: `import { db } from '../db/db.js'`, `import { validate } from '../middleware/validate.js'`
4. Named imports grouped together: `import { sendOtpSms, sendSms } from '../utils/eskiz.js'`

**Path Aliases:**
- Relative paths with `../` used throughout: `'../db/db.js'`, `'../middleware/authenticate.js'`, `'../utils/jwt.js'`
- No alias shortcuts configured (no `@/` or similar found)
- Consistent depth relative to file location: routes at `src/routes/` import from `../db/`, `../middleware/`, `../utils/`, `../schemas/`, `../config/`

**File Extension:**
- Always include `.js` extension: `'../db/db.js'` not `'../db/db'` (ES Modules requirement with `"type": "module"` in package.json)

## Error Handling

**Patterns:**
- Try-catch blocks around all async operations in route handlers
- Consistent error response structure:
  ```javascript
  res.status(4xx).json({ error: 'User message', error_code: 'ERROR_CODE' })
  res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  ```
- Error logging via `console.error(error)` followed by response: `console.error(error); res.status(500).json(...)`
- Null-coalescing for optional fields: `userData.telegram_id || null`, `userData.last_name || ''`
- Early returns for validation failures: `if (!token) return res.status(401).json(...)`
- No custom error classes observed - plain Error objects or error code strings

**Validation Errors:**
- Zod schema validation failures return 400 with `validation_errors` array:
  ```javascript
  const result = schema.safeParse(data);
  if (!result.success) {
    const validation_errors = result.error.issues.map(e => ({
      field: e.path.join('.'),
      error: e.message
    }));
    return res.status(400).json({ validation_errors, error_code: 'VALIDATION_ERROR' });
  }
  ```

## Logging

**Framework:** console

**Patterns:**
- `console.error()` for errors: `console.error(error)`, `console.error('FATAL: ...')`
- `console.warn()` for warnings: `console.warn('WARNING: OPENAI_API_KEY not set - ...')`
- `console.log()` for startup info: `console.log('App is running on port: ...')`
- Contextual error messages: `console.error('Telegram API error:', data.description)`, `console.error('Failed to update employee business_owner_id:', updateError)`
- No structured logging (no winston, bunyan, pino) - plain console methods only

## Comments

**When to Comment:**
- JSDoc blocks for all functions: see `src/utils/jwt.js`, `src/utils/telegram.js`, `src/utils/eskiz.js`
- Inline comments for non-obvious logic: timezone conversion comments in `src/routes/bookings.js` and `src/routes/businesses.js`
- Section headers with `//` dividers in route files (e.g., `// ============================================`)
- Configuration comments explaining security decisions: `// Trust proxy for rate limiting (behind Cloudflare/Google Cloud)` in `src/server.js`

**JSDoc/TSDoc:**
- Standard JSDoc format with `@param`, `@returns` tags:
  ```javascript
  /**
   * Verify HMAC-SHA256 signature
   * @param {string} body - Request body as string
   * @param {string} timestamp - Timestamp from header
   * @param {string} signature - Signature from header
   * @returns {boolean} Whether the signature is valid
   */
  ```
- Type hints in JSDoc parameters: `@param {string}`, `@param {number}`, `@param {Object}`, `@param {boolean}`, `@param {Promise<object>}`
- Return type descriptions: `@returns {boolean}`, `@returns {string|null}`, `@returns {{valid: boolean, error?: string}}`

## Function Design

**Size:**
- Functions range from 5-50 lines in utility files
- Route handlers (endpoints) typically 30-80 lines including validation and database operations
- Helper functions kept focused: `secondsToTime()` - 4 lines, `timeToMinutes()` - 3 lines, `calculateEndTime()` - 8 lines
- Longer functions broken into logical sections with comments

**Parameters:**
- Individual parameters preferred over objects for small counts: `sendTelegramMessage(telegramId, text, options = {})`
- Request body data destructured from `req.validated` after Zod validation: `const { phone_number, user_type } = req.validated`
- Middleware functions consistently use `(req, res, next)` signature: `export const authenticate = async (req, res, next) => {...}`
- Optional parameters use default values: `sendOtpSms(phoneNumber, otpCode, userType = 'user')`

**Return Values:**
- Functions return Promise for async operations: `export async function sendSms(phoneNumber, message)`
- Utility functions return data objects: `{ success: true }`, `{ accessToken, refreshToken }`
- Boolean functions use is/check prefixes: `isEmployeeOpenNow()`, `verifyHmacSignature()` returns boolean
- Middleware returns `void` (implicit) or calls `next()` or `res.status().json()`
- Error returns use early exit pattern: `return res.status(code).json(...)`

## Module Design

**Exports:**
- Individual function exports used throughout: `export const authenticate = async (req, res, next) => {...}`
- Default exports for routers: `export default router` in each route file
- Named exports for utilities: `export async function sendSms(...)`, `export const verifyAccessToken = (...) => {...}`
- Mixed exports in some files: default router + named constants: `export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE }` in `src/middleware/authenticate.js`

**Barrel Files:**
- `src/routes/index.js` imports all route modules and maps to path patterns - acts as central router
- No explicit barrel files in `src/schemas/`, `src/utils/`, or `src/middleware/` - each file imported individually
- Database instance exported from single file: `src/db/db.js` - `export { db }`

## Request/Response Patterns

**Request Body:**
- All request data validated through Zod schemas passed to `validate()` middleware
- Validated data accessed via `req.validated`: `const { phone_number, user_type } = req.validated`
- Request body must be present for POST: `validate(schema)` middleware checks `req.body` is not empty

**Response Format:**
- Success responses return plain object: `res.json({ id, ...data })`
- Error responses include `error` message and `error_code` string: `res.status(4xx).json({ error: '...', error_code: 'ERROR_CODE' })`
- Validation errors return array: `res.status(400).json({ validation_errors: [...], error_code: 'VALIDATION_ERROR' })`
- HTTP status codes: 200 (success), 201 (created), 400 (validation), 401 (auth), 403 (forbidden), 404 (not found), 409 (conflict), 429 (rate limited), 500 (server error)

## Database Patterns

**Firestore Usage:**
- Singleton instance in `src/db/db.js`: `const db = new Firestore({ databaseId: process.env.DATABASE_ID })`
- Collections accessed via `db.collection('name')` - no collections abstraction layer
- Queries use where/orderBy/limit: `db.collection('otps').where('phone_number', '==', phoneNumber).orderBy('date_created', 'desc').limit(1).get()`
- Batch writes for multiple updates: `const batch = db.batch(); ... batch.update(ref, data); await batch.commit()`
- Document creation with auto-ID: `db.collection('otps').add({...})` returns doc with ID
- Document creation with specific ID: `db.collection(collection).doc(userId).set(createData)`
- Date fields use `new Date()` and `.toDate()` for reading: `otpData.date_created.toDate()`

## Authentication Patterns

**Signature Verification:**
- HMAC-SHA256 on `body + timestamp` with timing-safe comparison
- Headers: `X-Timestamp` (seconds since epoch), `X-Signature` (hex digest)
- Max timestamp diff: 120 seconds
- Verification middleware: `src/middleware/authenticate.js` - `verifySignature()` function
- Raw body preserved in middleware: `req.rawBody = buf.toString('utf-8')`

**JWT Tokens:**
- Access token: 24 hours, stored in httpOnly cookie `access_token`
- Refresh token: 30 days, stored in httpOnly cookie `refresh_token`
- Token payload: `{ user_id, user_type, type: 'access'|'refresh' }`
- Token verification uses `jsonwebtoken` library
- Cookie settings: `httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict'`

---

*Convention analysis: 2026-02-24*
