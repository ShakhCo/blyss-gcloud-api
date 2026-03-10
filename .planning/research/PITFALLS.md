# Domain Pitfalls: Instagram AI Auto-Reply Personality & Memory

**Domain:** AI comment auto-reply for barbershop/salon Instagram accounts
**Researched:** 2026-03-10
**Project file:** src/routes/instagram-webhook.js

---

## Critical Pitfalls

Mistakes that cause rewrites, policy violations, or permanent damage to the business account.

---

### Pitfall 1: The Booking-Link Spam Pattern Trains Commenters to Ignore You

**What goes wrong:**
Every single reply ends with the booking link, regardless of context. Commenters learn
within 2-3 posts that the account always drops the same link. They stop reading replies.
Worse, other commenters see the pattern and flag it as bot behavior. Instagram's comment
ranking algorithm deprioritizes comments that look automated.

**Why it happens:**
The current prompt hardcodes "GOAL: Drive bookings. Every reply should feel human and
naturally push toward the booking link." This creates a system that is constitutionally
incapable of a reply that does NOT include the link — even for "🔥" or "beautiful work"
comments where a link is tone-deaf.

**Consequences:**
- Engagement quality drops: people stop replying back
- Account may be flagged by Instagram for repetitive automated behavior
- The "social media manager" goal fails — real SMMs know when NOT to sell

**Prevention:**
Reserve the booking link for comments that signal intent ("how much?", "I want to come",
"when are you open?"). For pure reactions and compliments, reply warmly and let the
conversation breathe. The prompt should categorize intent, not mandate the link universally.

**Detection:**
Scroll 10+ replies on any post. If more than 60% end with the booking URL, the link is
being overused.

**Phase:** AI Personality Overhaul (Phase 1)

---

### Pitfall 2: Token Expiry Silently Kills Auto-Reply for Entire Business

**What goes wrong:**
Instagram long-lived tokens expire after ~60 days. There is currently no token refresh
job. When a token expires, `replyToComment()` throws, the `catch` block in
`handleCommentEvent` swallows the error, and the business owner never knows auto-reply
stopped working. They see no replies on new comments but assume it is just quiet.

**Why it happens:**
The catch-all `try/catch` in `handleCommentEvent` is necessary so the webhook never
returns a non-200 (which would cause Meta to retry and eventually disable the webhook).
But it also silently buries token expiry errors.

**Consequences:**
- Auto-reply goes dark with zero notification
- Business owner finds out weeks later, losing engagement during that window
- Token can only be refreshed while still valid — if missed entirely, requires
  full re-authorization

**Prevention:**
- Add a cron job that refreshes tokens 7-10 days before expiry (token stores
  `expires_at` timestamp in Firestore)
- In `handleCommentEvent`, distinguish token expiry errors (error code 190 from
  Instagram) from other errors and send a Telegram alert to the business owner
  and admin when it is detected

**Detection:**
Instagram returns `{"error": {"code": 190, "type": "OAuthException"}}` for expired
tokens. Log these separately and alert immediately.

**Phase:** Infrastructure hardening — address before or alongside Phase 1

---

### Pitfall 3: Comment History Firestore Growth Without TTL

**What goes wrong:**
Tracking every commenter's history (username, comment text, timestamp, reply sent)
across all posts for all businesses creates unbounded Firestore document growth.
A barbershop with 1,000 followers posting daily for a year could generate 50,000+
history documents. At Firestore pricing (~$0.06/100k reads), reads are cheap, but
writes are $0.18/100k and storage accumulates.

**Why it happens:**
The naive implementation writes one document per comment interaction. No one sets a
TTL because "we might need it later." Six months in, the collection is large, queries
slow, and deleting old data requires a migration.

**Consequences:**
- Storage cost scales with account activity, not user count
- Queries like "last 5 comments from this user" require ordering + limit — cheap
  with proper index, expensive without
- GDPR-adjacent concern: indefinitely storing commenter usernames without purpose

**Prevention:**
- Store only what the AI actually uses: username, last 3 comment texts, last seen
  timestamp, total interaction count
