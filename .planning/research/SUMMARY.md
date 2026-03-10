# Project Research Summary

**Project:** BLYSS Instagram AI Auto-Reply — Personality & History Milestone
**Domain:** AI-powered Instagram comment engagement for barbershop/salon businesses
**Researched:** 2026-03-10
**Confidence:** HIGH

## Executive Summary

The current Instagram auto-reply system is technically functional but socially broken. It uses the wrong AI model (o4-mini, a reasoning model) for a task that requires conversational fluency, and its prompt frames every reply as a booking funnel step rather than a human conversation. The result is detectable bot behavior: every reply ends with the booking link, openers repeat across comments, and the system has no memory of returning commenters. The single highest-leverage fix is not a model upgrade or a database change — it is a persona-first prompt rewrite that changes the AI's self-conception from "reply machine" to "social media person."

The recommended approach is a four-phase build that starts with the highest-impact, lowest-risk change (prompt architecture and model switch to gpt-4.1-mini) and defers infrastructure investment (commenter history, reply caching) until the personality foundation is proven. The architectural pattern is fully additive: all new capabilities slot into the existing `handleCommentEvent()` pipeline without restructuring it. Two new Firestore subcollections provide persistent commenter memory and per-post reply variety. A `buildSystemPrompt()` function extracted from inline code makes the prompt structure independently testable and maintainable.

The key risks are: (1) the booking-link-on-every-reply pattern is actively training commenters to ignore replies and may trigger Instagram's automated spam detection — this must be fixed in Phase 1; (2) Instagram OAuth tokens expire silently after ~60 days with no current alerting, which can kill auto-reply for an entire business without anyone knowing; (3) Firestore commenter history can grow unbounded without a TTL strategy — schema must cap this at design time, not as an afterthought.

---

## Key Findings

### Recommended Stack

No new npm packages are required. The existing `openai@6.17.0` SDK supports both the current `openai.responses.create()` call (used for o4-mini) and the new `openai.chat.completions.create()` call (needed for gpt-4.1-mini) — the switch requires changing the call site, not the dependency. Similarly, `@google-cloud/firestore@8.0.0` fully supports the `set({ merge: true })` upsert pattern and `FieldValue.increment`/`FieldValue.arrayUnion` operations needed for the new collections.

**Core technologies:**
- **gpt-4.1-mini via Chat Completions API:** Primary AI model — optimized for fluency and instruction-following over reasoning; supports `temperature` parameter (critical for reply variety); ~60-80% cheaper than o4-mini per token; 128K context window
- **Firestore subcollections:** Commenter history and post reply log — O(1) document ID lookups, no new composite indexes, `merge: true` upsert pattern, fire-and-forget writes to avoid webhook latency
- **In-memory Map (module-level):** Per-post recent-replies cache — sufficient for Cloud Run single-instance behavior at barbershop comment volumes; avoids Firestore write cost for non-critical dedup

**Critical version note:** Switching from `openai.responses.create()` to `openai.chat.completions.create()` is a code change, not a config change. The `reasoning: { effort: 'low' }` parameter must be removed; `temperature`, `max_tokens`, and `messages[]` replace the current parameters. Verify gpt-4.1-mini pricing at platform.openai.com before committing (MEDIUM confidence on pricing — model released April 2025).

### Expected Features

The FEATURES.md analysis is grounded in direct codebase inspection and has HIGH confidence throughout.

**Must have (table stakes):**
- @username mention in replies — absence is the single strongest bot signal; data already available in `commentData.from.username`
- No booking link on every reply — reserve for genuine intent signals ("how much?", "when are you open?"); current universal link drops engagement quality
- Reply length proportional to comment length — one-word comment should get one-sentence reply; current 2-sentence max is correct but not enforced for short comments
- Emoji that matches comment energy — mismatched emoji (commenter sends 🔥, reply sends 😍) signals automation; cap at 2 emojis; sometimes use zero
- Language match — already implemented; keep

