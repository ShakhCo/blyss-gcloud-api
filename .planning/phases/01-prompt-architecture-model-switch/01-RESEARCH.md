# Phase 1: Prompt Architecture & Model Switch - Research

**Researched:** 2026-03-10
**Domain:** OpenAI API migration, prompt engineering, Node.js async optimization
**Confidence:** HIGH

## Summary

Phase 1 is a focused rewrite of `src/routes/instagram-webhook.js`. The current code uses `openai.responses.create()` with `o4-mini` (reasoning model), inlines the system prompt as string concatenation inside `handleCommentEvent`, runs 7-8 sequential Firestore reads in `buildBusinessInfo`, and spams the booking link on every reply regardless of comment intent.

The goal is to (1) switch to `openai.chat.completions.create()` with `gpt-4.1-mini` at `temperature: 0.9`, (2) extract prompt construction into a dedicated `buildSystemPrompt(options)` function with well-defined sections, (3) parallelize Firestore reads with `Promise.all`, and (4) rewrite the reply rules so the persona is warm and human — booking link only on booking-intent comments, @username used naturally, reply length proportional to comment length, and emoji usage mirroring the commenter.

**Primary recommendation:** Single-file change. Modify only `src/routes/instagram-webhook.js`. The API client, auth, webhook routing, and Telegram notification logic are all correct and unchanged. Concentrate effort on `buildSystemPrompt()` and `buildBusinessInfo()`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**AI Persona Voice**
- Solo businesses (`is_solo` field on business): speak as the owner — "I" voice ("Sizni kutaman", "Raxmat!")
- Team businesses: speak as the business/social media person — "We" voice ("Sizni kutamiz", brand voice)
- Tone driven by `ai_instructions` field when present
- Default tone (when `ai_instructions` is empty): warm & balanced — friendly but not too casual, works for any business type
- No slang by default; businesses can opt into casual tone via `ai_instructions`

**Uzbek Script Handling**
- Match commenter's script: if they write in Cyrillic Uzbek, reply in Cyrillic; Latin gets Latin
- Russian comments get Russian replies (existing behavior, keep)

**Booking Link Rules**
- Booking link appears ONLY on booking-intent or location questions
- Booking intent: comments asking about booking, price, hours, availability
- Location questions: include maps link (already in `buildBusinessInfo`) + booking link
- All other comments (praise, emoji, greetings, reactions): NO booking link
- Negative comments: NO booking link, invite DM for resolution

**Default Example Replies**
- Provide 3-5 built-in example replies per language (uz/ru) baked into the prompt
- These serve as style anchors when `ai_example_replies` is empty (most businesses)
- When `ai_example_replies` is populated, use those instead of defaults
- Examples should demonstrate the warm & balanced default tone

**Reply Tone by Post Type**
- Claude's discretion on whether to include basic caption awareness in Phase 1 or defer entirely to Phase 3

### Claude's Discretion
- Exact default example reply text per language
- Whether to include basic post caption awareness in Phase 1 prompt
- Loading skeleton / progress for prompt extraction refactor
- Exact emoji usage rules within the 2-emoji cap
- How to structure the layered prompt sections internally

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFR-01 | AI model switched from o4-mini (reasoning) to gpt-4.1-mini (chat completions) with temperature 0.9 | API call signature change documented below; gpt-4.1-mini confirmed available in OpenAI SDK v6 |
| INFR-02 | Prompt construction extracted into a dedicated `buildSystemPrompt()` function with layered sections | Current inline prompt identified at lines 230-292; extraction pattern documented below |
| INFR-03 | `buildBusinessInfo()` Firestore reads parallelized with Promise.all instead of sequential awaits | Sequential awaits identified at lines 381-421; Promise.all pattern documented below |
| TONE-01 | AI replies use a persona-first prompt — warm, playful, confident voice instead of corporate booking funnel | Current prompt analyzed; new prompt structure with persona section designed |
| TONE-02 | Booking link only included when commenter asks about booking, price, or availability | Current code always includes booking link (lines 262-271); intent-detection rules documented |
| TONE-03 | Emoji-only comments get witty one-liner replies, not booking pushes | Current code sends booking link on emoji comments (line 265-268); fix in TONE-02 rules |
| TONE-04 | Negative comments get empathetic acknowledgment and DM invitation, not canned deflection with booking link | Current code appends booking link to negative reply (line 270-272); fix documented |
| TONE-05 | Reply length matches comment length — short comments (≤3 words) get ≤1 sentence replies | Prompt rule needed; no current length-matching logic exists |
| TONE-06 | Emoji usage mirrors commenter's energy level and style, capped at 2 per reply | Current rule is flat "1-2 emojis max" with no mirroring; upgraded rule documented |
| PERS-01 | AI uses @username naturally in replies — once, where a human would place it | `commentData.from.username` is available but never injected into prompt (confirmed line 325 — only used in admin log) |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| openai (Node SDK) | 6.17.0 (already installed) | OpenAI API client | Already in codebase |
| `chat.completions.create()` | API v1 | Chat completions endpoint | Required for gpt-4.1-mini; replaces `responses.create()` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Promise.all | Node built-in | Parallel async execution | Parallelizing Firestore reads in `buildBusinessInfo` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| gpt-4.1-mini | gpt-4o-mini | gpt-4o-mini is already used in `src/routes/ai.js` as a known fallback; gpt-4.1-mini is the decided choice |

