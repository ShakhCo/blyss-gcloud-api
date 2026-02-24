# Codebase Concerns

**Analysis Date:** 2026-02-24

## Tech Debt

**Inconsistent Error Handling:**
- Issue: 161 `catch (error)` blocks across codebase with most only logging `console.error(error)` before returning generic 500 errors
- Files: `src/routes/bookings.js`, `src/routes/telegram.js`, `src/routes/public.js`, `src/routes/businesses.js` (and 20+ others)
- Impact: Limited observability, difficult error diagnosis in production, no structured error logging, context lost
- Fix approach: Implement centralized error handler middleware with structured logging (error type, stack, context), distinguish between operational errors (user input) and programmer errors (unexpected failures), add error categorization for monitoring

**Legacy Encryption Fallback:**
- Issue: Decrypt function in `src/utils/encryption.js` falls back to unencrypted plaintext if not in `iv:authTag:ciphertext` format
- Files: `src/utils/encryption.js` lines 38-42
- Impact: Security vulnerability - could silently accept unencrypted tokens/sensitive data, data format confusion, no migration path specified
- Fix approach: Remove fallback, add migration tool to encrypt all existing tokens, log errors when malformed tokens encountered, establish deprecation timeline

**In-Memory Caching Without Persistence:**
- Issue: `distanceCache` Map in `src/routes/telegram.js` caches OpenRouteService distance calculations in-memory with naive LRU (deletes first key when max size reached)
- Files: `src/routes/telegram.js` lines 29-48
- Impact: Cache lost on server restart, no cache coherence across multiple instances, naive eviction may remove hot entries, no TTL/staleness detection
- Fix approach: Add Redis for distributed caching with configurable TTL (e.g., 7 days for stable routes), implement LRU properly with LRU package, add cache metrics

**Bot Token Cache with TTL Issues:**
- Issue: `botTokenCache` in `src/middleware/telegramAuth.js` fetches bot tokens with 5-minute TTL but no error handling if fetch fails mid-request
- Files: `src/middleware/telegramAuth.js`
- Impact: Could serve stale tokens if fetch fails, inconsistent state between requests, no fallback
- Fix approach: Add exponential backoff retry, implement circuit breaker pattern, cache multiple fallback tokens, test failure scenarios

**Duplicate Time Conversion Logic:**
- Issue: `isEmployeeOpenNow()` function duplicated in `src/routes/bookings.js`, `src/routes/businesses.js`, `src/routes/telegram.js`
- Files: `src/routes/bookings.js` lines 79-98, `src/routes/businesses.js` lines 25-51, `src/routes/telegram.js`
- Impact: Maintenance burden, potential divergence of logic, timezone handling inconsistencies, violates DRY
- Fix approach: Extract to `src/utils/timeZone.js` as single source of truth, add unit tests, update all three route files to import from utils

## Known Bugs

**Double Error Response in Console Output:**
- Issue: Some error handlers have duplicate `console.error` statements followed by response, e.g. `src/routes/bookings.js` line 238-239
- Files: `src/routes/bookings.js` line 238-239 (`console.error(...); console.error(error)`)
- Trigger: Any error in service employees endpoint
- Workaround: Benign - extra logging only
- Impact: Noise in logs, suggests copy-paste errors elsewhere

**Multipart Form Data Signature Handling:**
- Issue: Signature verification treats multipart requests (with files) as empty body `''` in `src/middleware/authenticate.js` line 71
- Files: `src/middleware/authenticate.js` lines 69-72
- Trigger: Any file upload endpoint using multer with signature verification
- Impact: Multipart requests bypass signature verification, security gap for upload endpoints
- Fix approach: Implement proper multipart signature verification or exclude specific file endpoints from signature check, document which endpoints skip signature for multipart