**Should have (differentiators):**
- Persona-first prompt architecture (D1) — replace "GOAL: Drive bookings" framing with a person-description; this single change has the highest downstream impact on all reply quality
- Commenter history awareness (D3) — "glad you're back!" vs treating loyal fans as strangers; new Firestore subcollection per business
- Post type classification (D4) — before/after posts warrant transformation celebration, not booking push; heuristic keyword matching on caption is sufficient (no AI sub-call needed)
- Reply variety enforcement (D5) — in-memory per-post recent-replies list injected into prompt
- Engagement-driving questions for praise/curiosity comments (D6) — drives algorithmic reach; prompt instruction only
- Witty one-liners for emoji-only comments (D7) — highest-frequency comment type on barbershop posts; current handling is the worst offender

**Defer (v2+):**
- Full AI post classification (D4 extended) — heuristic keywords cover 90% of cases; AI sub-call adds latency and cost before base quality is proven
- Redis or cross-instance reply dedup — only needed if Cloud Run scales to 10+ concurrent instances; not a realistic concern at barbershop comment volumes

### Architecture Approach

The architecture is purely additive. The existing `handleCommentEvent()` pipeline structure remains intact; new capabilities attach at specific points. Two parallel Firestore reads are inserted before the AI call, and two fire-and-forget writes follow the reply. The prompt construction is extracted from inline code into a pure `buildSystemPrompt(options)` function — zero async, zero Firestore access, fully testable. This extraction is a prerequisite for adding the personality, commenter context, and variety sections cleanly.

**Major components:**
1. `handleCommentEvent()` in `instagram-webhook.js` — orchestration only; owns all Firestore I/O and API calls; calls `buildSystemPrompt()` with assembled data
2. `buildSystemPrompt(options)` (new, extracted) — pure function; assembles 6-section structured prompt from provided data: [1] Role & Persona, [2] Business Context, [3] Post Context, [4] Commenter Memory, [5] Recent Replies, [6] Instructions
3. `instagram_comment_history/{username}` Firestore subcollection (new) — one denormalized summary document per commenter per business; keyed by username for O(1) lookup; fields: `comment_count`, `first_seen_at`, `last_seen_at`, `last_comment_text`, `last_reply_text`
4. `instagram_post_reply_log/{mediaId}` Firestore subcollection (new) — one document per post per business; `recent_replies` array capped at 8 entries; updated with `arrayUnion` fire-and-forget after each reply

### Critical Pitfalls

1. **Booking link on every reply trains commenters to ignore replies** — categorize comment intent first; only include the link when the comment signals genuine booking intent; prompt must categorize, not mandate universally (Phase 1, highest priority)
2. **Instagram OAuth token expiry silently kills auto-reply** — add cron job to refresh tokens 7-10 days before expiry; detect error code 190 from Instagram API and send Telegram alert to business owner and admin; address before or alongside Phase 1
3. **Commenter history Firestore growth without TTL** — single document per commenter per business (not one doc per comment); cap `recent_replies` array at 5 entries; add `last_seen` timestamp and monthly cron to delete records older than 90 days; design schema before writing any code (Phase 2)
4. **`buildBusinessInfo()` sequential Firestore reads cause webhook timeout risk** — parallelize with `Promise.all()` (services + employees simultaneously); cache business context in-memory for 60 seconds; fix before adding the two new history reads (all phases)
5. **"Trying too hard to be human" overcorrection** — explicitly forbid filler phrases ("Ohh", "Haha", "Honestly", "Totally", "Absolutely", "We get it"); forbid openers like "Great!", "Amazing!"; anchor tone with 5-6 business-specific `ai_example_replies` (Phase 1)

---

## Implications for Roadmap

Based on combined research, a 4-phase structure is recommended. The ordering follows the dependency graph from ARCHITECTURE.md and the MVP recommendation from FEATURES.md.

### Phase 1: Prompt Architecture & Model Switch

**Rationale:** All robotic behavior downstream stems from two root causes: wrong AI model (o4-mini reasoning vs gpt-4.1-mini chat) and wrong prompt framing (goal-led vs persona-led). Fix these first. No new infrastructure needed. This phase has the highest ROI per line of code changed and establishes the quality baseline that later phases depend on.

