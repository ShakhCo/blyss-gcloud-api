# Technology Stack

**Project:** BLYSS Instagram AI Auto-Reply — Personality & History Milestone
**Researched:** 2026-03-10
**Scope:** Stack additions and changes for human-like replies, comment history, commenter personalization, reply variety

---

## Critical Finding: Model API Mismatch

The current code uses `openai.responses.create()` (the Responses API, new in openai SDK v1+) with
`reasoning: { effort: 'low' }`. This API and the `reasoning` parameter are exclusive to OpenAI's
reasoning models (o-series: o1, o3, o4-mini). Switching to a chat/completion model requires
changing to `openai.chat.completions.create()` and dropping the `reasoning` parameter entirely.
**This is not a config change — it requires code changes to the call site.**

---

## Model Recommendation: Switch from o4-mini to gpt-4.1-mini

### Why o4-mini Is Wrong for This Use Case

o4-mini is a reasoning model. Reasoning models work by generating internal chain-of-thought before
producing output. This is excellent for logic, math, and code. For 1-2 sentence social media
replies that need warmth, wit, and tone-matching, it is the wrong tool:

- Reasoning overhead adds latency (even at `effort: 'low'`). A webhook that must process quickly
  does not need reasoning steps to reply "Rahmat! 😍".
- Reasoning models are trained to be accurate and analytical. The failure mode is outputs that are
  precise but stiff — exactly the "corporate bot" problem described in PROJECT.md.
- `effort: 'low'` reduces cost but also reduces quality, meaning you pay for a reasoning model
  and then partially disable its reasoning. This is the worst of both worlds.

### Why gpt-4.1-mini Is Right

**Confidence: MEDIUM** (based on training knowledge through Aug 2025; gpt-4.1-mini released April
2025, openai SDK 6.x supports it. Verify against OpenAI pricing page before committing.)

gpt-4.1-mini is a chat completion model in the GPT-4.1 family:

- Optimized for natural language fluency and instruction-following, not reasoning tasks
- Lower latency than o4-mini at equivalent quality for creative short-form text
- ~60-80% cheaper per token than o4-mini (pricing varies; verify at platform.openai.com/pricing)
- Supports system/user message structure natively via Chat Completions API
- The `temperature` parameter gives direct control over output variety (o-series reasoning models
  expose no temperature control, only effort levels)
- Context window: 128K tokens — more than sufficient for the business info prompt

**Alternative considered: gpt-4o-mini**

gpt-4o-mini (already in use in `src/routes/ai.js` as `gpt-4o-2024-08-06`) would also work and
costs less than gpt-4.1-mini. However, gpt-4.1-mini has better instruction-following for
personality/tone tasks according to OpenAI's benchmarks at launch. The cost difference is small
given reply volume for a barbershop SaaS. Use gpt-4.1-mini unless cost becomes a constraint.

**Alternative considered: gpt-4.1 (full)**

Not recommended. Overkill for 2-sentence social replies. 5-10x the cost of gpt-4.1-mini with no
meaningful quality advantage for this task.

### API Call Change Required

```javascript
// Current (wrong model type for personality):
const aiResponse = await openai.responses.create({
    model: 'o4-mini',
    reasoning: { effort: 'low' },
    input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: commentText },
    ],
});
const replyMessage = (aiResponse.output_text || '').trim();

// New (chat completions, personality-optimized):
const aiResponse = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.9,    // Higher = more variety, less repetition
    max_tokens: 120,     // Instagram reply limit is 2200 chars, but we want 1-2 sentences
    messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: commentText },
    ],
});
const replyMessage = (aiResponse.choices[0]?.message?.content || '').trim();
```

**Confidence: HIGH** — openai SDK 6.x has `openai.chat.completions.create()`. The parameter
names above are standard Chat Completions API, unchanged since GPT-3.5.

---

## Prompt Engineering: No New Libraries Needed

Prompt engineering is pure text craft — no additional npm packages required. What changes:

### Pattern 1: Persona-First Framing

The current prompt opens with "You are replying to Instagram post comments on behalf of a business."
This frames the AI as a reply-machine. Replace with a persona statement that describes a *person*:

```
You are Kamol, the social media voice of [Business Name] — a witty, warm person who genuinely
loves what the salon does. You write Instagram replies the way a charming friend would, not a
customer service rep.
```

The persona name can be generic ("the social media manager") but giving it a character description
produces measurably more natural output than role-description framing. This is well-established
in prompt engineering practice.

**Confidence: HIGH** — extensively validated in production AI systems.

### Pattern 2: Show, Don't Tell via Few-Shot Examples

