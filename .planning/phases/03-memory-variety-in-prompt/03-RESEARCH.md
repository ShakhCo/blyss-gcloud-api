# Phase 3: Memory & Variety in Prompt - Research

**Researched:** 2026-03-10
**Domain:** Prompt engineering — injecting contextual state into `buildSystemPrompt()` to control AI reply behavior
**Confidence:** HIGH

## Summary

Phase 3 is a pure prompt-engineering phase: no new Firestore reads, no new data structures, no new exports. The `buildSystemPrompt()` function already accepts `commenterHistory` and `postReplies` as parameters (both currently ignored). This phase makes those parameters do real work by inserting four new conditional prompt sections between existing Section 4 (comment-type routing) and Section 5 (example replies).

The four behaviors are tightly scoped: returning-commenter acknowledgment (~1 in 3, only for `comment_count >= 2`), follow-up question nudges (only for returning visitors on qualifying comment types), post-type tone adaptation (via keyword heuristics on `postCaption`, no extra API calls), and reply deduplication (last-5 `recent_replies` injected as negative examples). All four behaviors are conditional — they add prompt sections only when their data is present, following the exact `if (username)` conditional pattern already established in the codebase.

The single change surface is `buildSystemPrompt()` in `instagram-webhook.js`. No caller changes needed — the call site already passes `commenterHistory` and `postReplies`. Tests for Phase 3 follow the same `describe` / `it` pattern as the 78 existing tests, verifying prompt string content with `expect(prompt).toMatch(...)` and `expect(prompt).toContain(...)`.

**Primary recommendation:** Add four conditional `if` blocks inside the `else` branch of `buildSystemPrompt()` (the global rules path), between Section 4 and Section 5. Each block appends a labeled prompt section only when its data is non-null / threshold is met. Write RED tests first, then make them pass.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Returning Commenter Recognition (PERS-03)**
- Threshold: `comment_count >= 2` triggers returning-commenter path
- Include actual `comment_count` and `first_seen_at` in prompt — AI calibrates warmth (2-3: casual nod, 4+: warmer)
- Acknowledge return subtly, ~1 in 3 replies — not every time (gets robotic)
- Do NOT quote their `last_comment_text` — just recognize their return ("glad to see you again")
- First-timers (null commenterHistory or count < 2): standard warm reply, no special treatment

**Follow-up Question Behavior (PERS-04)**
- Trigger on: genuine praise, curiosity comments, experience sharing — but ONLY for returning visitors (comment_count >= 2)
- First-timers never get follow-up questions — keep it simple for new faces
- Question style: service-related — naturally leads to exploring the business ("Qaysi uslubni yoqtirasiz?", "Sizga ham sinab ko'rmoqchimisiz?")
- Not every qualifying comment gets a question — AI's discretion on when it feels natural

**Post Type Classification (QUAL-03, QUAL-04)**
- Classification via prompt-based heuristics — no code logic, no separate API call
- AI self-classifies from caption keywords:
  - Promo: aksiya, chegirma, discount, sale, skidka
  - Before/after: oldin/keyin, result, natija, transformation
  - Milestone: anniversary, yil, oy, 1000, congratulations
  - General: everything else
- Tone adaptation per type:
  - Promo → urgency language ("Hozir band bo'ling!")
  - Before/after → celebrate transformation ("Zo'r natija!")
  - Milestone → celebratory ("Tabriklaymiz!")
  - General → standard warm persona

**Reply Deduplication (QUAL-01, QUAL-02)**
- Inject last 5 recent reply texts from `postReplies.recent_replies` as negative examples in prompt
- Full reply text, not just openers — gives AI style context for broader variety
- Explicit instruction: "Do NOT start your reply with the same word as any of these"
- When `postReplies` is null (no prior replies on this post): skip section entirely