**Delivers:** Human-sounding replies with appropriate tone, emoji discipline, no universal booking link, @username personalization, reply length calibration, and structural variety (via temperature + few-shot examples).

**Addresses from FEATURES.md:** Table stakes (all 5), D1 (persona), D2 (username), D7 (emoji one-liners), D8 (negative de-escalation), D9 (milestone awareness) — all are prompt-only changes.

**Avoids from PITFALLS.md:** Pitfall 1 (booking link spam), Pitfall 5 (fake-casual overcorrection), Pitfall 9 (emoji signature), Pitfall 10 (mixed-language Uzbek handling).

**Also includes:** Parallelization of `buildBusinessInfo()` reads (Pitfall 4 prevention) and token expiry alerting (Pitfall 2 prevention) — infrastructure fixes with no user-facing changes.

### Phase 2: Firestore Schema & Data Reads

**Rationale:** Infrastructure prerequisite for commenter memory and reply variety. The two new Firestore collections must be designed correctly before any code is written — schema decisions here are hard to change later (Pitfall 3 TTL design, Pitfall 11 cross-business isolation). This phase adds the reads only; the prompt still does not use them yet. That allows independent validation that the reads work correctly and add acceptable latency.

**Delivers:** Two new Firestore subcollections with correct schema, parallel reads wired into `handleCommentEvent()`, zero behavior change to reply quality (reads fetched but not yet injected into prompt).

**Uses from STACK.md:** Firestore `set({ merge: true })`, `FieldValue.increment`, document-ID lookup pattern (no new indexes).

**Avoids from PITFALLS.md:** Pitfall 3 (TTL and bounded document design), Pitfall 11 (business-scoped subcollection path ensures cross-business isolation), Pitfall 8 (post caption caching infrastructure established here).

### Phase 3: Commenter Memory & Reply Variety in Prompt

**Rationale:** Depends on Phase 1 (buildSystemPrompt function extracted) and Phase 2 (history data available). This phase wires the fetched data into the prompt's Sections 4 and 5. Split from Phase 2 so prompt behavior changes can be tested independently from infrastructure changes.

**Delivers:** Replies that acknowledge returning commenters, avoid repeating recent openers on the same post, and use post type context (before/after, promo, milestone) to adjust tone.

**Addresses from FEATURES.md:** D3 (comment history), D4 (post type classification via caption heuristics), D5 (reply variety enforcement), D6 (engagement questions).

**Avoids from PITFALLS.md:** Pitfall 6 (@username surveillance feeling — use only on intent/return signals, not reactions), Pitfall 7 (synonym-swap variety — structural example replies + recent-replies negative context produces real variety).

### Phase 4: History Writes & Persistence Loop

**Rationale:** The fire-and-forget Firestore writes that close the memory loop are last because they do not affect reply quality — they feed future replies. Shipping writes before the read-to-prompt pipeline is validated would create stale data that has no consumer yet. Once Phases 1-3 are stable, the writes complete the system.

**Delivers:** Persistent commenter memory that accumulates across sessions; post reply log that survives instance restarts (unlike the in-memory Map from Phase 1 variety).

**Uses from STACK.md:** `FieldValue.arrayUnion`, `merge: true` upsert, fire-and-forget `.catch(() => {})` pattern.

**Avoids from PITFALLS.md:** Pitfall 3 (writes use `merge: true`, not append-only), Anti-Pattern 2 from ARCHITECTURE.md (writes happen only after `replyToComment()` succeeds, never before).

---

### Phase Ordering Rationale

