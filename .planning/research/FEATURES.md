# Feature Landscape: Instagram AI Auto-Reply Personality

**Domain:** AI-powered Instagram comment engagement for barbershop/salon businesses
**Researched:** 2026-03-10
**Confidence:** HIGH (based on direct code analysis of existing system + domain knowledge of Instagram engagement patterns for local service businesses)

---

## Context: What the Current System Does (and Where It Fails)

The existing system (`src/routes/instagram-webhook.js`) is technically correct but socially robotic. The current prompt defaults reveal the problem:

- Every positive comment gets: `"Raxmat! 😍 Sizni kutamiz: {link}"`
- Every reaction gets: `"Спасибо! 🤍 Записывайтесь: {link}"`
- Negative comments get the same canned deflection

The system treats every comment as a conversion funnel step. Real social media managers treat comments as conversations. The difference: a conversion funnel pushes people away; a conversation pulls them in and makes the booking link feel like a natural next step, not a sales pitch.

The commenter's `username` is already available from `commentData.from.username` but is never used in replies. There is zero comment history tracking. The AI has no sense of who it is talking to or whether it has spoken with this person before.

---

## Table Stakes

Features users (commenters) expect from a business that replies on Instagram. Missing these makes the account feel like a bot, regardless of what else is done.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **@username mention in reply** | Every human replier uses it naturally; absence is the #1 bot tell | Low | Username already in `commentData.from.username`; just inject into prompt |
| **Reply varies by comment tone** | Enthusiastic comments deserve enthusiasm back, not a template | Low | Already partially handled by comment-type routing; needs personality lift |
| **No booking link on every reply** | Inserting a link after every single reply is the classic spam-bot pattern | Low | Prompt change only — reserve the link for genuine booking questions |
| **Emoji that matches the comment's energy** | Someone sends 🔥 and gets a 😍 back: that's a mismatch that reads as automated | Low | Prompt instruction: mirror the commenter's energy level and emoji style |
| **Short replies for short comments** | A one-word comment ("Zo'r!") getting a three-sentence reply is a bot signal | Low | Existing 2-sentence max is good; enforce "if comment is ≤3 words, reply ≤1 sentence" |
| **No self-introduction in replies** | "Hi, we are [Business Name]!" in a comment reply is absurd — everyone can see the account | Low | Already in rules; reinforce as hard rule |
| **Language match** | Already implemented; this is table stakes for uz/ru market | Low | Existing — keep |
| **Spam detection** | Already implemented (__SKIP__) | Low | Existing — keep |

---

## Differentiators

Features that make replies feel like a real, witty social media manager rather than a polite chatbot.

### D1: Personality-First Prompt Architecture
**What:** Replace the current "GOAL: Drive bookings" framing with a persona definition that leads with who the AI is, not what it's trying to sell. Example: "You are the voice of [Business Name] — confident, warm, a little playful. You know your clients. You make people feel seen."
**Value proposition:** Persona-led prompts produce dramatically more natural language than goal-led prompts. The booking link becomes a natural offer, not a call-to-action.
**Complexity:** Low — prompt rewrite only, no code changes
**Dependencies:** None

### D2: Commenter Name Personalization
**What:** Use `@username` naturally in replies — but not mechanically. "Nice! @alex 💪" reads human. "@alex, thank you for your comment!" reads robotic. The rule: use the name once, naturally, where a human would.
**Value proposition:** The #1 signal of a non-automated reply. People notice when you use their name.
**Complexity:** Low — inject `commenter_username` into prompt context; add instruction on natural placement
**Dependencies:** None (data already available)

### D3: Comment History Awareness
**What:** Track per-business, per-commenter interaction history in Firestore (`businesses/{id}/instagram_commenters/{username}`). Store: last_seen timestamp, comment_count, was_greeted (bool). Feed a brief summary into the AI prompt: "This person has commented 3 times before. Acknowledge them as a regular."
**Value proposition:** "Glad you're back!" vs treating a loyal fan like a stranger every time. Creates genuine community feel.
**Complexity:** Medium — new Firestore subcollection write on every processed comment; read on every AI reply generation; requires cleanup strategy for old records
**Dependencies:** Requires Firestore write path added to handleCommentEvent
**Notes:** Store only username + count + last_seen — no PII beyond what Instagram provides. Keep it lightweight: a single document per commenter, upserted on each interaction.