- Cap history per commenter at 5 entries maximum — store as an array field on a
  single document keyed by `{businessId}_{username}`, not one document per comment
- Set a `last_seen` timestamp and run a monthly cron to delete records older than
  90 days
- Never store comment text verbatim if only the count/tone matters

**Detection:**
Monitor Firestore collection size in GCP console. Alert if any sub-collection exceeds
10,000 documents.

**Phase:** Comment History implementation (Phase 2) — design schema before writing code

---

### Pitfall 4: Webhook Response Timeout During buildBusinessInfo

**What goes wrong:**
`buildBusinessInfo` makes 2 Firestore collection reads in sequence (services, then
for each employee their employeeServices). For a barbershop with 6 employees, this
is 7-8 sequential Firestore round-trips inside a webhook handler. Cloud Run gives
the webhook handler the full request timeout (default 60s), but Meta expects a 200
response within a few seconds. Currently the code responds AFTER processing
(`await Promise.all(tasks)` before `res.send()`).

**Why it happens:**
The current architecture was built this way intentionally ("process before responding
so Cloud Run keeps CPU allocated"). This works, but it is one slow Firestore query
away from timing out under load.

**Consequences:**
- If `buildBusinessInfo` takes >10-15 seconds, Meta may resend the webhook
- Duplicate replies — the dedup check (`hasExistingReply`) fetches from the Instagram
  API which may not yet reflect the first reply
- Under very heavy comment volume (viral post), multiple webhook events in parallel
  all run `buildBusinessInfo` simultaneously — N×7 Firestore reads at once

**Prevention:**
- Parallelize the Firestore reads inside `buildBusinessInfo` using `Promise.all()`
  (services + employees can be fetched simultaneously; employeeServices can be
  batched with `Promise.all(employees.map(...))`)
- Cache business context in-memory (keyed by businessId) for 60 seconds — business
  info does not change between comments on the same post
- If adding comment history reads, batch with the existing business context read

**Detection:**
Check Cloud Run request duration logs. Any webhook handler taking >5 seconds on
average is dangerous.

**Phase:** Affects all phases — fix the parallelization in Phase 1 before adding more reads

---

## Moderate Pitfalls

---

### Pitfall 5: "Trying Too Hard to Be Human" — The Overcorrection

**What goes wrong:**
When you instruct the AI to "sound human and casual", it overcompensates. Common
patterns that emerge: excessive use of "Ohhh", "Hahaha", adding "honestly", "ngl",
"lowkey", using ellipses everywhere ("come visit us... 😊"), or inserting fake
familiarity ("You're absolutely right! We totally get that!"). These patterns are
immediately recognizable as AI trying to be casual.

**Why it happens:**
Training data for "casual social media tone" is heavily weighted toward these filler
phrases. Without explicit negative constraints, the model uses them as shortcuts
for sounding informal.

**Consequences:**
- Savvy commenters notice instantly — "this is a bot lol" comments appear
- Worse than a slightly formal reply: obvious fake casualness damages trust more
  than sounding professional
- The Uzbek/Russian-speaking audience for barbershops has specific informal register
  norms — "Ohhh" and "ngl" land very differently than they would in English

**Prevention:**
- The prompt must explicitly forbid specific filler phrases: no "Ohh", no "Haha",
  no "Honestly", no "Totally", no "Absolutely", no "We get it"
- Add a rule: "Never start a reply with 'Great!', 'Amazing!', 'Wonderful!'"
- Use the `ai_example_replies` feature (already supported in the system) to
  anchor the tone with 5-6 handwritten examples per business
- Test with: "would a real person at this barbershop actually text this?"

**Detection:**
Read 20 generated replies. Count how many start with an exclamation-inflected word
or contain filler affirmations. More than 3/20 means the prompt needs stronger
negative constraints.

**Phase:** AI Personality Overhaul (Phase 1)

---

### Pitfall 6: Username Personalization That Feels Surveillance-Like

**What goes wrong:**
Using the commenter's @username in every reply creates an unexpected effect: it
feels like the business is tracking them. "Hey @username, great to hear from you
again! 👋" on a public post feels intimate in a creepy way, not a warm way — especially
when the commenter never gave permission to be "remembered."

**Why it happens:**
The goal "commenter personalization" translates directly to "use their name in
every reply." But public Instagram usernames are handles, not first names. Using
a handle like "@shadowy_barber_fan" in a reply is strange.

**Consequences:**
- Commenters find it odd, some delete their comment or block the account
- If the username contains personal info (real name as handle), it amplifies
  the surveillance feeling

**Prevention:**
- Use @username only for: direct questions from the commenter that need a
  personal response, return commenters being acknowledged ("good to see you again")
- Never use @username for pure reaction replies ("🔥") or generic compliments
- When using the name, keep it in the first 3 words so it reads as direct address,
  not an afterthought tagging
- Consider: use @username at most once per reply, never in the middle of a sentence

**Detection:**
Read 10 replies that include @username. Ask: does this feel like talking TO someone
or ABOUT someone?

**Phase:** Personalization implementation (Phase 2)

---

### Pitfall 7: Reply Variety Logic That Produces Obvious Variation

**What goes wrong:**
When you tell the AI "vary your replies, never use the same wording twice", it
produces replies that are structurally identical but swap synonyms. "Great work!"
becomes "Amazing work!" becomes "Fantastic work!" — the pattern is obvious and
still feels like a template.

**Why it happens:**
The model's concept of "variety" at low reasoning effort is surface-level synonym
substitution, not structural variation.

**Consequences:**
- Regular commenters notice the pattern after 3-4 posts
- The "variety" instruction creates false confidence — the replies ARE varied by
  the model's internal measure but not by human perception

**Prevention:**
- True variety requires structural variation: different reply formats (question,
  statement, acknowledgment + action, joke + call), not different words
- Include 5-8 structurally different reply templates in `ai_example_replies` that
  the model can use as scaffolding
- For high-traffic posts (many comments), pass the last 2-3 reply texts as context
  so the model can deliberately diverge: "Recent replies on this post: [X, Y].
  Write something structurally different."
- At o4-mini with low reasoning, this context-aware variety may require upgrading
  to a higher reasoning effort for posts with >20 comments

**Detection:**
Take 10 consecutive replies on a single post. If the first and last word pattern
is the same in 5+ replies, variety is insufficient.

**Phase:** Reply variety (Phase 3) — depends on personality overhaul first

---

### Pitfall 8: Stale Post Caption Context Leading to Wrong Replies

**What goes wrong:**
The current code fetches post caption on every comment event via `getMediaDetails()`.
This is one extra Instagram API call per incoming comment. For a post getting
100 comments, that is 100 identical API calls for the same caption. Beyond wasteful,
if Instagram throttles this endpoint, caption context becomes unavailable and the
AI replies without post context.

**Why it happens:**
Captions are fetched per-comment rather than cached per-post.

**Consequences:**
- Under viral post load, Instagram API throttling degrades reply quality (no caption)
- Each additional API call inside the webhook increases the risk of timeout (see
  Pitfall 4)
- If rate limited, `getMediaDetails` returns null silently — AI proceeds without
  post context, but caller does not know this degraded the response

**Prevention:**
- Cache post captions in Firestore (collection `instagram_post_cache`) with a 24-hour
  TTL keyed by `mediaId` — write on first fetch, read on subsequent comments
- The cache write is async (fire-and-forget) so it does not block the reply path
- For comment history reads (Phase 2), this same cache layer can hold recent
  comment summaries per post

**Detection:**
Log cache hit rate. If hit rate is < 50% on a post with multiple comments, caching
is not working.

**Phase:** Cache infrastructure — implement alongside or before comment history (Phase 2)

---

## Minor Pitfalls

---

### Pitfall 9: Emoji Overuse After "Add Emojis to Sound Casual"

**What goes wrong:**
When instructed to add 1-2 emojis, the model interprets this as: always use 2 emojis,
always at the end, always the same set (🔥❤️😍👏). The emoji becomes a signature
that telegraphs automation.

**Prevention:**
- Instruct: "0-2 emojis. Sometimes use zero. Never use the same emoji twice in a row
  on the same post. Emoji must relate to the specific comment, not be decorative."
- Ban specific overused emojis in the prompt: 🔥❤️👏✅🙏 should be used sparingly

**Phase:** Phase 1

---

### Pitfall 10: Language Detection Failure for Mixed-Language Comments

**What goes wrong:**
A commenter writes "Zo'r post 👍 very nice" — half Uzbek, half English. The current
prompt says "match the comment's language." The AI picks one language and half the
audience feels excluded. More commonly: Uzbek comments written in Cyrillic vs Latin
script get misidentified.

**Prevention:**
- For mixed-language comments, default to the first language detected or the
  business's primary language (configurable in `ai_instructions`)
- For Uzbek specifically: treat Cyrillic and Latin as the same language (Uzbek).
  Add explicit note to the prompt: "Uzbek is written in both Cyrillic and Latin
  script — treat them as the same language, respond in Latin Uzbek unless the
  commenter used Cyrillic"
- Test with edge cases: emoji-only, number-only, mixed-script

**Phase:** Phase 1 (part of prompt overhaul)

---

### Pitfall 11: Comment History Query Hitting Wrong Business's Data

**What goes wrong:**
If commenter history is stored keyed only by `username` (not by `businessId +
username`), a commenter who has visited barbershop A and later comments on barbershop
B's post will be treated as a "returning customer" at B — creating a false
"good to see you again!" reply.

**Prevention:**
- Always key history documents as `{businessId}_{commenterUsername}` or store them
  in a sub-collection under the business document
- Validate businessId scope on every history read in code (not just query key)

**Phase:** Phase 2 — critical to get right on schema design

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| AI Personality Overhaul | Overcorrection to fake-casual filler phrases | Add explicit negative constraints; anchor with `ai_example_replies` |
| AI Personality Overhaul | Booking link in every reply | Categorize intent first; link only on intent signals |
| AI Personality Overhaul | Emoji signature revealing automation | Vary usage; sometimes use zero |
| AI Personality Overhaul | Mixed-language Uzbek comments | Explicit Cyrillic/Latin handling in prompt |
| Comment History Tracking | Unbounded Firestore growth | Single doc per user per business; 5-entry array max; 90-day TTL |
| Comment History Tracking | Cross-business history pollution | Key by `businessId_username`; sub-collection under business |
| Comment History Tracking | Post caption fetched per-comment | Cache in Firestore with 24h TTL |
| Commenter Personalization | @username feels like surveillance | Use only on intent comments or return interactions; not on reactions |
| Reply Variety | Synonym-swap variation (structural sameness) | Pass last 2-3 replies as negative context; structural example replies |
| Reply Variety | o4-mini low-effort can't hold variety context | Consider higher reasoning effort for posts with >20 comments |
| Infrastructure (all phases) | Token expiry kills auto-reply silently | Cron refresh job + error code 190 alerting |
| Infrastructure (all phases) | `buildBusinessInfo` slow sequential reads | Parallelize with `Promise.all()` before adding history reads |

---

## Sources

- Codebase analysis: `src/routes/instagram-webhook.js` — direct inspection of existing
  prompt, rate of API calls, error handling patterns
- Codebase analysis: `src/utils/instagram.js` — token expiry flow, reply API shape,
  absence of caching layer
- Instagram Graph API documentation (from training data, HIGH confidence for stable
  behaviors): token lifetime ~60 days, error code 190 for OAuth expiry, webhook must
  return 200 within seconds
- Instagram Graph API rate limits (MEDIUM confidence — verify against current docs):
  Business Use Case rate limiting applies per-app per-user; comment reply endpoint
  is subject to standard 200 calls/hour per token for older API tiers; Instagram
  Platform Policy prohibits automated spam behavior detectable by pattern
- AI persona research (HIGH confidence from production patterns): filler phrases,
  emoji overuse, structural vs surface variety are well-documented LLM output
  failure modes in social media automation
- Firestore pricing (HIGH confidence): write-heavy workloads scale linearly; document
  design must bound writes per interaction, not grow with comment volume
