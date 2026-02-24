# Testing Patterns

**Analysis Date:** 2026-02-24

## Test Framework

**Runner:**
- Vitest 4.0.16
- Config: Not explicitly configured (no vitest.config.js found - uses defaults)
- ES Modules support enabled via `"type": "module"` in package.json

**Assertion Library:**
- Vitest built-in expect (imported from vitest)

**Run Commands:**
```bash
npm test              # Run all tests (vitest run)
npm run dev           # Development with auto-reload (uses nodemon, not watch mode)
```

**Package Dependencies:**
- `vitest@^4.0.16` - Test runner
- `supertest@^7.1.4` - HTTP assertion library for testing Express apps

## Test File Organization

**Location:**
- Co-located with source code (same directory as tested module)
- Test file located: `src/server.test.js` - tests the Express server setup

**Naming:**
- `.test.js` suffix: `server.test.js`
- Tests organized by feature/module (one test file per major module expected)

**Structure:**
```
src/
├── server.js
├── server.test.js
├── routes/
├── middleware/
├── utils/
├── schemas/
├── db/
└── config/
```

## Test Structure

**Suite Organization:**
```javascript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './server.js';

describe('CORS', () => {
    it('allows requests from allowed origin', async () => {
        const res = await request(app)
            .get('/')
            .set('Origin', 'https://barbershop-miniapp-beta.automations.uz');

        expect(res.headers['access-control-allow-origin']).toBe('https://barbershop-miniapp-beta.automations.uz');
    });

    it('handles preflight requests', async () => {
        const res = await request(app)
            .options('/users/register')
            .set('Origin', 'https://barbershop-miniapp-beta.automations.uz')
            .set('Access-Control-Request-Method', 'POST');

        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe('https://barbershop-miniapp-beta.automations.uz');
        expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
});

describe('API', () => {
    it('GET / returns hello world', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toBe('Hello world');
    });

    it('POST /users/register validates input', async () => {
        const res = await request(app)
            .post('/users/register')
            .send({ first_name: 'Test' });

        expect(res.status).toBe(400);
        expect(res.body.validation_errors).toBeDefined();
        expect(res.body.error_code).toBe('VALIDATION_ERROR');
    });
});
```

**Patterns:**
- `describe()` blocks group related tests by concern (CORS, API, endpoints)
- `it()` blocks test specific behaviors with descriptive names
- Async test support via `async () => {}` syntax
- `request(app)` from supertest to test HTTP endpoints
- HTTP method chaining: `.get()`, `.post()`, `.options()`
- Header setting via `.set(name, value)` for Origin, Content-Type, etc.
- Request body via `.send(data)` for POST/PUT/PATCH
- Response assertions on `res.status`, `res.headers`, `res.body`, `res.text`

## HTTP Testing Patterns

**Supertest Usage:**
```javascript
// GET request
const res = await request(app).get('/path');

// POST with body
const res = await request(app)
    .post('/path')
    .send({ field: 'value' });

// Set headers
const res = await request(app)
    .get('/path')
    .set('Authorization', 'Bearer token')
    .set('Content-Type', 'application/json');

// Check response
expect(res.status).toBe(200);
expect(res.body).toHaveProperty('id');
expect(res.body.error_code).toBe('VALIDATION_ERROR');
```

**What is Tested:**
- HTTP status codes
- Response body properties and structure
- Response headers
- Header presence and values
- Error code responses
- Validation error format

## Test Coverage

**Requirements:** Not enforced (no coverage configuration in package.json)

**Current Coverage:**
- Only 1 test file found: `src/server.test.js`
- Tests cover:
  - CORS origin allowlisting (2 tests)
  - CORS preflight handling (1 test)
  - Basic API response (1 test)
  - Input validation (1 test)
- Total: 5 tests across two test suites