### Claude's Discretion
- Exact prompt section wording and placement within `buildSystemPrompt()`
- How to format the recent replies list (numbered, bulleted, etc.)
- Whether to include post type classification as a separate section or inline with existing routing rules
- Balance between follow-up question frequency and natural conversation flow

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PERS-03 | AI acknowledges returning commenters differently from first-timers ("Glad you're back!" vs generic) | `commenterHistory.comment_count >= 2` is the gate; `first_seen_at` provides tenure context. Conditional prompt section appended only when threshold met. |
| PERS-04 | AI asks engaging follow-up questions on genuine praise and curiosity comments to spark conversation | Gated on `comment_count >= 2` AND comment type matching praise/curiosity/experience. AI uses discretion on frequency. Section appended only for returning visitors. |
| QUAL-01 | No two consecutive replies on the same post start with the same word or pattern | Enforced via explicit prompt instruction alongside injected recent reply texts. |
| QUAL-02 | Recent replies per post are tracked in memory and injected as negative examples in the prompt | `postReplies.recent_replies` (up to last 5) injected as negative examples. Section omitted when `postReplies` is null. |
| QUAL-03 | Post type is classified from caption (promo, before/after, new_service, milestone, general) | `postCaption` already in prompt (Section 2). AI self-classifies using keyword list. No extra API call. |
| QUAL-04 | AI adapts reply style to post type — celebration for milestones, aspiration for before/after, urgency for promos | Tone-per-type mapping included in post-type section wording. |
</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | ^4.0.16 | Test framework | Already in devDependencies; all 78 existing tests use it |
| Node.js ESM | — | Module system | `"type": "module"` in package.json; all imports use ESM |

No new library installations required. Phase 3 is prompt string construction and test additions only.

**Installation:**
```bash
# No new dependencies — all changes are in existing files
```

## Architecture Patterns

### The Established `buildSystemPrompt()` Section Pattern

Sections are appended to `systemPrompt` via `systemPrompt += ...` string concatenation inside `buildSystemPrompt()`. Conditional sections use the `if (condition)` guard pattern already in use for `username`, `bookingLink`, `aiExampleReplies`, `aiInstructions`, and `postAiInstructions`.

All four new sections belong inside the `else` branch (the global rules path, lines 157–247) of `buildSystemPrompt()`. The `postAiInstructions` path (the per-post override branch, lines 143–156) is intentionally narrower and should NOT receive these new sections — per-post override already handles its own context.

### Placement Within the Else Branch

```
Section 3: Core rules (LANGUAGE, REPLY LENGTH, EMOJI USAGE, @USERNAME PLACEMENT)
Section 4: Comment-type routing (BOOKING-INTENT, REACTIONS, NEGATIVE, SPAM)
   ↓
[NEW] Section 4.5a: RETURNING COMMENTER (PERS-03) — if commenterHistory?.comment_count >= 2
[NEW] Section 4.5b: FOLLOW-UP QUESTION (PERS-04) — if commenterHistory?.comment_count >= 2
[NEW] Section 4.5c: POST TYPE TONE (QUAL-03, QUAL-04) — always (postCaption already present)
[NEW] Section 4.5d: REPLY VARIETY (QUAL-01, QUAL-02) — if postReplies?.recent_replies?.length > 0
   ↓
Section 5: Example replies (EXAMPLE REPLIES)
Section 6: Owner overrides (ADDITIONAL OWNER INSTRUCTIONS)
```

**Why after Section 4, before Section 5:** The comment-type routing rules in Section 4 set the behavioral frame (BOOKING-INTENT, REACTIONS, etc.). The new sections refine that frame with commenter context and post context. Example replies in Section 5 anchor tone. Owner overrides in Section 6 always have last say.

### Pattern: Conditional Section Append

```javascript
// Established pattern (from @USERNAME PLACEMENT — line 187):
if (username) {
    systemPrompt += `\n\n@USERNAME PLACEMENT:\n...`;
}

// New sections follow the same pattern:
if (commenterHistory && commenterHistory.comment_count >= 2) {
    systemPrompt += `\n\nRETURNING COMMENTER:\n...`;
}

if (postReplies && postReplies.recent_replies && postReplies.recent_replies.length > 0) {
    systemPrompt += `\n\nRECENT REPLIES ON THIS POST — DO NOT REPEAT:\n...`;
}
```

### Pattern: Uppercase Section Headers

All existing section headers use uppercase: `LANGUAGE AND SCRIPT:`, `REPLY LENGTH:`, `EMOJI USAGE:`, `@USERNAME PLACEMENT:`, `BOOKING-INTENT`, `REACTIONS / EMOJIS / PRAISE`, `NEGATIVE COMMENTS`, `EXAMPLE REPLIES`, `ADDITIONAL OWNER INSTRUCTIONS`. New sections must follow this convention.

