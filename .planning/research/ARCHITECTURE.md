# Architecture Patterns

**Domain:** Instagram AI auto-reply — comment history, commenter memory, reply variety, prompt redesign
**Researched:** 2026-03-10

---

## Context: The Existing Flow

The current `handleCommentEvent()` function in `src/routes/instagram-webhook.js` already runs a complete pipeline:

```
Webhook POST → signature verify → find business connection →
  check per-post settings → dedup (hasExistingReply) →
  buildBusinessInfo() → getMediaDetails() → AI generate →
  replyToComment() → Telegram notify
```

Everything new must be **additive**. The pipeline structure stays intact. New capabilities slot in as additional reads/writes at specific points in that flow.

---

## Recommended Architecture

### Component Map

| Component | File | Responsibility | New or Existing |
|-----------|------|---------------|-----------------|
| Webhook handler | `src/routes/instagram-webhook.js` | Entry point, orchestration | Existing — modify |
| Comment history reader | inline in handler | Fetch commenter history before AI call | New — inline helper |
| Comment history writer | inline in handler | Write interaction record after reply | New — inline helper |
| Post reply tracker | inline in handler | Fetch recent replies on same post for variety | New — inline helper |
| Prompt builder | `buildSystemPrompt()` (new fn) | Assemble structured system prompt | New — extract from inline |
| Business info builder | `buildBusinessInfo()` | Fetch business data for prompt | Existing — unchanged |
| AI caller | inline in handler | Call OpenAI | Existing — unchanged |

The current code has the prompt built inline inside `handleCommentEvent`. Extract it into `buildSystemPrompt(options)` to make the personality and context sections independently manageable. The handler calls it; nothing else changes structurally.

---

## Firestore Schema for Comment History

### New Collection: `instagram_comment_history`

Stored as a subcollection under each business:

```
businesses/{businessId}/instagram_comment_history/{commenterId}
```

The document ID is the commenter's Instagram username (normalized lowercase). This gives O(1) lookup by username with no query needed — just a `doc.get()` call.

```javascript
// businesses/{businessId}/instagram_comment_history/{commenterUsername}
{
  username: "john_doe",                    // redundant, but useful for reads
  first_seen_at: Timestamp,               // when they first commented
  last_seen_at: Timestamp,                // most recent comment
  comment_count: 3,                       // total comments across all posts
  last_comment_text: "Zo'r !!",          // their most recent comment text
  last_reply_text: "Raxmat, kelasiz?",   // last AI reply we sent them
  last_media_id: "17846368219941196",     // post they last commented on
}
```

**Why this schema:**
- Doc ID = username means `.doc(username).get()` with no composite index needed
- Denormalized `comment_count` and `first_seen_at` lets the prompt say "this is their 3rd comment" without aggregation
- Storing `last_reply_text` lets the prompt avoid repeating the same reply to a repeat commenter
- No subcollection of individual comments — the prompt only needs the summary, not a log
- Firestore write is a single `set({ merge: true })` with `FieldValue.increment` for the counter

**Firestore index required:** None. Document reads by ID need no composite index. The collection group query on `instagram_connection` already exists. This new collection is read by ID only.

---

### New Collection: `instagram_post_reply_log`

Stored as a subcollection under each business, keyed by media ID:

```
businesses/{businessId}/instagram_post_reply_log/{mediaId}
```

```javascript
// businesses/{businessId}/instagram_post_reply_log/{mediaId}
{
  media_id: "17846368219941196",
  reply_count: 12,                         // total replies sent on this post
  recent_replies: [                        // last N reply texts (capped array)
    "Raxmat! Sizni kutamiz 😊",
    "Albatta keling, joylar bor!",
    "Zo'r tanlov, yozilib qo'ying 🙌"
  ],
  updated_at: Timestamp,
}
```

**Why this schema:**
- One document per post means one `.doc(mediaId).get()` — no query
- `recent_replies` array capped at 5-8 entries; written with `arrayUnion` + post-write trim
- The array is injected into the prompt as "recent replies on this post, do not repeat these"
- Avoids the hallmark failure mode: bot replies "Raxmat! Sizni kutamiz 😊" to every single comment on the same photo

**Cap enforcement:** After writing, if `recent_replies.length > 8`, trim via an update that slices the oldest. Do this as a second Firestore write — acceptable because it's non-critical and fire-and-forget.

---

## How History Integrates with `handleCommentEvent`

The integration is two new parallel reads before the AI call, and two new writes after the successful reply. The existing flow is not reorganized.