### D4: Post Type Classification
**What:** Classify the post from its caption into a type: `before_after`, `promo`, `new_service`, `team_spotlight`, `client_result`, `general`. Feed this classification to the AI: "This is a before/after post. Replies should celebrate the transformation, not immediately redirect to booking."
**Value proposition:** A "before/after" post calls for complimenting the work and creating aspiration. A "promo" post warrants urgency. A "general" post warrants warmth. One-size prompting ignores this.
**Complexity:** Medium — either a classification sub-call to the AI (adds latency + cost) or simple keyword heuristics on the caption (fast, zero cost). Start with heuristics.
**Dependencies:** Post caption already fetched in current code

### D5: Reply Variety Enforcement via Seen-Replies Memory
**What:** Within a single post session (or across recent replies), track the last 5 reply openings used and inject them into the prompt as "do not start your reply with any of these." Prevents the AI from defaulting to the same opener on every comment.
**Value proposition:** When 20 comments on a post all get replies starting with "Raxmat! 😍", it announces that replies are automated. Variety is the camouflage.
**Complexity:** Medium — requires a short-lived cache (in-memory Map keyed by mediaId, or Firestore) storing recent reply snippets per post. In-memory is fine given Cloud Run instance behavior.
**Dependencies:** None architectural; requires reply logging step before sending

### D6: Engagement-Driving Questions (Selective)
**What:** On certain comment types — genuine praise, curiosity, before/after reactions — add a natural follow-up question to the reply instead of (not in addition to) the booking link. "Which style are you thinking of? 👀" or "First time trying a fade?" These invite a reply, which boosts the post's engagement score algorithmically.
**Value proposition:** Comments-on-comments increase reach on Instagram's algorithm. A business that turns one comment into a conversation gets more organic distribution.
**Complexity:** Low — prompt instruction change only; add a comment-type category `[genuine_praise/curiosity]` that triggers the follow-up question pattern
**Dependencies:** Post type classification (D4) helps but is not required

### D7: Witty One-Liners for Emoji-Only Comments
**What:** A comment of just "🔥🔥🔥" or "❤️" deserves a punchy one-liner, not a booking push. "The kind of reaction that keeps us going 🙏" or "We see you 👀🔥" These are shareable, quotable, and human.
**Value proposition:** Emoji-only comments are very common on barbershop posts. A witty comeback gets liked, shared, and remembered. A "Raxmat! Sizni kutamiz:" gets ignored.
**Complexity:** Low — prompt instruction + examples
**Dependencies:** None