Suggested headers:
- `RETURNING COMMENTER:` — for PERS-03/PERS-04 block
- `POST TYPE:` — for QUAL-03/QUAL-04 block
- `RECENT REPLIES ON THIS POST — DO NOT REPEAT:` — for QUAL-01/QUAL-02 block

### Pattern: Injecting Commenter Data Into Prompt

The `commenterHistory` object shape (from Phase 2):
```javascript
{
    username: string,
    comment_count: number,       // how many times they've commented
    first_seen_at: Timestamp,    // Firestore Timestamp
    last_seen_at: Timestamp,
    last_comment_text: string,   // DO NOT include in prompt per locked decision
    expires_at: Timestamp,
}
```

The `first_seen_at` Timestamp needs `.toDate()` to get a JS Date, then format for readability. Or pass the count + a relative description ("first commented 2 months ago") — either approach works since the AI does the interpretation. Simplest: pass the count and let the AI calibrate warmth level.

### Pattern: Injecting Recent Replies as Negative Examples

`postReplies.recent_replies` is an array of `{ text: string, at: Timestamp }`. Only the `text` field is needed. Take up to 5, format as a numbered list.

```javascript
const recentTexts = postReplies.recent_replies
    .slice(0, 5)
    .map((r, i) => `${i + 1}. "${r.text}"`)
    .join('\n');
systemPrompt += `\n\nRECENT REPLIES ON THIS POST — DO NOT REPEAT:\n${recentTexts}\nDo NOT start your reply with the same word as any reply above. Vary your phrasing.`;
```

### Anti-Patterns to Avoid

- **Adding sections to the `postAiInstructions` branch:** The per-post override path is intentionally a stripped-down rule set. Commenter memory and post-type classification would conflict with owner custom instructions. Only the `else` (global) branch gets new sections.
- **Calling `.toDate()` on `first_seen_at` without null guard:** The Timestamp object may be absent in older records or test data. Guard: `commenterHistory.first_seen_at?.toDate?.()`.
- **Asserting `comment_count > 1` instead of `>= 2`:** The locked decision is `comment_count >= 2`. These are identical mathematically but use `>= 2` for readability matching the spec.
- **Making post type classification conditional on postCaption length:** `postCaption` may be empty (caption not fetched, or post has no caption). The post-type section should emit "General" default tone guidance even when caption is blank — or skip the section entirely when `!postCaption`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Post type detection | A regex classifier in JS code, or a second OpenAI call | Keyword list in prompt, AI self-classifies | Locked decision: no code logic, no separate API call; existing `postCaption` already in Section 2 |
| Reply deduplication | JS string comparison logic | Prompt negative examples instruction | AI handles variety via instruction; no algorithmic dedup needed |
| Commenter tenure calculation | Date arithmetic to produce "X days ago" string | Pass `comment_count` directly | AI calibrates warmth from count; date math is unnecessary complexity |
| New Firestore reads | Any `db.collection().get()` in this phase | Use `commenterHistory` and `postReplies` already fetched | Phase boundary: reads happen in Phase 2 call site, already passed to `buildSystemPrompt()` |

**Key insight:** The "intelligence" is entirely in the AI model. The job of `buildSystemPrompt()` is to give the model the right context strings — not to implement business logic in JavaScript.

## Common Pitfalls

### Pitfall 1: Breaking the Identical-Output Guarantee for Null Inputs

**What goes wrong:** The existing test at line 868–876 asserts that `buildSystemPrompt()` output is identical when `commenterHistory` and `postReplies` are `null` vs omitted. A new section that runs even when data is null will break this test.

**Why it happens:** Forgetting to gate new sections behind `if (commenterHistory && ...)` guards.

**How to avoid:** Every new section must be strictly conditional. The null-input test will catch any regression.

**Warning signs:** The test `output is identical when commenterHistory and postReplies are null vs omitted` starts failing.

### Pitfall 2: Modifying the `postAiInstructions` Branch