### Modified Flow (AI mode only)

```
existing: dedup check (hasExistingReply)
               ↓
NEW: parallel Firestore reads
  ├── businesses/{biz}/instagram_comment_history/{username}  → commenterHistory
  └── businesses/{biz}/instagram_post_reply_log/{mediaId}    → postReplyLog

existing: buildBusinessInfo()  (unchanged)
existing: getMediaDetails()    (unchanged)

NEW: buildSystemPrompt({
  businessInfo,
  postCaption,
  postTime,
  now,
  commenterHistory,   ← injected here
  postReplyLog,       ← injected here
  connection,
  postAiInstructions,
  bookingLink,
})

existing: openai.responses.create(...)
existing: replyToComment(...)

NEW: parallel Firestore writes (fire-and-forget, .catch(() => {}))
  ├── update instagram_comment_history/{username}
  └── update instagram_post_reply_log/{mediaId}

existing: Telegram admin notify
```

The two reads happen in parallel with `Promise.all`:

```javascript
const commenterUsername = (commentData.from?.username || '').toLowerCase();
const [commenterHistoryDoc, postReplyLogDoc] = await Promise.all([
  commenterUsername
    ? db.collection('businesses').doc(businessId)
        .collection('instagram_comment_history').doc(commenterUsername).get()
    : Promise.resolve(null),
  db.collection('businesses').doc(businessId)
    .collection('instagram_post_reply_log').doc(mediaId).get(),
]);
const commenterHistory = commenterHistoryDoc?.exists ? commenterHistoryDoc.data() : null;
const postReplyLog = postReplyLogDoc?.exists ? postReplyLogDoc.data() : null;
```

The two writes are fire-and-forget after the reply succeeds:

```javascript
// After replyToComment() succeeds:
const now = new Date();

// Write comment history
if (commenterUsername) {
  db.collection('businesses').doc(businessId)
    .collection('instagram_comment_history').doc(commenterUsername)
    .set({
      username: commenterUsername,
      first_seen_at: commenterHistory?.first_seen_at || now,
      last_seen_at: now,
      comment_count: FieldValue.increment(1),
      last_comment_text: commentText,
      last_reply_text: replyMessage,
      last_media_id: mediaId,
    }, { merge: true })
    .catch(() => {});
}

// Write post reply log
db.collection('businesses').doc(businessId)
  .collection('instagram_post_reply_log').doc(mediaId)
  .set({
    media_id: mediaId,
    reply_count: FieldValue.increment(1),
    recent_replies: FieldValue.arrayUnion(replyMessage),
    updated_at: now,
  }, { merge: true })
  .catch(() => {});
```

`FieldValue` is imported from `@google-cloud/firestore`. It is already a dependency. No new packages are required.

---

## Prompt Architecture

### Refactoring: Extract `buildSystemPrompt()`

The current prompt is built inline using string concatenation across ~60 lines in `handleCommentEvent`. It should be extracted into a dedicated `buildSystemPrompt(options)` function (in the same file or a new `src/utils/instagramPrompt.js`). The function returns a single string. The AI call stays unchanged.

### System Prompt Structure

The prompt has five sections, in this order. Order matters — LLMs give more weight to earlier content.

```
[1] ROLE & PERSONA
[2] BUSINESS CONTEXT        (from buildBusinessInfo — unchanged)
[3] POST CONTEXT            (caption, publish date)
[4] COMMENTER CONTEXT       (new — from commenter history)
[5] RECENT REPLIES          (new — from post reply log)
[6] INSTRUCTIONS            (per-post or global rules)
```

**Section 1 — Role & Persona (replaces current opening)**

The current opener is: `"You are replying to Instagram post comments on behalf of a business."` — this produces a "business bot" voice. Replace with a persona that produces a human social media manager voice:

```
You are managing the Instagram comment section for {businessName}.
Reply as their social media person — sharp, warm, and human.
You know the business inside out and genuinely like their followers.
Today: {now} (Tashkent, UTC+5). This is a PUBLIC comment section, not a DM.
```

**Section 2 — Business Context (unchanged)**

`buildBusinessInfo()` output. No changes. Still includes services, hours, team, booking link.

**Section 3 — Post Context (unchanged structure, same data)**

```
Post caption: "{postCaption}"
Post published: {postTime}
```

**Section 4 — Commenter Context (NEW)**

Only included when `commenterHistory` is non-null:

```javascript
if (commenterHistory) {
  const isRepeat = commenterHistory.comment_count > 1;
  if (isRepeat) {
    lines.push(`\nCOMMENTER MEMORY:`);
    lines.push(`@${commenterHistory.username} has commented ${commenterHistory.comment_count} times before.`);
    lines.push(`Their last comment: "${commenterHistory.last_comment_text}"`);
    lines.push(`Your last reply to them: "${commenterHistory.last_reply_text}"`);
    lines.push(`Don't repeat your previous reply. Acknowledge them as a returning follower if natural.`);
  } else {
    lines.push(`\nCOMMENTER MEMORY: @${commenterHistory.username} — first-time commenter.`);
  }
}
```

If `commenterHistory` is null (first ever comment), this section is omitted entirely. Do not add any "I don't know this person" text — just let the model treat them as a new visitor.

**Section 5 — Recent Replies on This Post (NEW)**

Only included when `postReplyLog?.recent_replies?.length > 0`:

```javascript
if (postReplyLog?.recent_replies?.length > 0) {
  lines.push(`\nRECENT REPLIES ALREADY SENT ON THIS POST (do not repeat these):`);
  for (const r of postReplyLog.recent_replies.slice(-5)) {
    lines.push(`- "${r}"`);
  }
  lines.push(`Vary your wording. Each reply should feel fresh.`);
}
```

**Section 6 — Instructions (existing, unchanged)**

The existing per-post / global rules section stays exactly as-is. This section already handles spam detection, language matching, tone, etc. Personality is improved by Sections 1 and 4, not by changing Section 6 rules.

One addition to the global rules block — replace the current username handling (it's not implemented at all) with:

```
- The commenter's username is @{commenterUsername}. Use it naturally at most once if it fits.
```

---

## Component Boundaries

| Component | Owns | Does NOT Own |
|-----------|------|-------------|
| `handleCommentEvent` | Orchestration, all Firestore reads/writes, pre/post hooks | Prompt text, business data |
| `buildSystemPrompt()` | Prompt text assembly from provided data | Firestore access, AI calls |
| `buildBusinessInfo()` | Business data fetching and formatting | Prompt structure |
| History reads | `instagram_comment_history`, `instagram_post_reply_log` reads | Business data |
| History writes | `instagram_comment_history`, `instagram_post_reply_log` writes | Reply logic |

`buildSystemPrompt` must be a pure function: it takes all data as arguments and returns a string. Zero Firestore access, zero async. This makes it testable in isolation.

---

## Data Flow Direction

```
Webhook payload
    │
    ▼
handleCommentEvent(igUserId, commentData)
    │
    ├─► [READ] businesses/{biz}/instagram_connection (existing)
    ├─► [READ] businesses/{biz}/instagram_post_settings/{mediaId} (existing)
    ├─► [READ] Instagram API — hasExistingReply (existing)
    ├─► [READ] businesses/{biz}/instagram_comment_history/{username}  ← NEW
    ├─► [READ] businesses/{biz}/instagram_post_reply_log/{mediaId}    ← NEW
    │
    ├─► buildBusinessInfo() → business context string (existing)
    ├─► getMediaDetails() → post caption + timestamp (existing)
    │
    ├─► buildSystemPrompt({all data}) → system prompt string  ← NEW (extract)
    │
    ├─► openai.responses.create() → replyMessage (existing)
    │
    ├─► replyToComment() → Instagram API (existing)
    │
    ├─► [WRITE] instagram_comment_history/{username} (fire-and-forget)  ← NEW
    ├─► [WRITE] instagram_post_reply_log/{mediaId} (fire-and-forget)    ← NEW
    │
    └─► sendTelegramMessage() (existing)