**Unhandled Promise Rejection in Concurrent Operations:**
- Issue: `Promise.all()` used extensively without rejection handlers, e.g. `src/routes/bookings.js` line 170
- Files: `src/routes/bookings.js` lines 164-170, `src/routes/public.js`, `src/routes/businesses.js`
- Trigger: Any database fetch fails in batch operations (e.g., fetching business owner data)
- Workaround: Single owner fetch failure silently skips that owner's data
- Impact: Silent failures in batch operations lead to incomplete responses
- Fix approach: Wrap `Promise.all()` with error context, use `Promise.allSettled()` where partial failure acceptable, add logging for rejections

## Security Considerations

**API Secret Timing Window:**
- Risk: Timestamp tolerance set to 120 seconds in `src/middleware/authenticate.js` line 12, allowing 2-minute window for replay attacks
- Files: `src/middleware/authenticate.js` lines 11-12
- Current mitigation: HMAC-SHA256 with timing-safe comparison, timestamp validation
- Recommendations: Reduce MAX_TIMESTAMP_DIFF to 30 seconds (standard), implement request ID deduplication cache, log all out-of-window requests for analysis

**JWT Secret Validation Missing at Startup:**
- Risk: If JWT_SECRET env var is missing, error is thrown synchronously but API_SECRET missing is fatal - inconsistent
- Files: `src/utils/jwt.js` lines 3-6, `src/middleware/authenticate.js` lines 6-9
- Current mitigation: Error thrown on startup
- Recommendations: Create startup validation module to check all critical env vars (JWT_SECRET, API_SECRET, ENCRYPTION_KEY) before app runs, provide clear documentation of required secrets

**Encryption Key Hex Format Validation:**
- Risk: ENCRYPTION_KEY must be exactly 64-char hex string but validation only checks length, not character validity
- Files: `src/utils/encryption.js` lines 8-13
- Current mitigation: Node crypto will fail at cipher time with cryptic error
- Recommendations: Add `Buffer.from(hex, 'hex')` validation upfront with clear error message, document key generation procedure

**Telegram Init Data Validation:**
- Risk: Telegram Mini App init data validation in `src/middleware/telegramAuth.js` depends on external library `@tma.js/init-data-node` without fallback
- Files: `src/middleware/telegramAuth.js`
- Current mitigation: Library handles cryptographic verification
- Recommendations: Add timeout to validation (external call), log validation failures for abuse detection, implement rate limiting per telegram_user_id

**Unencrypted Sensitive Data in Logs:**
- Risk: `console.error(error)` throughout codebase may log request bodies containing phone numbers, booking details
- Files: 161 catch blocks across src/
- Current mitigation: None
- Recommendations: Implement log sanitization middleware that strips/masks sensitive fields (phone_number, credit_card, passwords), use structured logging with field redaction

## Performance Bottlenecks

**N+1 Queries in Service Employees Endpoint:**
- Problem: For each employee, fetches `employeeServices` subcollection in loop (`src/routes/bookings.js` lines 174-186)
- Files: `src/routes/bookings.js` lines 173-226
- Cause: No batch loading of employee services, sequential queries
- Impact: If business has 20 employees offering a service, generates 20+ additional queries
- Improvement path: Batch load all `employeeServices` docs upfront using Promise.all(), index by employee_id

**Business Owner Lookups in Batch Operations:**
- Problem: Fetches business owner docs one-by-one even when already loaded (`src/routes/bookings.js` lines 164-170)
- Files: `src/routes/bookings.js` lines 162-170, `src/routes/public.js` similar pattern
- Cause: No deduplication of owner IDs before fetching
- Impact: 10 employees with same owner = 10 database reads for same owner doc
- Improvement path: Use Map to deduplicate owner_ids, single `Promise.all()` batch fetch

**Large File Size Uploads:**
- Problem: Multer config in `src/config/multer.js` and express in `src/server.js` both limit to 1MB
- Files: `src/config/multer.js`, `src/server.js` line 43
- Cause: Default limits too restrictive for image uploads from mobile
- Impact: Business photos (logo, gallery) limited to 1MB, poor image quality at scale
- Improvement path: Increase to 10MB for images, add image optimization (resize before upload), implement chunked upload for very large files