**What goes wrong:** Adding commenter history or post type sections to the per-post override path (lines 143–156) causes AI to receive contradictory instructions when post-level overrides are set.

**Why it happens:** Not noticing the `if (postAiInstructions) { ... } else { ... }` structure.

**How to avoid:** All four new sections go inside the `else` block only.

**Warning signs:** Tests checking `postAiInstructions` path (`it('does not include global comment-type routing when postAiInstructions is set')`) begin matching patterns they shouldn't.

### Pitfall 3: New Tests That Test the AI's Judgment

**What goes wrong:** Writing tests like "when comment_count is 5 and comment is praise, reply MUST contain a follow-up question" — this tests whether the AI complied with a prompt instruction, which can't be done in unit tests.

**Why it happens:** Confusing prompt content tests (what we can verify) with AI output tests (what we cannot verify in unit tests).

**How to avoid:** Unit tests only verify that `buildSystemPrompt()` CONTAINS the right instruction text. Behavioral verification (did the AI actually ask a question?) belongs in manual QA or integration tests with real AI calls.

**Correct test shape:**
```javascript
// GOOD: tests prompt content
it('PERS-03: prompt contains returning commenter section when comment_count >= 2', () => {
    const prompt = buildSystemPrompt({ ...baseArgs, commenterHistory: { comment_count: 3 } });
    expect(prompt).toMatch(/RETURNING COMMENTER|returning.*commenter|glad.*back/i);
});

// BAD: tests AI compliance (untestable in unit tests)
it('PERS-03: AI reply says "glad you\'re back" for returning commenter', () => { ... });
```

### Pitfall 4: Timestamp Access on Plain Objects in Tests

**What goes wrong:** If test fixtures provide `commenterHistory` with a plain JS `Date` for `first_seen_at` instead of a Firestore Timestamp mock, code that calls `.toDate()` will throw.

**Why it happens:** Tests use `makeTimestamp(date)` helper for mocks (present in test file at line 703), but new test cases may forget to wrap dates.

**How to avoid:** If `first_seen_at` is used in the prompt construction, guard with `?.toDate?.()`. Better: only use `comment_count` in the prompt (no date formatting needed), which sidesteps the Timestamp issue entirely.

### Pitfall 5: Recent Reply List Exceeding Useful Length

**What goes wrong:** Injecting all `recent_replies` without slicing to 5 bloats the prompt unnecessarily, especially as a post accumulates many replies over time.

**Why it happens:** `postReplies.recent_replies` is an array with no enforced max at the read layer (Phase 2 stores whatever the AI replied). The cap must be applied at injection time.

**How to avoid:** Always `slice(0, 5)` before building the numbered list. The locked decision specifies "last 5".

## Code Examples

Verified patterns from the existing codebase:

### Conditional Section Append (established pattern)
```javascript
// Source: instagram-webhook.js line 187
if (username) {
    systemPrompt += `\n\n@USERNAME PLACEMENT:\nCommenter's username: @${username}\n...`;
}
```

### New: Returning Commenter Section (PERS-03 + PERS-04)
```javascript
// Place between Section 4 and Section 5
if (commenterHistory && commenterHistory.comment_count >= 2) {
    const count = commenterHistory.comment_count;
    const warmthHint = count >= 4
        ? 'They are a loyal regular — be noticeably warm.'
        : 'They have commented before — a subtle nod is enough.';
    systemPrompt += `\n\nRETURNING COMMENTER:
This person has commented ${count} time${count !== 1 ? 's' : ''} before.
${warmthHint}
About 1 in 3 times, briefly acknowledge their return ("Yana keldingiz!", "Sog'indik sizni!" or equivalent). Not every reply — keep it natural, not programmatic.
Do NOT quote or reference their previous comment text.

If their comment expresses genuine praise, curiosity, or experience-sharing, consider ending with a service-related question ("Qaysi uslubni yoqtirasiz?", "Sizga ham sinab ko'rmoqchimisiz?" or equivalent). Use your judgment — only when it feels conversational.`;
}
```

### New: Post Type Tone Section (QUAL-03 + QUAL-04)
```javascript
// Only when postCaption is available (it's already in Section 2, so this is always present if caption exists)
if (postCaption) {
    systemPrompt += `\n\nPOST TYPE:
Determine the post type from the caption keywords and adapt your reply tone:
- PROMO (aksiya, chegirma, discount, sale, skidka): use urgency language ("Hozir band bo'ling!", "Taklifdan foydalaning!")
- BEFORE/AFTER (oldin/keyin, result, natija, transformation): celebrate the transformation ("Zo'r natija!", "Ajoyib o'zgarish!")
- MILESTONE (anniversary, yil, oy, 1000, congratulations, yubileya): celebratory and proud ("Tabriklaymiz!", "Katta yutuq!")
- GENERAL (everything else): standard warm persona — no special tone shift needed.`;
}
```

### New: Reply Variety Section (QUAL-01 + QUAL-02)
```javascript
if (postReplies && postReplies.recent_replies && postReplies.recent_replies.length > 0) {
    const recentTexts = postReplies.recent_replies
        .slice(0, 5)
        .map((r, i) => `${i + 1}. "${r.text}"`)
        .join('\n');
    systemPrompt += `\n\nRECENT REPLIES ON THIS POST — DO NOT REPEAT:\n${recentTexts}\nDo NOT start your reply with the same word as any reply above. Vary your opening and phrasing.`;
}
```

### Test Pattern for New Sections (following existing test conventions)
```javascript
// Source pattern: instagram-webhook.test.js lines 250-270
describe('PERS-03: returning commenter acknowledgment', () => {
    const baseArgs = { /* ... */ commenterHistory: null, postReplies: null };

    it('PERS-03: prompt contains returning commenter section when comment_count >= 2', () => {
        const prompt = buildSystemPrompt({
            ...baseArgs,
            commenterHistory: { comment_count: 3 }
        });
        expect(prompt).toMatch(/RETURNING COMMENTER|returning.*commenter/i);
    });

    it('PERS-03: omits returning commenter section when commenterHistory is null', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, commenterHistory: null });
        expect(prompt).not.toMatch(/RETURNING COMMENTER/i);
    });

    it('PERS-03: omits returning commenter section when comment_count < 2 (first-timer)', () => {
        const prompt = buildSystemPrompt({
            ...baseArgs,
            commenterHistory: { comment_count: 1 }
        });
        expect(prompt).not.toMatch(/RETURNING COMMENTER/i);
    });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `commenterHistory` and `postReplies` passed but ignored | Active use in prompt construction | Phase 3 (now) | Parameters start driving prompt content |
| Prompt output identical for all users on same post | Prompt varies by commenter history and post reply state | Phase 3 (now) | More personalized, less repetitive replies |
| Post type handled generically | Post-type tone hints in prompt | Phase 3 (now) | AI adapts reply voice to post context |

**Deprecated/outdated:**
- The test at line 878–899 ("output is identical when commenterHistory and postReplies have data (params ignored in Phase 2)") will need to be REPLACED in Phase 3 — it asserts the exact opposite of what Phase 3 implements. The planner must include a task to update this test.

## Open Questions

1. **`first_seen_at` formatting in prompt**
   - What we know: `first_seen_at` is a Firestore Timestamp in real data, but tests use `makeTimestamp()` mock
   - What's unclear: Whether the prompt should include a human-readable tenure string (e.g., "first commented 2 months ago") or just the count
   - Recommendation: Use only `comment_count` in the prompt. Skip date formatting entirely — it avoids Timestamp handling complexity and the AI calibrates warmth from count alone per the locked decisions.

2. **Post type section when `postCaption` is empty**
   - What we know: `postCaption` is available but may be empty if Instagram API caption fetch fails (line 438 in instagram-webhook.js)
   - What's unclear: Whether to emit "General" default when caption is empty or skip the section
   - Recommendation: Gate the post-type section on `if (postCaption)`. When caption is empty, skip it entirely — AI already defaults to warm/standard behavior without the section.

3. **Interaction between PERS-04 and existing REACTIONS routing**
   - What we know: REACTIONS routing (Section 4) handles "praise" type comments; PERS-04 adds follow-up questions for returning commenters on praise
   - What's unclear: Whether the new PERS-04 instruction could override or conflict with the REACTIONS "witty one-liner" instruction
   - Recommendation: Frame the PERS-04 instruction as "consider ending with a question" (not "always end with a question"). This leaves room for the REACTIONS section's "witty one-liner" instruction to also apply — the AI blends both. Include this in the prompt wording.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.16 |