The current system already supports `ai_example_replies` per business connection. This is the
right idea. The prompt currently appends them as "EXAMPLE REPLIES (match this style):" at the end
after a wall of rules. Move examples to immediately before the user turn. Models weight recent
context more heavily.

Structural order for maximum effect:
1. Persona statement (who you are)
2. Business context (what business you represent)
3. Post context (what this specific post is about)
4. Comment history (have you spoken to this person before)
5. Recent replies on this post (what you've already said, to avoid repetition)
6. 3-5 few-shot examples (concrete tone samples)
7. Concise rules (what NOT to do, very short)

**Confidence: HIGH** — ordering context close to the generation point is a documented principle
from OpenAI's prompt engineering guide.

### Pattern 3: Temperature for Variety

With gpt-4.1-mini, set `temperature: 0.9` (not the default 1.0, not low). This:
- Prevents the model from always defaulting to its highest-probability next token (repetition)
- Keeps outputs coherent (unlike temperature 1.2+ which produces erratic text)
- Is the primary mechanical control for reply variety — more reliable than prompt instructions
  like "vary your wording"

**Confidence: HIGH** — temperature's effect on output diversity is well-documented.

### Pattern 4: Commenter Name Injection

The commenter username is already available in the webhook payload (`commentData.from.username`).
Currently it is only used in admin notifications, not injected into the AI prompt. Add it:

```javascript
// In the system prompt or as context before the user turn:
systemPrompt += `\nThe commenter's username is @${commenterUsername}.`;
systemPrompt += `\nYou MAY use their @username once if it feels natural — not required.`;
```

The "not required" instruction prevents the model from mechanically opening every reply with
"@username" which is equally robotic.

**Confidence: HIGH** — no new technology, just using already-available data.

---

## Comment History Tracking: New Firestore Collection

### Recommended Schema

A new subcollection under each business's `instagram_connection` document:

```
businesses/{businessId}/instagram_connection/{connectionId}/commenter_history/{username}
```

Document structure:
```json
{
  "username": "john_doe",
  "first_seen": "Timestamp",
  "last_seen": "Timestamp",
  "comment_count": 3,
  "last_comment_text": "Zo'r bo'ldi!",
  "last_reply_text": "Raxmat, @john_doe! Kutamiz sizni 😊",
  "last_media_id": "12345678",
  "is_returning": true
}
```

**Why this schema:**
- Document ID is `username` — O(1) lookup, no query needed
- `comment_count` enables tiered personalization (first-time vs returning vs loyal commenter)
- `last_reply_text` feeds the AI as context ("last time we told them X")
- `is_returning` is a derived boolean — set to `true` after first comment, used as a quick flag
  in the prompt without additional logic

**Confidence: HIGH** — standard Firestore document-per-entity pattern. Path mirrors existing
`instagram_post_settings` pattern in the codebase.

### Index Required

The collection uses document ID lookup (no `.where()` queries needed), so no new composite index
is required. Single-field indexes on `username` or `last_seen` are created automatically by
Firestore for equality and range queries if needed later.

**Confidence: HIGH** — Firestore auto-indexes document IDs and single fields by default.

### Lookup Pattern

```javascript
// Read history (add ~1 Firestore read per webhook event):
const historyRef = connectionDoc.ref.collection('commenter_history').doc(commenterUsername);
const historyDoc = await historyRef.get();
const history = historyDoc.exists ? historyDoc.data() : null;

// Inject into prompt if returning commenter:
if (history?.is_returning) {
    systemPrompt += `\nCOMMENTER CONTEXT: @${commenterUsername} has commented ${history.comment_count} times before.`;
    if (history.last_reply_text) {
        systemPrompt += ` Last time you replied: "${history.last_reply_text}"`;
    }
}

// After successful reply, update history (fire-and-forget, don't await):
historyRef.set({
    username: commenterUsername,
    first_seen: history ? history.first_seen : Timestamp.now(),
    last_seen: Timestamp.now(),
    comment_count: (history?.comment_count || 0) + 1,
    last_comment_text: commentText,
    last_reply_text: replyMessage,
    last_media_id: mediaId,
    is_returning: true,
}, { merge: true }).catch(err => console.error('Failed to update commenter history:', err));
```

The update is fire-and-forget (no `await`) because the reply has already been sent — the history
update is non-critical and should not delay the webhook response.

**Confidence: HIGH** — `set({ merge: true })` is the correct Firestore upsert pattern.

---

## Reply Variety / Deduplication on Same Post

### Problem

The current dedup (`hasExistingReply`) only prevents replying to the *same comment* twice. It
does not prevent replying to 10 different comments on the same post with near-identical text.
When `temperature: 0.9` is set, model-level variety handles most of this, but for posts that get
many comments quickly, a prompt-level recent-replies list is stronger.

### Recommended Pattern: In-Memory Per-Post Reply Cache

Store recent replies in an in-process Map keyed by `mediaId`. No Firestore writes needed for
dedup purposes.

```javascript
// Module-level (persists for the Cloud Run instance lifetime):
const recentPostReplies = new Map(); // mediaId -> string[]
const MAX_REPLIES_PER_POST = 8;

function getRecentReplies(mediaId) {
    return recentPostReplies.get(mediaId) || [];
}

function trackReply(mediaId, replyText) {
    const existing = recentPostReplies.get(mediaId) || [];
    existing.push(replyText);
    if (existing.length > MAX_REPLIES_PER_POST) existing.shift();
    recentPostReplies.set(mediaId, existing);
}
```

Inject into prompt before generation:
```javascript
const recent = getRecentReplies(mediaId);
if (recent.length > 0) {
    systemPrompt += `\n\nRECENT REPLIES YOU'VE ALREADY SENT ON THIS POST (do not repeat these patterns):\n`;
    systemPrompt += recent.map(r => `- "${r}"`).join('\n');
}
```

**Why in-memory and not Firestore:**
- Cloud Run instances handle one request at a time; in-memory is consistent within an instance
- Writing to Firestore on every reply adds latency and cost for a non-critical feature
- If the instance restarts, the cache is lost — this is acceptable; repetition is cosmetic, not
  a correctness bug
- Firestore would be needed only if multiple Cloud Run instances scale up simultaneously. At
  barbershop comment volumes (dozens/day, not thousands), this is not a realistic concern.

**Confidence: HIGH** — appropriate for the scale and constraints described in PROJECT.md.

---

## What NOT to Add

| Rejected Addition | Why |
|-------------------|-----|
| LangChain / LlamaIndex | Zero value here. Direct OpenAI SDK calls are simpler, have less overhead, and are already in use. Orchestration frameworks add abstraction cost with no benefit for single-step generation. |
| Vector embeddings / semantic search for dedup | Extreme overkill for this volume. Keyword comparison or simple recent-replies list is sufficient. |
| Redis / external cache for reply dedup | Unnecessary at barbershop scale. In-memory Map is fine. Add only if Cloud Run scales to 10+ concurrent instances. |
| Separate AI microservice | The current pattern (AI call inline in webhook handler) is correct for this scale. Extracting adds a network hop and another failure point. |
| Streaming responses | Instagram Graph API reply endpoint does not support streaming — the full reply text must be sent in one POST. No value in streaming from OpenAI. |
| Retry logic for OpenAI calls | Already handled by openai SDK's built-in retry. Do not add manual retry loops. |
| Prompt templates library (Handlebars, nunjucks) | Template strings with `${}` interpolation are sufficient for this prompt structure. Adding a template engine increases dependencies for no gain. |

---

## No Version Changes Required

The existing `openai@6.17.0` package supports both `openai.responses.create()` (current, for
o4-mini) and `openai.chat.completions.create()` (new, for gpt-4.1-mini). No package update
needed — just change the call site.

`@google-cloud/firestore@8.0.0` supports the `set({ merge: true })` upsert pattern and nested
subcollection paths used in the commenter history schema. No update needed.

---

## Summary of Changes

| Change | Type | Effort | Confidence |
|--------|------|--------|------------|
| Switch `o4-mini` → `gpt-4.1-mini` via Chat Completions API | Code change in `instagram-webhook.js` | Low | MEDIUM (verify pricing) |
| Add `temperature: 0.9`, `max_tokens: 120` | Parameter addition | Trivial | HIGH |
| Persona-first prompt rewrite | Prompt engineering | Medium | HIGH |
| Inject commenter `@username` into prompt | Code + prompt | Trivial | HIGH |
| New `commenter_history` Firestore subcollection | Schema + read/write code | Low | HIGH |
| Recent-replies in-memory Map per post | New module-level state | Low | HIGH |
| Move few-shot examples earlier in prompt | Prompt restructure | Trivial | HIGH |

---

## Sources

- Codebase analysis: `src/routes/instagram-webhook.js`, `src/utils/instagram.js`, `package.json` (read 2026-03-10)
- OpenAI SDK v6 Chat Completions API: training knowledge through Aug 2025 (MEDIUM confidence for model names/pricing — verify at platform.openai.com/docs/models)
- Firestore subcollection patterns: `@google-cloud/firestore` v8 documentation, consistent with existing patterns in `firestore.indexes.json`
- Temperature and prompt ordering recommendations: training knowledge through Aug 2025, well-established principles (HIGH confidence)
