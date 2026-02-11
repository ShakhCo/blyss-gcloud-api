# Plan: Prevent Fake Bookings (Schedule Hoarding)

## Problem

A single user can book every available slot for an entire day at a barbershop, making the schedule appear completely full and blocking legitimate customers from booking. There are currently **zero per-user booking limits** in the system.

## Current State (Vulnerabilities)

| Gap | Detail |
|-----|--------|
| No per-user booking caps | A user can create unlimited bookings per day for the same business |
| No concurrent booking limit | A user can have unlimited active (future) bookings |
| No booking rate limit | A user can fire off dozens of booking requests in rapid succession |
| No no-show tracking | Repeat offenders face no consequences |
| No cancellation abuse detection | A user can cancel and rebook slots to keep them blocked |
| No deposit/prepayment | Zero financial skin in the game for the booker |

## How Fresha & Booksy Solve This

### Fresha
- **Card on file / Deposits** - Clients must add a payment card or pay a deposit to confirm a booking. Can be targeted to new clients or those with past no-shows.
- **AI fraud detection** - ML-based transaction scoring flags suspicious patterns (99% fraud reduction).
- **No-show fees** - Businesses can charge a percentage of the appointment value.
- **Account requirement** - Anonymous bookings not allowed.

### Booksy
- **Deposits** - Partial or full prepayment required at booking time (min $5).
- **Cancellation fees** - Card on file charged if client cancels late or no-shows.
- **Auto-block repeat offenders** - After N no-shows, the client loses online booking privileges (walk-in only).
- **Trusted client exemption** - Loyal clients skip deposit requirements.
- **Automated reminders** - Reduce no-shows via SMS/push reminders.

### Industry Best Practices
- **Per-customer booking caps** (Zoho, Booknetic, Bookly) - Max N active bookings per user.
- **Advance booking window** - Limit how far ahead users can book (e.g., 14 days).
- **Web form gatekeeper** - Filter duplicate customers by email/IP.

---

## Implementation Plan

### Phase 1: Per-User Booking Limits (Core Fix)

These changes directly prevent the "book the whole day" attack.

#### 1.1 Add business-level configuration fields

**File:** `src/schemas/business.js`

Add new fields to business settings:
```
max_active_bookings_per_user: integer (default: 3)
  - Max active (pending/confirmed) future bookings a single user can have at this business

max_bookings_per_user_per_day: integer (default: 2)
  - Max bookings a single user can make for the same date at this business
```

**File:** `src/routes/businesses.js`

Expose these settings in the business update endpoint so owners can configure them.

#### 1.2 Enforce limits at booking creation time

**File:** `src/routes/bookings.js` (POST `/public/businesses/:businessId/bookings`)

Before creating a booking, add two queries:

1. **Per-day check:** Count this user's active bookings (`status in ['pending', 'confirmed']`) for the same `business_id` + `booking_date`. Reject with 429 if `>= max_bookings_per_user_per_day`.

2. **Total active check:** Count this user's active future bookings (`booking_date >= today`) for the same `business_id`. Reject with 429 if `>= max_active_bookings_per_user`.

#### 1.3 Add a booking-specific rate limiter

**File:** `src/routes/bookings.js` or new middleware

Add a user-level rate limit on the booking creation endpoint:
- Max 5 booking creation attempts per user per 15 minutes
- Keyed by `req.user.user_id` (not IP), so VPN/proxy switching doesn't bypass it

---

### Phase 2: No-Show Tracking & Consequences

#### 2.1 Track no-show count on user profile

**File:** `src/routes/bookings.js` (PATCH status endpoint)

When a business marks a booking as `no_show`:
- Increment a `no_show_count` field on the user document
- Store a `last_no_show_at` timestamp

#### 2.2 Restrict repeat offenders

**File:** `src/routes/bookings.js` (POST create booking)

When creating a booking, check the user's `no_show_count`:
- If `no_show_count >= 3` (configurable per business via `max_no_shows_before_restriction`):
  - Reject online booking with a message like "Please contact the business directly to book"
  - Or reduce their `max_active_bookings_per_user` to 1

---

### Phase 3: Cancellation Abuse Prevention

#### 3.1 Cancellation cooldown

**File:** `src/routes/bookings.js` (POST create booking)

After a user cancels a booking for a specific slot, impose a cooldown:
- The user cannot rebook the *same employee + same time window* within 30 minutes
- This prevents the cancel-and-rebook cycle used to hold slots

#### 3.2 Track cancellation patterns

**File:** `src/routes/bookings.js` (PATCH cancel endpoint)

Track `cancellation_count` on user profile (similar to no-show tracking):
- If a user cancels > 5 bookings in the last 7 days, reduce their booking limits temporarily

---

### Phase 4: Business Owner Controls (Dashboard)

#### 4.1 Configurable settings per business

Expose these to the business owner via API:
- `max_active_bookings_per_user` (default: 3)
- `max_bookings_per_user_per_day` (default: 2)
- `max_no_shows_before_restriction` (default: 3)
- `booking_rate_limit_per_15min` (default: 5)
- `advance_booking_days` (default: 30) - how far ahead users can book

#### 4.2 Manual user blocking

**File:** New endpoint on `src/routes/businesses.js`

- `POST /businesses/:id/blocked-users` - Block a user from booking
- `DELETE /businesses/:id/blocked-users/:userId` - Unblock
- Store as a subcollection `blocked_users` under the business
- Check at booking creation time

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/schemas/business.js` | Add booking limit fields to schema |
| `src/routes/businesses.js` | Allow business owners to update booking limit settings; add block/unblock endpoints |
| `src/routes/bookings.js` | Enforce per-user-per-day limit, total active limit, user rate limit, no-show check, cancellation cooldown, blocked user check |
| `src/schemas/booking.js` | No changes needed (existing schema sufficient) |
| `src/middleware/authenticate.js` | No changes needed |

## Priority Order

1. **Phase 1** (1.1 + 1.2 + 1.3) - This alone stops the "book the entire day" attack
2. **Phase 4.2** (Manual blocking) - Gives business owners an immediate escape hatch
3. **Phase 2** (No-show tracking) - Longer-term abuse deterrent
4. **Phase 3** (Cancellation abuse) - Edge case protection
5. **Phase 4.1** (Configurable settings) - Polish and customization

## Notes

- Deposits/prepayment (Fresha/Booksy's strongest tool) requires a payment integration which is a larger scope item - not included here but recommended as a future phase.
- All limits should use sensible defaults that work without business owner configuration.
- Error messages should be user-friendly and not reveal exact limits to prevent gaming.
