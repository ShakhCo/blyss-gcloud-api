# Phase 1: Prompt Architecture & Model Switch - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Rewrite the AI persona prompt, switch from o4-mini to gpt-4.1-mini, extract prompt construction into `buildSystemPrompt()`, parallelize `buildBusinessInfo()` reads, fix booking link spam, add @username personalization, and enforce reply length/emoji rules. No new Firestore collections — that's Phase 2.

</domain>

<decisions>
## Implementation Decisions

### AI Persona Voice
- **Solo businesses** (`is_solo` field on business): speak as the owner — "I" voice ("Sizni kutaman", "Raxmat!")
- **Team businesses**: speak as the business/social media person — "We" voice ("Sizni kutamiz", brand voice)
- Tone driven by `ai_instructions` field when present
- **Default tone** (when `ai_instructions` is empty): warm & balanced — friendly but not too casual, works for any business type
- No slang by default; businesses can opt into casual tone via `ai_instructions`

### Uzbek Script Handling
- Match commenter's script: if they write in Cyrillic Uzbek, reply in Cyrillic; Latin gets Latin
- Russian comments get Russian replies (existing behavior, keep)

### Booking Link Rules
- Booking link appears ONLY on booking-intent or location questions
- Booking intent: comments asking about booking, price, hours, availability
- Location questions: include maps link (already in `buildBusinessInfo`) + booking link
- All other comments (praise, emoji, greetings, reactions): NO booking link
- Negative comments: NO booking link, invite DM for resolution

### Default Example Replies
- Provide 3-5 built-in example replies per language (uz/ru) baked into the prompt
- These serve as style anchors when `ai_example_replies` is empty (most businesses)
- When `ai_example_replies` is populated, use those instead of defaults
- Examples should demonstrate the warm & balanced default tone

### Reply Tone by Post Type
- Claude's discretion on whether to include basic caption awareness in Phase 1 or defer entirely to Phase 3
- Post caption is already fetched — using it for basic context is fine, but formal classification system is Phase 3

### Claude's Discretion
- Exact default example reply text per language
- Whether to include basic post caption awareness in Phase 1 prompt
- Loading skeleton / progress for prompt extraction refactor
- Exact emoji usage rules within the 2-emoji cap
- How to structure the layered prompt sections internally

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildBusinessInfo()` in `instagram-webhook.js:345-428` — already builds full business context, needs Promise.all parallelization
- `commentData.from.username` — commenter username available in webhook payload, never used in prompt
- `connection.ai_instructions` and `connection.ai_example_replies` — per-business customization fields already exist
- Business `is_solo` field — available from `businessDoc.data()` already fetched in handler

### Established Patterns
- OpenAI SDK v6.17.0 supports both `responses.create()` and `chat.completions.create()` — model switch is API call change
- System prompt built as string concatenation in `handleCommentEvent` — needs extraction to dedicated function
- `buildBusinessInfo` does 7-8 sequential Firestore reads (services, employees, employee services) — convert to parallel

### Integration Points
- Single file to modify: `src/routes/instagram-webhook.js`
- New function: `buildSystemPrompt(options)` — extracted from inline prompt construction
- Model change: `openai.responses.create()` → `openai.chat.completions.create()` with `temperature: 0.9`
- `buildBusinessInfo()` refactor: wrap Firestore reads in `Promise.all()`

</code_context>

<specifics>
## Specific Ideas

- Solo vs team voice based on `is_solo` field is a key differentiator — makes every business feel personal
- Default example replies should feel like real Instagram comments, not formal templates
- Cyrillic/Latin script matching for Uzbek is important for the local market

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-prompt-architecture-model-switch*
*Context gathered: 2026-03-10*