### D8: Negative Comment De-escalation with Empathy
**What:** Replace the current canned deflection ("Bir tashrif buyurib ko'ring 😊 {link}") with a two-step: acknowledge the specific concern briefly, then invite resolution without argument. "Nima bo'lganini eshitishni istaymiz — DM yozib qo'ying, to'g'rilaymiz 🙏" (We want to hear what happened — send a DM and we'll sort it out). No booking link. No defensive tone.
**Value proposition:** Defensive or dismissive replies to negative comments go viral for the wrong reasons. Empathetic replies defuse tension publicly and show other viewers that the business cares.
**Complexity:** Low — prompt instruction change
**Dependencies:** None

### D9: Milestone / Celebration Awareness
**What:** Detect when a post caption mentions an opening anniversary, a follower milestone, or a team achievement. Replies on these posts should reflect the celebratory energy: "1000 ta obunachi bilan birga bo'lganimiz uchun raxmat 🎉" rather than a generic booking push.
**Value proposition:** Milestone posts are the highest-engagement posts a business publishes. Replies that match the moment generate more engagement than off-tone booking links.
**Complexity:** Low — caption keyword heuristic (milestone/anniversary keywords in uz/ru/en); no new infrastructure
**Dependencies:** None

---

## Anti-Features

Things that make replies feel MORE robotic. Actively avoid these.

| Anti-Feature | Why It Feels Robotic | What to Do Instead |
|--------------|----------------------|-------------------|
| **Booking link on every reply** | Signals automated funnel; no human does this in a comments section | Reserve for direct booking questions only; use conversational closes otherwise |
| **Fixed opener on every reply** | "Raxmat!" x 20 comments = obvious bot | Enforce opener variety; no two consecutive replies on the same post start with the same word |
| **Self-introduction in every reply** | "Hello, we are [Business Name]" in a public comment is absurd — the account name is visible | Hard rule: never introduce the business name in a reply |
| **Formal business language** | "We appreciate your feedback and look forward to serving you" is corporate speak, not a barber | Prompt persona: casual, warm, direct, Uzbek street-smart voice |
| **Over-emoji replies** | 5+ emojis per reply reads as a bot trying too hard | Cap at 2 emojis; use them where a human would actually use them, not as decoration |
| **Replying to spam with a polite redirect** | "Thank you for reaching out! Check out our booking link" in response to "Follow me for free followers" | Hard skip (__SKIP__) — already in place, must stay |
| **Forced hashtags in replies** | No human puts hashtags in a comment reply | Already banned in rules; reinforce |
| **"How can I help you today?"** | Call center opener; completely wrong tone for Instagram | Banned in existing rules; reinforce with persona framing |
| **Ignoring the comment's specific content** | Generic reply to a specific comment ("Nice fade on the sides!") signals the system never read it | Require the reply to reference something specific from the comment text |
| **Asking for a DM immediately** | "Send us a DM for more info" is an avoidance tactic; people notice | Only suggest DM for complaints/sensitive issues; answer basic questions inline |

---

## Feature Dependencies

```
D2 (name personalization) — independent, data already available
D3 (comment history) — independent; enables richer context for D1 (persona)
D4 (post type classification) — enables D6 (engagement questions) and D9 (milestone awareness)
D5 (reply variety enforcement) — independent; requires in-memory or Firestore state
D6 (engagement questions) — enhanced by D4, but works alone
D7 (emoji one-liners) — independent
D8 (negative de-escalation) — independent
D9 (milestone awareness) — enhanced by D4
```

---

## MVP Recommendation

The highest-impact changes for minimum implementation cost, ordered by ROI:

1. **Personality-first prompt rewrite (D1)** — Zero code changes. Single highest-impact action. The current prompt's "GOAL: Drive bookings" framing produces every robotic behavior downstream. Fix the persona first.
2. **@username personalization (D2)** — One-line prompt injection. Eliminates the #1 bot signal.
3. **Booking link discipline (Table Stakes)** — Prompt change only. Stop the booking link after every reply; reserve it for genuine booking questions. This alone changes the tone of the entire comments section.
4. **Emoji-only witty one-liners (D7)** — Prompt instruction + 3-5 examples in the prompt. High-frequency comment type on barbershop posts; current handling is the worst offender.
5. **Reply variety enforcement (D5)** — Small in-memory cache per media ID. Prevents the most visible bot signal (identical openers on the same post).

Defer until after personality foundation is solid:
- **Comment history (D3)** — Valuable but adds write latency and Firestore complexity. Build after prompt quality is proven.
- **Post type classification (D4)** — Caption heuristics are fast; full AI classification is not worth it until base quality is high.
- **Negative comment de-escalation (D8)** — Already handled minimally; refine via prompt once persona is stable.

---

## Implementation Notes (Specific to This Codebase)

**Prompt architecture change:** The current system uses a single `systemPrompt` string built imperatively. For the personality overhaul, introduce a layered structure:
1. Persona block (who the AI is, tone, voice)
2. Context block (business info, post info, commenter info)
3. Rules block (hard constraints: length, language, no hashtags, etc.)
4. Behavioral guidance (how to handle comment types — without rigid templates)

**Comment history storage (D3):** Use `businesses/{businessId}/instagram_commenters/{ig_username}` in Firestore. Fields: `comment_count` (integer), `last_seen` (timestamp), `first_seen` (timestamp). Upsert with `merge: true` on every processed comment. Query before AI call with a simple `.get()`. No index needed (direct document lookup by username). Add a TTL field or periodic cleanup cron if collection size becomes a concern.

**Reply variety cache (D5):** `Map<mediaId, string[]>` in module scope is sufficient. Cloud Run instances are long-lived enough that the cache persists across comments on the same post. Track the first 8 words of each sent reply. Reset after 24h or if array grows beyond 20 entries. No Firestore needed.

**Post type classification (D4 — heuristics approach):**
```
before_after: caption includes "oldin", "keyin", "до", "после", "before", "after", "transformation"
promo: caption includes "chegirma", "скидка", "discount", "%", "акция", "promo", "off"
new_service: caption includes "yangi", "новый", "new", "endi", "теперь", "introducing"
milestone: caption includes "yil", "лет", "anniversary", "1000", "subscribers", "followers"
general: everything else
```

---

## Sources

- Direct code analysis: `src/routes/instagram-webhook.js` (full prompt logic)
- Direct code analysis: `src/utils/instagram.js` (API capabilities and available fields)
- Direct code analysis: `src/schemas/instagram.js` (data model constraints)
- Direct code analysis: `firestore.indexes.json` (existing collection structure)
- Project context: `.planning/PROJECT.md`
- Confidence: HIGH — findings grounded entirely in the existing codebase and established LLM prompt engineering patterns for persona-led vs goal-led prompts
