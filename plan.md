# Fix Plan: Booking Endpoint Security & Consistency

## Issue 1: User time conflict detection in `src/routes/bookings.js`
**Location:** POST `/public/businesses/:businessId/bookings` (lines 464-628)

After the per-employee slot validation loop (line ~544), add a user-level cross-business conflict check identical to what `telegram.js` already does (lines 1367-1408):
- Compute booking start/end times from `items` array
- Query `bookings` collection where `user_id == req.user.id`, `booking_date == booking_date`, and `status in ['pending','confirmed']`
- For each existing booking, extract overall time range from items and check for overlap
- Return 409 with `USER_TIME_CONFLICT` if overlap found

## Issue 2: User time conflict detection in `src/routes/bot.js`
**Location:** POST `/bot/businesses/:businessId/bookings` (lines 281-633)

After building booking items chain (line ~566), add the same user conflict check:
- Use `userId` (String(telegram_id)), `date`, `start_time` (first item start), `currentTime` (last item end)
- Query and check overlap identically to telegram.js

## Issue 3: Rate limiting on booking creation endpoints
**Files:** `src/routes/bookings.js`, `src/routes/bot.js`, `src/routes/telegram.js`

Add `express-rate-limit` middleware to all three booking POST endpoints:
- Stricter limit for booking creation: **10 requests per 15 minutes per IP**
- Import `rateLimit` from `express-rate-limit` (already a dependency)
- Apply limiter only to the POST booking creation routes, not all routes in those files

## Issue 4: Phone number validation
**File:** `src/schemas/booking.js`

Strengthen phone validation in `createBookingSchema` and `botCreateBookingSchema`:
- Enforce Uzbek phone format: `998XXXXXXXXX` (exactly 12 digits starting with 998)
- This matches the existing validation in `/bot/otp/send` (line 119 of bot.js): `/^998\d{9}$/`

## Files to modify
1. `src/schemas/booking.js` — phone validation
2. `src/routes/bookings.js` — user conflict check + rate limit
3. `src/routes/bot.js` — user conflict check + rate limit
4. `src/routes/telegram.js` — rate limit on POST /bookings