```

---

## Build Order

Each step has no circular dependencies. Build in this order:

### Step 1: Firestore Schema (foundation — everything else depends on this)

Define the two new collections. No code yet — just decide field names and write one manual test document to verify the structure reads cleanly. Required before any integration work.

### Step 2: History Reads in `handleCommentEvent` (non-breaking)

Add the two parallel `Promise.all` reads before `buildBusinessInfo`. At this point, the data is fetched but not used. The AI prompt is unchanged. Zero behavior change. Safe to ship independently.

### Step 3: Extract `buildSystemPrompt()` (refactor, not feature)

Move the inline prompt construction into a standalone function. Input: all the same data the current inline code has. Output: same string. AI behavior should not change. Ship as a refactor — verify in staging that reply content is identical before adding new sections.

This step must complete before steps 4 and 5 — you cannot add new prompt sections to inline code cleanly.

### Step 4: Personality Overhaul (Section 1 + username usage)

Change the persona section and add `@username` injection to the rules. This is the highest-value, lowest-risk change. No new Firestore data required. Just prompt text changes. Test with 10-20 sample comments.

### Step 5: Commenter Memory in Prompt (Section 4)

Add the commenter context section using data already fetched in Step 2. Depends on Step 3 (prompt function) and Step 2 (data available).

### Step 6: Reply Variety in Prompt (Section 5)

Add the recent-replies deduplication section. Same dependency as Step 5.

### Step 7: History Writes (completes the loop)

Add the fire-and-forget Firestore writes after `replyToComment`. Depends on all prior steps being stable. The writes are last because they don't affect reply quality — they feed future replies. Shipping writes before reads are wired to the prompt is safe.

### Dependency Graph

```
Step 1 (schema)
    └─► Step 2 (reads)
              └─► Step 5 (commenter context in prompt)
              └─► Step 6 (variety in prompt)
Step 3 (extract buildSystemPrompt)
    └─► Step 4 (personality)
    └─► Step 5
    └─► Step 6
Step 7 (writes) — depends on Step 2 only (needs username/mediaId in scope)
```

Steps 3 and 2 can be done in parallel. Steps 4, 5, 6 all depend on Step 3 and can be done in any order after it.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Storing Full Comment Logs Per User

**What:** Collection of every individual comment per commenter, queried to build history
**Why bad:** Unnecessary document volume; the prompt only needs a 3-line summary, not a log. Queries add latency on every webhook call.
**Instead:** Single denormalized summary document per commenter, updated in-place with `merge: true`

### Anti-Pattern 2: Writing History Before the Reply Succeeds

**What:** Write to Firestore, then call `replyToComment`, then skip the write-rollback on failure
**Why bad:** If `replyToComment` throws, the history records a reply that was never sent. `last_reply_text` becomes stale. Dedup logic downstream could be confused.
**Instead:** Write history only after `replyToComment()` resolves successfully. Both writes are fire-and-forget but must come after the reply call.

### Anti-Pattern 3: Blocking the Webhook on History Writes

**What:** `await` the history write calls before returning
**Why bad:** Cloud Run keeps CPU allocated until the response is sent. History writes are non-critical. Adding `await` to fire-and-forget operations adds 100-300ms of latency for zero user-facing benefit.
**Instead:** `.set().catch(() => {})` without `await`

### Anti-Pattern 4: Injecting Raw History Dump Into Prompt

**What:** Passing the full Firestore document as JSON into the prompt
**Why bad:** Verbose, token-wasteful, and the model does not need field names. It needs 2-3 readable sentences.
**Instead:** Format history into prose: `"@jane has commented 4 times before. Their last comment: '...' Your last reply: '...'"` — 1-3 lines maximum.

### Anti-Pattern 5: Merging Personality Into the Rules Block

**What:** Adding "be witty" and "sound human" to the existing RULES section at the bottom of the prompt
**Why bad:** Rules are read after the persona is established. Personality instructions buried in rules have weak effect. LLM instruction-following is front-loaded.
**Instead:** Persona is Section 1, immediately after the role declaration, before any business data.

---

## Scalability Considerations

| Concern | Current scale | With comment history |
|---------|--------------|---------------------|
| Firestore reads per webhook | ~4 reads | +2 reads (parallel) |
| Firestore writes per reply | 0 new writes | +2 writes (fire-and-forget) |
| Prompt token count | ~400-600 tokens | +50-100 tokens (history sections) |
| Per-business storage | n/a | ~1 doc per unique commenter, ~1 doc per post |
| Index requirements | ig_user_id collection group | No new indexes (doc ID lookups only) |

At typical barbershop/salon scale (50-200 comments/week), the additional read cost is negligible. The `instagram_comment_history` collection will grow to a few hundred documents per business, which is well within Firestore's document-per-collection limits.

---

## Sources

- Source code analysis: `src/routes/instagram-webhook.js` (lines 108-340)
- Firestore schema: `firestore.indexes.json` — existing index on `instagram_connection.ig_user_id` COLLECTION_GROUP
- Firestore docs on `FieldValue.increment` and `arrayUnion`: HIGH confidence (standard Firestore API, well-established)
- Prompt ordering guidance (persona before rules): MEDIUM confidence (empirical from prompt engineering literature, not formally benchmarked here)
- `@google-cloud/firestore` `FieldValue` import pattern: HIGH confidence (already a project dependency at v8.0.0)