**No new packages to install.** The OpenAI SDK version already installed (6.17.0) supports `chat.completions.create()`.

## Architecture Patterns

### Files Changed
```
src/routes/instagram-webhook.js   ← only file modified
  ├── buildSystemPrompt(options)  ← new function (extracted from inline code)
  ├── buildBusinessInfo(...)      ← refactored (Promise.all parallelization)
  └── handleCommentEvent(...)     ← updated (model switch, passes username to prompt builder)
```

### Pattern 1: API Call Switch (INFR-01)

**What:** Replace `openai.responses.create()` with `openai.chat.completions.create()`

**Current code (lines 294-302):**
```javascript
const aiResponse = await openai.responses.create({
    model: 'o4-mini',
    reasoning: { effort: 'low' },
    input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: commentText },
    ],
});
replyMessage = (aiResponse.output_text || '').trim();
```

**New code:**
```javascript
const aiResponse = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.9,
    messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: commentText },
    ],
});
replyMessage = (aiResponse.choices[0]?.message?.content || '').trim();
```

Key differences:
- `input` → `messages`
- `role: 'developer'` → `role: 'system'`
- `aiResponse.output_text` → `aiResponse.choices[0]?.message?.content`
- Add `temperature: 0.9`
- Remove `reasoning: { effort: 'low' }`

### Pattern 2: `buildSystemPrompt(options)` Extraction (INFR-02)

**What:** Extract inline prompt string-building (lines 230-292) into a pure function

**Signature:**
```javascript
function buildSystemPrompt({
    businessInfo,       // string from buildBusinessInfo()
    isSolo,             // boolean — drives I vs We voice
    bookingLink,        // string — included only in booking-intent rules section
    username,           // string — commenter's @username
    postCaption,        // string — current post caption
    postTime,           // string — post publish time
    postAiInstructions, // string — per-post override (takes priority)
    aiInstructions,     // string — global owner instructions
    aiExampleReplies,   // string — owner-provided examples; if empty, use defaults
    now,                // string — current Tashkent time
})
```