**Distance Calculation Cache Thrashing:**
- Problem: Cache max size 1000 entries, naive FIFO eviction with high mobility apps
- Files: `src/routes/telegram.js` lines 31, 42-48
- Cause: Distance between user and businesses changes frequently, working set likely exceeds 1000
- Impact: Cache hit rate poor for active users, repeated API calls to OpenRouteService
- Improvement path: Increase cache to 5000 or implement Redis, add analytics to measure hit rate, use geographic hashing for better locality

**Synchronous Crypto Operations:**
- Problem: HMAC signature verification, JWT signing use synchronous crypto methods
- Files: `src/middleware/authenticate.js` lines 21-30, `src/utils/jwt.js`
- Cause: Easier to reason about, but blocks event loop
- Impact: High load with many signature verifications may cause slowdown
- Improvement path: Profile first to measure impact, if needed switch to async crypto (crypto.createHmac does not have async variant, but signatures are fast), prioritize other optimizations first

## Fragile Areas

**Booking Creation Logic:**
- Files: `src/routes/bookings.js` lines 240+, `src/routes/telegram.js` (duplicated logic)
- Why fragile: Complex state machine (pending → confirmed → completed/cancelled), multiple concurrent writes, booking limit checks, slot availability validation, timestamp handling
- Safe modification: Add comprehensive unit tests for state transitions, use transaction-like patterns or Firestore batch writes, document edge cases (double bookings, concurrent cancellations)
- Test coverage: Only 1 basic CORS test exists in `src/server.test.js`, no booking tests

**Authentication Middleware Chain:**
- Files: `src/middleware/authenticate.js`, `src/middleware/telegramAuth.js`, `src/middleware/validate.js`
- Why fragile: Multiple auth methods (signature, JWT, Telegram init data), token extraction from cookies/headers, user type inference, Firestore lookup
- Safe modification: Add integration tests for all auth combinations, document exact auth flow per route group, test token expiry/refresh edge cases
- Test coverage: None - no integration tests for auth

**Employee Availability Logic:**
- Files: `src/routes/bookings.js`, `src/routes/businesses.js`, `src/routes/telegram.js` (duplicated)
- Why fragile: Timezone conversion (UTC → GMT+5 manually), working hours validation, `is_open_now` checks
- Safe modification: Extract to tested utility, add timezone tests for DST edge cases, test all days/times
- Test coverage: No timezone tests

**Multipart Form Data Handling:**
- Files: `src/config/multer.js`, `src/server.js` lines 42-46
- Why fragile: Signature verification bypasses multipart, rawBody capture only for JSON
- Safe modification: Document which endpoints use multipart, add signature bypass allowlist, test file uploads with various sizes
- Test coverage: None for file uploads

## Scaling Limits

**In-Memory Distance Cache:**
- Current capacity: 1000 entries, single instance only
- Limit: Breaks when working set exceeds 1000 or across multiple instances
- Scaling path: Migrate to Redis (horizontal scaling), add cache layer with TTL

**Bot Token Cache Single Instance:**
- Current capacity: Single in-memory array, 5-minute TTL
- Limit: Multi-instance deployments have cache coherence issues
- Scaling path: Use Firestore for distributed token cache (eventual consistency acceptable)

**Rate Limiting Per Instance:**
- Current capacity: express-rate-limit uses in-memory store
- Limit: Breaks with load balancing across multiple instances
- Scaling path: Use Redis or Firestore store for distributed rate limiting, add per-user limits in addition to per-IP

**Direct Firestore Queries:**
- Current capacity: No query optimization, no composite index strategy documented
- Limit: Complex queries (where + orderBy) may slow down with large collections
- Scaling path: Create composite indexes upfront, document query patterns, add read quotas

## Dependencies at Risk

**@google-cloud/firestore@^8.0.0:**
- Risk: Used for all data access, tight coupling to Firestore API
- Impact: If migration needed (different database), significant rewrite required
- Migration plan: Abstract database layer behind repository pattern, create mock Firestore for tests

