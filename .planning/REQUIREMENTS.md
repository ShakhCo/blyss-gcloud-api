# Requirements: BLYSS Instagram DM Booking Automation

**Defined:** 2026-03-22
**Core Value:** Turn Instagram engagement into real bookings — DMs convert to confirmed appointments

## v2.0 Requirements

Requirements for DM booking automation. Each maps to roadmap phases.

### Infrastructure (INFRA)

- [ ] **INFRA-01**: OAuth scope includes `instagram_business_manage_messages` and businesses can re-authorize
- [ ] **INFRA-02**: Webhook receives and routes DM events (`entry.messaging[]`) separately from comment events
- [ ] **INFRA-03**: Bot-sent messages filtered via `is_echo` check to prevent infinite loops
- [ ] **INFRA-04**: `dm_automation_enabled` toggle on `instagram_connection` settings (per-business opt-in)
- [ ] **INFRA-05**: Firestore `dm_conversations` collection with TTL-based expiry for conversation state

### Conversation Flow (FLOW)

- [ ] **FLOW-01**: Any incoming DM from a new conversation triggers language selection (O'zbekcha / Русский)
- [ ] **FLOW-02**: After language selection, user sees main menu with quick-reply buttons (Book, Location, Working Hours, Contact)
- [ ] **FLOW-03**: User can navigate back to main menu from any step in the flow
- [ ] **FLOW-04**: Conversation state persists across messages and resets after 30-minute idle timeout
- [ ] **FLOW-05**: Language preference persists across sessions (returning users skip language selection)
- [ ] **FLOW-06**: All bot messages displayed in the user's selected language (uz/ru)

### Booking Steps (BOOK)

- [ ] **BOOK-01**: User can select one or more services from business's service list via quick-reply buttons
- [ ] **BOOK-02**: Services with 13+ items use carousel/generic template fallback with pagination
- [ ] **BOOK-03**: User can select a date from next 7 available days (shows day names: Today, Tomorrow, Monday...)
- [ ] **BOOK-04**: User can select a time slot from available 15-minute slots for chosen date and services
- [ ] **BOOK-05**: User can select an employee per service or choose "Any available barber"
- [ ] **BOOK-06**: When no slots available for chosen date, system suggests next available date
- [ ] **BOOK-07**: User sees booking summary (services, date, time, employee, total price) before confirming

### Authentication (AUTH)

- [ ] **AUTH-01**: User is prompted for phone number after completing booking selections
- [ ] **AUTH-02**: OTP sent via SMS (Eskiz) and user verifies by typing 6-digit code in DM
- [ ] **AUTH-03**: Returning users (previously verified phone) skip OTP on subsequent bookings
- [ ] **AUTH-04**: OTP has max 3 attempts before session reset with error message

### Booking Creation (CREA)

- [ ] **CREA-01**: Confirmed booking creates a real booking via existing booking infrastructure
- [ ] **CREA-02**: Slot availability re-checked at confirmation time (prevents race conditions with stale data)
- [ ] **CREA-03**: If slot taken at confirmation, user shown error and offered to pick a new time
- [ ] **CREA-04**: Booking confirmation message shows: services, date, time, employee, total price, booking reference
- [ ] **CREA-05**: Business owner receives Telegram notification on DM-originated booking

### Info Responses (INFO)

- [ ] **INFO-01**: "Location" button responds with business address and Google Maps link
- [ ] **INFO-02**: "Working Hours" button responds with formatted daily schedule
- [ ] **INFO-03**: "Contact" button responds with business phone number

## v2.1+ Requirements (Deferred)

### Cancellation

- **CANC-01**: User can cancel an existing booking via DM conversation
- **CANC-02**: User can reschedule an existing booking via DM

### Advanced

- **ADV-01**: Booking reminders sent via SMS (not DM — 24h window restriction)
- **ADV-02**: Employee profile photos in carousel cards (pending Instagram API support)

## Out of Scope

| Feature | Reason |
|---------|--------|
| AI-generated DM responses | Static flow only — AI hallucination risk on appointment data; already serving comment use case |
| Payment collection in DMs | No Instagram DM payment API; PCI scope explosion |
| Free-text parsing at booking steps | NLP complexity for uz/ru date parsing; quick-reply buttons handle this |
| Booking reminders via DM | Instagram 24-hour messaging window makes automated reminders non-compliant |
| Google Calendar sync | Out of scope — separate OAuth complexity for third system |
| Rescheduling via DM | Build after cancellation flow works reliably (v2.1+) |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (populated by roadmapper) | | |

**Coverage:**
- v2.0 requirements: 25 total
- Mapped to phases: 0
- Unmapped: 25

---
*Requirements defined: 2026-03-22*
*Last updated: 2026-03-22 after initial definition*