| Config file | none — `"test": "vitest run"` in package.json scripts |
| Quick run command | `npm test` (from `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api`) |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PERS-03 | `buildSystemPrompt()` includes RETURNING COMMENTER section when `comment_count >= 2` | unit | `npm test` | ❌ Wave 0 |
| PERS-03 | `buildSystemPrompt()` omits RETURNING COMMENTER section when `commenterHistory` is null or `count < 2` | unit | `npm test` | ❌ Wave 0 |
| PERS-03 | Prompt includes `comment_count` value and calibrated warmth hint | unit | `npm test` | ❌ Wave 0 |
| PERS-04 | RETURNING COMMENTER section includes follow-up question guidance for returning visitors | unit | `npm test` | ❌ Wave 0 |
| PERS-04 | Follow-up question section omitted when `commenterHistory` is null (first-timers never get it) | unit | `npm test` | ❌ Wave 0 |
| QUAL-01 | RECENT REPLIES section includes explicit "Do NOT start with the same word" instruction | unit | `npm test` | ❌ Wave 0 |
| QUAL-02 | RECENT REPLIES section includes injected reply texts when `postReplies.recent_replies` is non-empty | unit | `npm test` | ❌ Wave 0 |
| QUAL-02 | RECENT REPLIES section omitted when `postReplies` is null | unit | `npm test` | ❌ Wave 0 |
| QUAL-02 | At most 5 recent replies injected (slice guard) | unit | `npm test` | ❌ Wave 0 |
| QUAL-03 | POST TYPE section present when `postCaption` is non-empty | unit | `npm test` | ❌ Wave 0 |
| QUAL-03 | POST TYPE section includes promo/before-after/milestone/general classification keywords | unit | `npm test` | ❌ Wave 0 |
| QUAL-04 | POST TYPE section includes urgency language for promo, celebratory for milestone, transformation for before/after | unit | `npm test` | ❌ Wave 0 |
| PERS-03 regression | Null inputs still produce identical output to baseline (null-guard correctness) | unit | `npm test` | ✅ exists (line 868) — must be UPDATED |

**Important:** The existing test "output is identical when commenterHistory and postReplies have data (params ignored in Phase 2)" (line 878) MUST be removed or updated — it asserts Phase 2 behavior that Phase 3 intentionally breaks.

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] New `describe` blocks in `instagram-webhook.test.js` for PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04
- [ ] Update/remove the Phase 2 "params ignored" test (line 878) that asserts opposite of Phase 3 behavior

*(No new test files or framework installs needed — existing test infrastructure in `instagram-webhook.test.js` covers all phase requirements via new `describe` blocks)*

## Sources

### Primary (HIGH confidence)
- Direct code read: `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/src/routes/instagram-webhook.js` — full `buildSystemPrompt()` implementation, established section patterns, conditional guards, parameter signatures
- Direct code read: `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/src/routes/instagram-webhook.test.js` — 78 existing tests, test patterns, `baseArgs` shape, docSnapOverrides mock infrastructure
- Direct code read: `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/.planning/phases/03-memory-variety-in-prompt/03-CONTEXT.md` — all locked decisions, implementation constraints, code insights
- Direct code read: `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/.planning/REQUIREMENTS.md` — PERS-03, PERS-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04 definitions

### Secondary (MEDIUM confidence)
- `/Users/shahzod/Projects/BLYSS/blyss-gcloud-api/.planning/STATE.md` — Phase 2/3 boundary decisions, accumulated context

### Tertiary (LOW confidence)
- None — all findings derive from direct code reads, no web searches required

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; existing vitest + Node ESM confirmed in package.json
- Architecture: HIGH — `buildSystemPrompt()` fully read; insertion point, conditional pattern, and section conventions all directly observed in source
- Pitfalls: HIGH — derived from reading existing tests (the Phase 2 "params ignored" test is a concrete, identifiable regression risk) and code structure
- Test map: HIGH — existing test file read in full; all test patterns directly observed

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable — no external dependencies to go stale)