**Gaps:**
- No authentication tests (JWT verification, token refresh)
- No signature verification tests (HMAC-SHA256)
- No database tests (Firestore interactions)
- No business logic tests (booking logic, available slots calculation)
- No utility function tests (token generation, SMS sending)
- No middleware tests (validate middleware, authenticate middleware)
- No error case tests (missing required fields, invalid OTP, expired tokens)
- No integration tests between endpoints

**View Coverage:**
Not configured - no coverage tool integrated

## Test Types

**Unit Tests:**
- Not observed in codebase
- Would test individual functions: utility functions, helper functions, validators
- Expected location: `src/utils/*.test.js`, `src/middleware/*.test.js`

**Integration Tests:**
- Partially implemented via `src/server.test.js` using supertest
- Tests HTTP endpoints with real Express server
- Tests middleware stack (CORS, body parsing)
- Tests validation pipeline
- Scope: Request → Middleware → Validation → Response

**E2E Tests:**
- Not implemented (no test files found)
- Would require database setup/teardown and external service mocking
- Would test full user flows: OTP → verification → login → booking

## What is NOT Tested

**Critical Areas Without Tests:**
- Authentication flows: OTP send, OTP verify, login, register
- Signature verification middleware
- JWT token generation and verification
- Database operations (all Firestore queries)
- External service integrations: Eskiz SMS, Telegram API, OpenAI
- Business logic: available slot calculations, booking conflicts, working hours
- Error scenarios: invalid signatures, expired OTPs, rate limiting
- Rate limiting middleware behavior
- Rate limiter configurations: different limits for different endpoints

## Async Testing Pattern

**Pattern Used:**
```javascript
it('test name', async () => {
    const res = await request(app).get('/path');
    expect(res.status).toBe(200);
});
```

- `async/await` used throughout
- No `.then()` chaining observed
- Test function marked as `async`
- Awaits HTTP requests
- Straightforward error propagation (unhandled promise rejections fail test)

## Mocking

**Framework:** Not used - no mocking library configured

**Current Approach:**
- Tests use real Express server instance
- Tests use real CORS configuration
- Tests do NOT mock:
  - Database (Firestore)
  - External services (Eskiz, Telegram, OpenAI)
  - JWT operations
  - Cryptographic functions

**What to Mock (if implemented):**
- Database queries - use in-memory Firestore emulator or stub
- External APIs - Eskiz, Telegram, OpenAI - use jest.mock() or vi.mock()
- Cryptographic operations in unit tests
- Date/time functions for timezone-dependent tests
- Environment variables for different configurations

**What NOT to Mock:**
- Express middleware (test with real middleware)
- Zod validation schemas (test validation behavior)
- Cookie handling
- HTTP headers and status codes

## Fixtures and Test Data

**Test Data:**
- Not implemented - no fixtures or factory functions found
- Test data hardcoded inline:
  ```javascript
  .set('Origin', 'https://barbershop-miniapp-beta.automations.uz')
  .send({ first_name: 'Test' })
  ```

**Recommended Pattern (not yet in use):**
If factories were needed:
```javascript
// Factory for test data
export function createTestUser(overrides = {}) {
    return {
        phone_number: '998901234567',
        first_name: 'Test',
        last_name: 'User',
        ...overrides
    };
}

// In test
const user = createTestUser({ first_name: 'Custom' });
```

**Location:**
- Would live in `src/test/fixtures/` or `src/test/factories/`
- Imported into `.test.js` files as needed

## Current Test Statistics

**Total Tests:** 5
- CORS tests: 3 (origin allowlist, preflight methods, preflight origin)
- API tests: 2 (root endpoint response, validation error response)

**Test File Path:**
- `src/server.test.js` - 43 lines, tests core server setup

**What Next Test Should Cover:**
1. Authentication routes (`src/routes/auth.js`): OTP, verification, login, register
2. Signature verification middleware
3. JWT middleware (authenticate, optionalAuthenticate)
4. Validation middleware with various schema failures
5. Rate limiting behavior

---

*Testing analysis: 2026-02-24*