**Layered sections (internal structure — Claude's discretion on exact ordering):**

1. **Identity/role** — who is speaking (I vs We, warm & balanced tone)
2. **Context block** — `businessInfo` + current time + post caption/time
3. **Core rules** — booking link intent detection, @username placement, length/emoji rules
4. **Comment-type routing** — booking-intent, emoji/praise, negative, spam/SKIP
5. **Example replies** — owner's examples or built-in defaults
6. **Owner overrides** — `aiInstructions` appended last (can amend any above rule)

If `postAiInstructions` is set, replace sections 3-6 with the per-post instructions (existing behavior preserved).

### Pattern 3: Promise.all Parallelization (INFR-03)

**What:** Current `buildBusinessInfo` awaits services, then employees, then each employee's services sequentially (7-8 round trips). Parallelize the first two reads.

**Current sequential pattern (lines 381-421):**
```javascript
const servicesSnap = await db.collection(...).get();
// ... process services ...
const employeesSnap = await db.collection(...).get();
// ... loop employees ...
    const empServicesSnap = await db.collection(...).get();  // inside loop — N reads
```

**Refactored pattern:**
```javascript
const [servicesSnap, employeesSnap] = await Promise.all([
    db.collection('businesses').doc(businessId).collection('services')
        .where('is_active', '==', true).get(),
    db.collection('businesses').doc(businessId).collection('employees')
        .where('is_accepted', '==', true).get(),
]);

// Employee service reads: still inside loop but can be collected and Promise.all'd
const empServiceSnaps = await Promise.all(
    employeesSnap.docs.map(empDoc =>
        db.collection('businesses').doc(businessId)
            .collection('employees').doc(empDoc.id)
            .collection('employeeServices').where('is_active', '==', true).get()
    )
);
```

This reduces minimum Firestore round trips from 2+N (sequential) to 2 (parallel pair) + 1 (all employee service reads in parallel).

### Pattern 4: Booking Intent Detection (TONE-02)

Implement as prompt rules, not code classification. The model itself determines intent from the comment text. The prompt enumerates what counts as booking intent:

```
BOOKING-INTENT comments (price, booking, hours, availability, location, "how much", "qancha", "сколько", "yozilish", "записаться"):
- Answer with specific info from business data.
- Include booking link once, naturally: "Yozilish uchun: {bookingLink}"
- For location questions, also include the map link.

ALL OTHER comments (praise, emoji, greeting, reaction, general curiosity):
- DO NOT include the booking link.
- Reply warmly and naturally.

NEGATIVE comments ("qimmat", "yomon", "плохо", "дорого"):
- Acknowledge with empathy.
- Invite to resolve via DM.
- DO NOT include booking link.

SPAM ("Follow me", "Check my page", promotions from other accounts):
- Return exactly: __SKIP__
```

### Pattern 5: @username Placement (PERS-01)

Pass the commenter's username into the prompt as data, with an instruction on placement:

```
Commenter's username: @{username}

Use @{username} naturally in the reply — once only, placed where a human would naturally
address someone (often at the start for greetings, in the middle for emphasis, or at the
end as a warm sign-off). Never place it mechanically at the very start of every reply.
Do not use it at all if the reply is a one-word reaction or a very short witty response
where inserting a username would feel forced.
```

`commentData.from.username` is confirmed available at line 325 of the existing code (used in admin log but not in the prompt).

### Pattern 6: Reply Length Proportionality (TONE-05)

```
REPLY LENGTH:
- Comment is 1-3 words OR emoji-only: reply in exactly 1 sentence (max ~12 words).
- Comment is 4-10 words: reply in 1-2 sentences.
- Comment is 11+ words or a paragraph: reply in 2-3 sentences max.
Never exceed 3 sentences regardless of comment length.
```

### Pattern 7: Emoji Mirroring (TONE-06)

```
EMOJI USAGE:
- Commenter used no emojis: use 0-1 emoji, only if it genuinely fits.
- Commenter used 1-2 emojis: use 1-2 emojis, mirroring their energy.
- Commenter used 3+ emojis or emoji-only: use 1-2 emojis — enthusiastic but not excessive.
- Cap: never more than 2 emojis per reply.
- Never lead with an emoji as the first character.
```

### Pattern 8: Solo vs Team Voice (TONE-01)

Read `businessData.is_solo` — already available since `businessDoc.data()` is fetched before calling `buildBusinessInfo`. Pass it into `buildSystemPrompt`.

```javascript
const isSolo = businessData.is_solo === true;
```

Prompt identity section:
```
You are replying to Instagram comments on behalf of ${isSolo ? 'the business owner' : 'the business social media team'}.
Voice: ${isSolo ? 'first person singular — "I", "men", "я"' : 'first person plural — "we", "biz", "мы"'}
Tone: warm, confident, and human. Not corporate. Not a bot. Not a booking funnel.
```

### Pattern 9: Default Example Replies (when `ai_example_replies` is empty)

Built-in defaults in Uzbek (Latin) and Russian that demonstrate the warm & balanced default tone. Claude's discretion on exact text — they should feel like real Instagram comments from a barbershop owner, short and natural:

```
EXAMPLE REPLIES (match this style and warmth):
Uzbek:
- "Rahmat, buni bilish yaxshi edi! 😊 Har doim xush kelibsiz."
- "Sizni kutamiz! Menga yozing, joy ajratib qo'yaman."
- "Ha, albatta! Narxlar haqida batafsil so'rashing mumkin."
Russian:
- "Спасибо! Всегда рады видеть вас 😊"
- "Конечно, пишите — всё расскажу и запишу."
- "Рады слышать! Ждём вас."
```

These are anchors for style when the owner hasn't provided their own.

### Anti-Patterns to Avoid

- **Booking link on every reply:** Current behavior. New prompt explicitly forbids it for non-intent comments.
- **Appending booking link at the end of negative replies:** Current behavior at line 270-272. New NEGATIVE rule explicitly excludes it.
- **`role: 'developer'`:** Only valid for the Responses API. Chat Completions uses `role: 'system'`.
- **`aiResponse.output_text`:** Only exists on `responses.create()` response objects. Chat completions uses `choices[0].message.content`.
- **Sequential employee service reads inside a loop:** N round trips for N employees. Collect all promises and `Promise.all` them.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Comment intent classification | Custom keyword parser or NLP | Prompt instruction to the model | The model is better at intent classification than regex; less code, handles all languages |
| Uzbek Cyrillic/Latin detection | Unicode range checks | Prompt instruction: "Match the script the commenter uses" | Model handles this natively; script detection regex is fragile with mixed text |
| Reply length counting | Word count code that truncates output | Prompt rule: "reply in exactly 1 sentence if comment is ≤3 words" | Model follows length instructions reliably; truncating after-the-fact breaks sentences |

**Key insight:** In this domain, prompt instructions are more reliable and maintainable than code-based logic for linguistic tasks. Keep code responsible for data plumbing; keep the model responsible for language judgment.

## Common Pitfalls

### Pitfall 1: Wrong Response Object Shape After Model Switch
**What goes wrong:** Code reads `aiResponse.output_text` after switching to chat completions — returns `undefined`, reply is empty or `__SKIP__` is never triggered.
**Why it happens:** `output_text` is a field on the Responses API object, not on Chat Completions.
**How to avoid:** Use `aiResponse.choices[0]?.message?.content`. Add a guard: if falsy, log and return.
**Warning signs:** Empty replies in the Telegram admin notification after deploy.

### Pitfall 2: `role: 'developer'` Silently Ignored
**What goes wrong:** Passing `role: 'developer'` in `messages[]` to Chat Completions — the API accepts it but may not apply system-level authority correctly across all models.
**How to avoid:** Always use `role: 'system'` for Chat Completions.

### Pitfall 3: Temperature Not Set
**What goes wrong:** Default temperature for chat completions is 1.0 (or model default). Omitting `temperature: 0.9` means the requirement is not met, and output variability may differ from expected.
**How to avoid:** Always include `temperature: 0.9` explicitly in the API call.

### Pitfall 4: `buildBusinessInfo` Inner Loop Still Sequential
**What goes wrong:** Parallelizing only the top-level reads (services + employees) but leaving the `employeeServices` fetch inside a `for...of` loop — still N sequential round trips.
**How to avoid:** Collect all `empServicesSnap` promises into an array first, then `await Promise.all(...)` the whole array. Match results back to employees by index.

### Pitfall 5: `buildSystemPrompt` Receives Stale `bookingLink`
**What goes wrong:** `bookingLink` is an empty string when `tenantUrl` is null. Passing it into prompt sections that say "booking link: " results in "booking link: " with nothing after it.
**How to avoid:** In `buildSystemPrompt`, only include the booking link section/mention when `bookingLink` is truthy. Guard: `if (bookingLink) { ... }`.

### Pitfall 6: Post Caption Time-Reference Warning Lost During Extraction
**What goes wrong:** The current prompt includes a critical instruction (lines 280-281) about not repeating time-relative words from old posts ("ertaga", "bugun"). Forgetting to carry this into `buildSystemPrompt` causes stale date references.
**How to avoid:** This rule must appear in the core rules section of `buildSystemPrompt`. Do not drop it during extraction.

### Pitfall 7: Per-Post Override Path Not Tested
**What goes wrong:** The `postAiInstructions` branch (line 238-250) bypasses global rules. After refactoring to `buildSystemPrompt`, if the per-post path is accidentally merged with the global path, per-post overrides stop working.
**How to avoid:** `buildSystemPrompt` should branch early: if `postAiInstructions` is set, skip sections 3-6 and use per-post instructions only. Test both paths.

## Code Examples

### Chat Completions Call (INFR-01)
```javascript
// Source: OpenAI Node SDK v6, chat.completions.create()
const aiResponse = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.9,
    messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: commentText },
    ],
});
replyMessage = (aiResponse.choices[0]?.message?.content || '').trim();
```

### Promise.all for Parallel Firestore Reads (INFR-03)
```javascript
const [servicesSnap, employeesSnap] = await Promise.all([
    db.collection('businesses').doc(businessId)
        .collection('services').where('is_active', '==', true).get(),
    db.collection('businesses').doc(businessId)
        .collection('employees').where('is_accepted', '==', true).get(),
]);

const empServiceSnaps = await Promise.all(
    employeesSnap.docs.map(empDoc =>
        db.collection('businesses').doc(businessId)
            .collection('employees').doc(empDoc.id)
            .collection('employeeServices').where('is_active', '==', true).get()
    )
);
// empServiceSnaps[i] corresponds to employeesSnap.docs[i]
```

### buildSystemPrompt Skeleton (INFR-02)
```javascript
function buildSystemPrompt({
    businessInfo, isSolo, bookingLink, username,
    postCaption, postTime, postAiInstructions,
    aiInstructions, aiExampleReplies, now,
}) {
    // Section 1: Identity
    const voice = isSolo ? 'I / men / я' : 'we / biz / мы';
    let prompt = `You are replying to Instagram comments on behalf of a ${isSolo ? 'business owner' : 'business'}.
Voice: ${voice}. Tone: warm, human, natural — not corporate, not a bot.
This is a PUBLIC COMMENT SECTION — keep replies short and social.
Today: ${now} (Tashkent, UTC+5)`;

    // Section 2: Business context
    prompt += `\n\n${businessInfo}`;
    if (postCaption) prompt += `\nPost caption: "${postCaption}"`;
    if (postTime) prompt += `\nPost published: ${postTime}`;

    // Section 3+: Per-post override OR global rules
    if (postAiInstructions) {
        prompt += `\n\nINSTRUCTIONS FOR THIS POST:\n${postAiInstructions}`;
        prompt += `\n\nRULES:\n- Max 2 sentences.\n- Match comment language.\n- ≤2 emojis.\n- No hashtags, no self-intro.\n- SPAM: return __SKIP__`;
        return prompt;
    }

    // Section 3: Core rules (booking link, username, length, emoji)
    prompt += `\n\n[BOOKING LINK rules — only on intent comments]`;
    if (username) prompt += `\n\nCommenter: @${username}\nUse @${username} once, naturally placed.`;
    prompt += `\n\n[LENGTH rules]`;
    prompt += `\n\n[EMOJI rules]`;

    // Section 4: Comment type routing
    prompt += `\n\n[BOOKING-INTENT / PRAISE / NEGATIVE / SPAM routing]`;

    // Section 5: Examples
    const examples = aiExampleReplies || DEFAULT_EXAMPLES;
    prompt += `\n\nEXAMPLE REPLIES (match this style):\n${examples}`;

    // Section 6: Owner overrides
    if (aiInstructions) prompt += `\n\nADDITIONAL OWNER INSTRUCTIONS:\n${aiInstructions}`;

    return prompt;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `openai.responses.create()` with `o4-mini` | `openai.chat.completions.create()` with `gpt-4.1-mini` | Phase 1 | Lower cost, deterministic chat format, temperature control |
| Inline string concatenation for system prompt | `buildSystemPrompt()` pure function | Phase 1 | Testable, readable, easier to extend in Phase 2/3 |
| Sequential Firestore reads (7-8 round trips) | Parallel reads via Promise.all | Phase 1 | Reduced latency; all reads complete in ~2 round-trip times instead of 7-8 |
| Booking link on every reply | Booking link only on booking-intent | Phase 1 | Replies feel human; less aggressive push |

## Open Questions

1. **gpt-4.1-mini availability and pricing**
   - What we know: STATE.md flags this as a blocker to verify — "gpt-4.1-mini pricing and availability should be verified before Phase 1 implementation"
   - What's unclear: Whether the model name is exactly `gpt-4.1-mini` in the API or has a different identifier (e.g., `gpt-4.1-mini-2025-07-18`)
   - Recommendation: Check https://platform.openai.com/docs/models before implementation. Fallback: `gpt-4o-mini` (confirmed available; already used in `src/routes/ai.js`).

2. **Uzbek Cyrillic vs Latin detection for script matching**
   - What we know: Decision is to match the commenter's script in the reply
   - What's unclear: Whether passing "match the commenter's script" as a prompt instruction is sufficient or requires detecting the script in code and specifying it explicitly in the prompt
   - Recommendation: Trust the model's script detection first (simpler, no code needed). If testing shows failures, add explicit detection: count Cyrillic Unicode characters in comment text; if >30% of alpha chars are Cyrillic, label it Cyrillic in the prompt.

3. **`__SKIP__` handling after model switch**
   - What we know: Current code checks `if (!replyMessage || replyMessage === '__SKIP__')` and returns
   - What's unclear: Whether `gpt-4.1-mini` follows the `__SKIP__` instruction as reliably as `o4-mini`
   - Recommendation: Keep the existing guard. Consider also checking `replyMessage.includes('__SKIP__')` in case the model wraps it in quotes or adds punctuation.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (confirmed — `npm test` runs vitest per CLAUDE.md) |
| Config file | check for `vitest.config.*` in project root |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFR-01 | `chat.completions.create()` called with `gpt-4.1-mini` + `temperature: 0.9` | unit (mock OpenAI) | `npm test -- --grep INFR-01` | Wave 0 |
| INFR-02 | `buildSystemPrompt()` returns correct sections for each input combination | unit | `npm test -- --grep buildSystemPrompt` | Wave 0 |
| INFR-03 | `buildBusinessInfo()` issues parallel Firestore reads | unit (mock Firestore) | `npm test -- --grep buildBusinessInfo` | Wave 0 |
| TONE-01 | Persona section present in returned prompt; "I" for solo, "we" for team | unit | `npm test -- --grep TONE-01` | Wave 0 |
| TONE-02 | Booking link present when comment is booking-intent; absent for praise | integration (mock OpenAI) | `npm test -- --grep TONE-02` | Wave 0 |
| TONE-03 | Emoji-only comment prompt includes no-booking-link rule for reactions | unit | `npm test -- --grep TONE-03` | Wave 0 |
| TONE-04 | Negative comment prompt includes DM invitation and no booking link | unit | `npm test -- --grep TONE-04` | Wave 0 |
| TONE-05 | Length rules section present in prompt | unit | `npm test -- --grep TONE-05` | Wave 0 |
| TONE-06 | Emoji mirroring rules section present in prompt | unit | `npm test -- --grep TONE-06` | Wave 0 |
| PERS-01 | `@username` injected into prompt when `username` is provided | unit | `npm test -- --grep PERS-01` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/routes/__tests__/instagram-webhook.test.js` — covers all above req IDs; needs Firestore and OpenAI mocks
- [ ] Vitest config and mock setup if not already present in project

## Sources

### Primary (HIGH confidence)
- Existing code: `src/routes/instagram-webhook.js` lines 200-440 — current prompt construction, API call, buildBusinessInfo
- `.planning/phases/01-prompt-architecture-model-switch/01-CONTEXT.md` — locked decisions, code insights
- `.planning/REQUIREMENTS.md` — requirement definitions

### Secondary (MEDIUM confidence)
- OpenAI Node SDK v6 `chat.completions.create()` — standard Chat Completions API; shape of response object is well-established
- `Promise.all` parallelization — standard Node.js async pattern; no version concerns

### Tertiary (LOW confidence)
- gpt-4.1-mini model name and availability — flagged in STATE.md as needing verification; treat as unconfirmed until checked at platform.openai.com

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already installed, API shapes confirmed from existing codebase
- Architecture: HIGH — single-file change, patterns are standard Node.js and OpenAI SDK
- Pitfalls: HIGH — identified directly from reading existing code behavior
- gpt-4.1-mini availability: LOW — explicitly flagged in STATE.md, requires verification

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable domain; OpenAI model availability may change sooner)
