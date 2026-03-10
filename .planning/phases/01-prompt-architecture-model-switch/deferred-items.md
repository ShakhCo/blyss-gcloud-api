# Deferred Items

## Pre-existing Issues (out of scope, do not fix)

### server.test.js fails without JWT_SECRET env var
- **Discovered during:** Phase 01, Plan 01
- **Issue:** `src/server.test.js` fails with "FATAL: JWT_SECRET environment variable is required" because tests run without env vars set.
- **Status:** Pre-existing — was failing before plan 01-01 changes. Not caused by our changes.
- **Suggested fix:** Add a vitest setup file or `.env.test` that provides `JWT_SECRET=test-secret` for the test environment.