- Phase 1 before Phase 2: Prompt quality must be established before adding complexity. Adding commenter history to a prompt that still says "GOAL: Drive bookings" would waste the memory context.
- Phase 2 before Phase 3: Can't inject data that hasn't been fetched. Schema decisions (TTL, business-scoped paths) must be locked before writing integration code.
- Phase 3 before Phase 4: Writes should only begin populating data that the prompt is already consuming. Writing history before reading it in the prompt creates orphan data with no validation path.
- Infrastructure fixes (token expiry alerting, `buildBusinessInfo()` parallelization) are in Phase 1 not because they're personality features, but because they must be resolved before adding more Firestore reads and potential failure points.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** gpt-4.1-mini pricing should be verified at platform.openai.com before committing — MEDIUM confidence on cost estimate. Also verify that `temperature: 0.9` produces acceptable output quality vs `0.7` for Uzbek/Russian text (may need empirical testing).
- **Phase 2:** Instagram API rate limits for `getMediaDetails()` endpoint should be confirmed against current documentation — MEDIUM confidence. The post caption caching strategy in Pitfall 8 depends on the actual rate limit behavior.

Phases with standard patterns (skip research-phase):
- **Phase 3:** Firestore document ID lookups and `Promise.all()` parallelization are well-established patterns with HIGH confidence. No research needed.
- **Phase 4:** Fire-and-forget Firestore writes with `merge: true` and `FieldValue` operations are standard; fully covered by existing codebase patterns.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | gpt-4.1-mini model name and pricing from training data through Aug 2025 — verify at platform.openai.com before implementation. API call structure (Chat Completions) is HIGH confidence. No new dependencies needed is HIGH confidence. |
| Features | HIGH | Grounded entirely in direct codebase inspection of `instagram-webhook.js`, `instagram.js`, `instagram.js` schema, and `firestore.indexes.json`. All feature recommendations are based on existing data fields and prompt analysis. |
| Architecture | HIGH | Additive pattern to an existing well-understood pipeline. Firestore schema design follows established subcollection patterns already in the codebase. `buildSystemPrompt()` extraction is pure refactor. |
| Pitfalls | HIGH | Critical pitfalls (token expiry, booking link spam, Firestore growth) are grounded in code analysis + well-documented Instagram Platform Policy behavior. AI persona pitfalls are well-documented production failure modes. |

**Overall confidence:** HIGH

### Gaps to Address

- **gpt-4.1-mini pricing and availability:** Training knowledge cutoff is Aug 2025; model was released April 2025. Confirm model is available in the current OpenAI account tier and that pricing supports the expected comment volume before Phase 1 implementation. Fallback: gpt-4o-mini is already in the codebase at `src/routes/ai.js` and would work.
- **Instagram API rate limits for caption fetching:** The Pitfall 8 caching recommendation assumes the `getMediaDetails()` endpoint is rate-limited in a way that matters at viral post volumes. Verify against current Instagram Platform documentation. If rate limits are generous, caption caching (Phase 2) can be deferred.
- **`ai_example_replies` population:** The effectiveness of Phase 1 persona work depends heavily on businesses having well-written example replies in their connection settings. Current adoption rate unknown. If most businesses have empty `ai_example_replies`, the few-shot examples section of the prompt will be absent and quality gains will be reduced. Consider providing default examples per language.
- **Token expiry cron timing:** The `instagram_connection` documents store `expires_at`; a refresh cron needs to be scheduled. The cron infrastructure exists (`src/routes/cron.js`) but the token refresh endpoint and scheduling are not currently implemented. This is a prerequisite for the token alerting in Phase 1.

---

## Sources

### Primary (HIGH confidence)
- `src/routes/instagram-webhook.js` — full pipeline, prompt logic, error handling, AI call site
- `src/utils/instagram.js` — token structure, reply API shape, available comment fields
- `src/schemas/instagram.js` — data model constraints and validation
- `firestore.indexes.json` — existing collection structure and index patterns
- `.planning/PROJECT.md` — project goals and problem definition
- `package.json` — dependency versions (openai@6.17.0, @google-cloud/firestore@8.0.0)

### Secondary (MEDIUM confidence)
- OpenAI platform documentation (training knowledge through Aug 2025) — gpt-4.1-mini model characteristics, Chat Completions API parameters, pricing estimates
- Instagram Graph API documentation (training knowledge) — token lifetime (~60 days), error code 190, webhook response timing requirements

### Tertiary (LOW confidence)
- Instagram API rate limits for comment/caption endpoints — verify against current developer documentation before Phase 2 implementation

---
*Research completed: 2026-03-10*
*Ready for roadmap: yes*