**openai@^6.17.0:**
- Risk: OpenAI API changes, model deprecations (currently using `gpt-4o-2024-08-06`)
- Impact: AI features break if model deprecated, cost increases with usage
- Migration plan: Add abstraction for LLM provider, implement fallback provider, add configurable model versioning

**bcryptjs@^3.0.3:**
- Risk: JavaScript implementation of bcrypt, slower than native bcrypt for password hashing
- Impact: Password verification slower than necessary, but adequate for current scale
- Migration plan: Consider native bcrypt for higher load, or implement argon2 as future alternative

**express@^5.2.1:**
- Risk: Major version, potential breaking changes in minor updates
- Impact: Dependency updates could break API
- Migration plan: Pin to ^5.0.0, test thoroughly before minor version updates

## Missing Critical Features

**No Request/Response Logging:**
- Problem: No structured logging of API calls, only error logging via console.error
- Blocks: Cannot audit who accessed what, debug production issues, analyze usage patterns
- Fix: Implement Morgan or Pino middleware with request ID propagation, log all requests with method/path/status/duration

**No Database Transaction Support:**
- Problem: Firestore batch writes used but no transaction pattern for multi-step operations
- Blocks: Race conditions in concurrent bookings, money transfers, refunds
- Fix: Create helper for transactional operations, use Firestore transactions for multi-document updates

**No Graceful Shutdown:**
- Problem: Server.listen() has no cleanup on SIGTERM/SIGINT
- Blocks: In-flight requests lost during deployment
- Fix: Add signal handlers to drain existing connections, close Firestore connection, set shutdown timeout

**No Health Check Endpoint:**
- Problem: No `/health` or `/ready` endpoint for load balancer checks
- Blocks: Kubernetes/Cloud Run cannot determine if instance is healthy
- Fix: Add GET /health endpoint that checks database connectivity

**No Database Migration System:**
- Problem: No version control for Firestore schema changes, no migration tool
- Blocks: Schema updates are manual/error-prone, hard to reproduce in test environments
- Fix: Create migration runner tool with version tracking in database

**No Monitoring/Observability Beyond Logs:**
- Problem: No metrics, no tracing, no alerting configured
- Blocks: Cannot detect performance degradation, error rate spikes invisible
- Fix: Integrate Datadog, New Relic, or CloudTrace for APM, set up error rate alerts

## Test Coverage Gaps

**No Route/Integration Tests:**
- What's not tested: All route handlers in `src/routes/` - zero test files for bookings, telegram, public endpoints
- Files: `src/routes/*.js` (52 files, 0 tested)
- Risk: Regressions not caught, API contract changes go unnoticed
- Priority: High - affects all user-facing features

**No Schema Validation Tests:**
- What's not tested: Zod schemas in `src/schemas/` - no tests verify validation rules
- Files: `src/schemas/*.js` (14 schema files)
- Risk: Invalid data accepted, validation logic drifts from intent
- Priority: High - validation is security boundary

**No Authentication Tests:**
- What's not tested: JWT verification, signature verification, Telegram auth middleware
- Files: `src/middleware/authenticate.js`, `src/middleware/telegramAuth.js`
- Risk: Auth bypass undetected, token handling bugs go unnoticed
- Priority: Critical - directly impacts security

**No Business Logic Tests:**
- What's not tested: Availability calculations, booking limits, slot validation, employee scheduling
- Files: `src/utils/bookingLimits.js`, time logic in routes
- Risk: Business logic bugs affect revenue (wrong slots booked, overbooking)
- Priority: Critical - core to product

**No Utils Tests:**
- What's not tested: Encryption, JWT generation/verification, Telegram notifications, SMS sending
- Files: `src/utils/*.js` (encryption, jwt, telegram, eskiz)
- Risk: Silent failures in encryption, token generation
- Priority: High - affects data security and integrations

**No Error Handling Tests:**
- What's not tested: How API handles Firestore errors, network timeouts, invalid input
- Risk: Users see generic 500 errors with no recovery path
- Priority: Medium - affects user experience

---

*Concerns audit: 2026-02-24*
