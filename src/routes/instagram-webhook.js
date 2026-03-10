import { Router } from 'express';
import OpenAI from 'openai';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { db } from '../db/db.js';
import {
    verifyWebhookSignature,
    replyToComment,
    hasExistingReply,
    getMediaDetails,
} from '../utils/instagram.js';
import { sendTelegramMessage } from '../utils/telegram.js';
import { decrypt } from '../utils/encryption.js';

let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI();
}

const router = Router();

const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;

const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

/**
 * GET /
 * Webhook verification endpoint for Meta.
 * Meta sends a challenge request when configuring the webhook — respond with the challenge
 * as plain text if the verify token matches.
 */
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
        console.log('Instagram webhook verified');
        return res.status(200).send(challenge);
    }

    console.warn('Instagram webhook verification failed — invalid token or mode');
    return res.status(403).send('Forbidden');
});

/**
 * POST /
 * Receives comment events from Meta's Instagram webhooks.
 * Processes comments before responding so Cloud Run keeps CPU allocated.
 */
router.post('/', async (req, res) => {
    // Verify signature
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhookSignature(rawBody, signature)) {
        console.warn('Instagram webhook: invalid signature');
        return res.status(200).send('EVENT_RECEIVED');
    }

    const body = req.body;

    if (body.object !== 'instagram') {
        console.log(`Instagram webhook: ignoring non-instagram object: ${body.object}`);
        return res.status(200).send('EVENT_RECEIVED');
    }

    // Process each entry — await all before responding so Cloud Run keeps CPU allocated
    const tasks = [];
    if (Array.isArray(body.entry)) {
        for (const entry of body.entry) {
            const igUserId = entry.id;

            if (Array.isArray(entry.changes)) {
                for (const change of entry.changes) {
                    console.log(`Instagram webhook: received change field="${change.field}" for user ${igUserId}`);
                    if (change.field === 'comments') {
                        tasks.push(handleCommentEvent(igUserId, change.value));
                    }
                }
            } else {
                console.log(`Instagram webhook: entry has no changes array`, JSON.stringify(entry));
            }
        }
    } else {
        console.log('Instagram webhook: body has no entry array');
    }

    await Promise.all(tasks);
    res.status(200).send('EVENT_RECEIVED');
});

/**
 * Build the system prompt for AI comment replies.
 * Pure function — no side effects, no DB calls. Fully testable.
 *
 * @param {object} opts
 * @param {string} opts.businessInfo      - Formatted business context from buildBusinessInfo()
 * @param {boolean} opts.isSolo           - true = solo owner voice ("I"), false = team voice ("We")
 * @param {string} opts.bookingLink       - Booking URL; empty string = omit booking sections
 * @param {string} opts.username          - Commenter's @username (may be empty)
 * @param {string} opts.postCaption       - Instagram post caption
 * @param {string} opts.postTime          - Post publish time (formatted string)
 * @param {string} opts.postAiInstructions - Per-post override instructions; empty = use global rules
 * @param {string} opts.aiInstructions    - Global owner instructions (appended to global path)
 * @param {string} opts.aiExampleReplies  - Owner-provided example replies; empty = use defaults
 * @param {string} opts.now               - Current Tashkent time (formatted string)
 * @returns {string} Complete system prompt
 */
export function buildSystemPrompt({
    businessInfo,
    isSolo,
    bookingLink,
    username,
    postCaption,
    postTime,
    postAiInstructions,
    aiInstructions,
    aiExampleReplies,
    now,
    commenterHistory,  // null | { username, comment_count, first_seen_at, last_seen_at, last_comment_text } — used in Phase 3
    postReplies,       // null | { recent_replies: [{ text, at }] } — used in Phase 3
}) {
    // ── Section 1: Identity / Role (TONE-01) ─────────────────────────────────
    const voiceSingular = 'first person singular — "I", "men", "ya"';
    const voicePlural = 'first person plural — "we", "biz", "my"';
    const voiceExamples = isSolo
        ? 'Speak as the owner personally — "Sizni kutaman", "Raxmat!", "Ya vas zhdu"'
        : 'Speak as the business — "Sizni kutamiz", "Siz bilan ishlashdan mamnunmiz"';

    let systemPrompt = `You are replying to Instagram comments on behalf of ${isSolo ? 'the business owner' : 'the business social media team'}.
Voice: ${isSolo ? voiceSingular : voicePlural}
Tone: warm, confident, and human. Not corporate. Not a bot. Not a booking funnel.
Be the kind of social media manager whose replies make people smile — friendly but not try-hard.
${voiceExamples}
This is a PUBLIC COMMENT SECTION — keep replies short and social.
Today: ${now} (Tashkent, UTC+5)`;

    // ── Section 2: Context ────────────────────────────────────────────────────
    systemPrompt += `\n\n${businessInfo}`;
    if (postCaption || postTime) {
        systemPrompt += `\nPost caption: "${postCaption}"`;
        if (postTime) systemPrompt += `\nPost published: ${postTime}`;
    }

    if (postAiInstructions) {
        // Per-post custom AI instructions — follow these instead of global rules
        systemPrompt += `\n\nINSTRUCTIONS FOR REPLYING TO COMMENTS ON THIS POST:\n${postAiInstructions}`;
        systemPrompt += `

RULES:
- Max 2 sentences. No exceptions.
- Match the comment's language (uz/ru/en).
- Match the commenter's script: Cyrillic Uzbek gets Cyrillic reply, Latin gets Latin.
- 1-2 emojis max, naturally placed.
- Vary your wording — never repeat the exact same reply twice.
- No hashtags. No self-introductions. No "DM us".
- Sound like a friendly business owner, not a bot or support agent.
- SPAM / IRRELEVANT ("Follow me", "Check my page"): Do not reply. Return exactly: __SKIP__`;
    } else {
        // ── Section 3: Core rules ─────────────────────────────────────────────

        // LANGUAGE AND SCRIPT
        systemPrompt += `

LANGUAGE AND SCRIPT:
- Match the commenter's language. Uzbek gets Uzbek, Russian gets Russian.
- Match the commenter's script exactly: if they write in Cyrillic Uzbek, reply in Cyrillic Uzbek. If Latin Uzbek, reply in Latin Uzbek.`;

        // REPLY LENGTH (TONE-05)
        systemPrompt += `

REPLY LENGTH:
- Comment is 1-3 words OR emoji-only: reply in exactly 1 sentence (max ~12 words).
- Comment is 4-10 words: reply in 1-2 sentences.
- Comment is 11+ words or a paragraph: reply in 2-3 sentences max.
- Never exceed 3 sentences regardless of comment length.`;

        // EMOJI USAGE (TONE-06)
        systemPrompt += `

EMOJI USAGE:
- Commenter used no emojis: use 0-1 emoji, only if it genuinely fits.
- Commenter used 1-2 emojis: use 1-2 emojis, mirroring their energy.
- Commenter used 3+ emojis or emoji-only: use 1-2 emojis — enthusiastic but not excessive.
- Cap: never more than 2 emojis per reply.
- Never lead with an emoji as the first character.`;

        // @USERNAME PLACEMENT (PERS-01)
        if (username) {
            systemPrompt += `

@USERNAME PLACEMENT:
Commenter's username: @${username}
Use @${username} naturally — once only, placed where a human would naturally address someone (start for greetings, middle for emphasis, end as a warm sign-off). Never mechanically at the very start of every reply. Omit entirely if the reply is very short and inserting a username would feel forced.`;
        }

        // ── Section 4: Comment-type routing (TONE-02, TONE-03, TONE-04) ───────
        systemPrompt += `

REPLY BY COMMENT TYPE:

BOOKING-INTENT (price, booking, hours, availability, location, "how much", "qancha", "skolko", "yozilish", "zapisatsya"):
- Answer with specific info from business data.${bookingLink ? `\n- Include booking link once, naturally: "Yozilish uchun: ${bookingLink}"` : ''}
- For location questions, include map link from business data${bookingLink ? ` + booking link` : ''}.

REACTIONS / EMOJIS / PRAISE / GREETINGS (🔥 ❤️ "zo'r", "salom", "class", "beautiful", "krasivo"):
- Reply warmly and naturally — a witty one-liner that acknowledges their energy.
- DO NOT include the booking link. Ever.
- These replies should feel like a genuine human reacting, not a business pushing bookings.

NEGATIVE COMMENTS ("qimmat", "yomon", "ploxo", "dorogo", complaints):
- Acknowledge with empathy. Do not argue or deflect.
- Invite to resolve via DM: "DMga yozing, hal qilamiz" or equivalent.
- DO NOT include the booking link.

SPAM / IRRELEVANT ("Follow me", "Check my page", promotions from other accounts):
- Do not reply. Return exactly: __SKIP__`;

        // Critical preservation rules
        systemPrompt += `

RULES:
- IMPORTANT: The post caption may contain time-relative words like "ertaga", "bugun", "завтра". These were relative to when the post was PUBLISHED, NOT today. Compare "Post published" date with "Today" date. If the post is old, do NOT repeat those time references — they are outdated.
- Never invent promotions, discounts, or events that are not currently happening.
- No hashtags. No "How can I help?". No self-introductions.
- Vary your wording — never repeat the exact same reply twice.`;

        // ── Section 4.5a — RETURNING COMMENTER (PERS-03 + PERS-04) ──────────
        if (commenterHistory && commenterHistory.comment_count >= 2) {
            const count = commenterHistory.comment_count;
            const warmthHint = count >= 4
                ? 'They are a loyal regular — be noticeably warm.'
                : 'They have commented before — a subtle nod is enough.';
            systemPrompt += `\n\nRETURNING COMMENTER:\nThis person has commented ${count} time${count !== 1 ? 's' : ''} before.\n${warmthHint}\nAbout 1 in 3 times, briefly acknowledge their return ("Yana keldingiz!", "Sog'indik sizni!" or equivalent). Not every reply — keep it natural, not programmatic.\nDo NOT quote or reference their previous comment text.\n\nIf their comment expresses genuine praise, curiosity, or experience-sharing, consider ending with a service-related question ("Qaysi uslubni yoqtirasiz?", "Sizga ham sinab ko'rmoqchimisiz?" or equivalent). Use your judgment — only when it feels conversational.`;
        }

        // ── Section 4.5b — POST TYPE (QUAL-03 + QUAL-04) ────────────────────
        if (postCaption) {
            systemPrompt += `\n\nPOST TYPE:\nDetermine the post type from the caption keywords and adapt your reply tone:\n- PROMO (aksiya, chegirma, discount, sale, skidka): use urgency language ("Hozir band bo'ling!", "Taklifdan foydalaning!")\n- BEFORE/AFTER (oldin/keyin, result, natija, transformation): celebrate the transformation ("Zo'r natija!", "Ajoyib o'zgarish!")\n- MILESTONE (anniversary, yil, oy, 1000, congratulations, yubileya): celebratory and proud ("Tabriklaymiz!", "Katta yutuq!")\n- GENERAL (everything else): standard warm persona — no special tone shift needed.`;
        }

        // ── Section 4.5c — RECENT REPLIES (QUAL-01 + QUAL-02) ───────────────
        if (postReplies && postReplies.recent_replies && postReplies.recent_replies.length > 0) {
            const recentTexts = postReplies.recent_replies
                .slice(0, 5)
                .map((r, i) => `${i + 1}. "${r.text}"`)
                .join('\n');
            systemPrompt += `\n\nRECENT REPLIES ON THIS POST — DO NOT REPEAT:\n${recentTexts}\nDo NOT start your reply with the same word as any reply above. Vary your opening and phrasing.`;
        }

        // ── Section 5: Example replies ────────────────────────────────────────
        if (aiExampleReplies) {
            systemPrompt += `\n\nEXAMPLE REPLIES (match this style):\n${aiExampleReplies}`;
        } else {
            systemPrompt += `

EXAMPLE REPLIES (match this style and tone):
Uzbek:
- "Rahmat! Har doim xush kelibsiz" (reaction to praise)
- "Albatta, DMga yozing — batafsil aytaman" (to a question)
- "Sizni kutamiz!" (warm sign-off)${bookingLink ? `\n- "Ha, hozir joylar bor. Yozilish: ${bookingLink}" (booking intent)` : ''}
Russian:
- "Спасибо! Всегда рады видеть вас" (reaction to praise)
- "Конечно, пишите в DM — всё расскажу" (to a question)
- "Ждём вас!" (warm sign-off)${bookingLink ? `\n- "Да, места есть. Записаться можно тут: ${bookingLink}" (booking intent)` : ''}`;
        }

        // ── Section 6: Owner overrides ────────────────────────────────────────
        if (aiInstructions) {
            systemPrompt += `\n\nADDITIONAL OWNER INSTRUCTIONS:\n${aiInstructions}`;
        }
    }

    return systemPrompt;
}

/**
 * Fetch commenter history from Firestore.
 * Returns null if no document exists, the document is expired, or Firestore fails.
 * Graceful degradation — never throws.
 *
 * @param {string} businessId
 * @param {string|number} igUserId
 * @returns {Promise<object|null>}
 */
export async function getCommenterHistory(businessId, igUserId) {
    try {
        const snap = await db
            .collection('businesses').doc(businessId)
            .collection('commenters').doc(String(igUserId))
            .get();
        if (!snap.exists) return null;
        const data = snap.data();
        if (data.expires_at && data.expires_at.toDate() < new Date()) return null;
        return data;
    } catch (e) {
        console.warn(`Instagram webhook: getCommenterHistory failed for ${igUserId}:`, e.message);
        return null;
    }
}

/**
 * Fetch post reply log from Firestore.
 * Returns null if no document exists, the document is expired, or Firestore fails.
 * Graceful degradation — never throws.
 *
 * @param {string} businessId
 * @param {string|number} mediaId
 * @returns {Promise<object|null>}
 */
export async function getPostReplies(businessId, mediaId) {
    try {
        const snap = await db
            .collection('businesses').doc(businessId)
            .collection('instagram_post_replies').doc(String(mediaId))
            .get();
        if (!snap.exists) return null;
        const data = snap.data();
        if (data.expires_at && data.expires_at.toDate() < new Date()) return null;
        return data;
    } catch (e) {
        console.warn(`Instagram webhook: getPostReplies failed for ${mediaId}:`, e.message);
        return null;
    }
}

/**
 * Write/update commenter history in Firestore after a reply is sent.
 * Uses merge: true so first_seen_at is preserved on subsequent writes.
 * Fire-and-forget safe — catches all errors and logs a warning.
 *
 * @param {string} businessId
 * @param {string|number} igCommenterId
 * @param {string} username
 * @param {string} commentText
 */
export async function updateCommenterHistory(businessId, igCommenterId, username, commentText) {
    try {
        await db
            .collection('businesses').doc(businessId)
            .collection('commenters').doc(String(igCommenterId))
            .set({
                username,
                comment_count: FieldValue.increment(1),
                last_seen_at: Timestamp.now(),
                last_comment_text: commentText,
                first_seen_at: Timestamp.now(),
                expires_at: Timestamp.fromDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)),
            }, { merge: true });
    } catch (e) {
        console.warn(`Instagram webhook: updateCommenterHistory failed for ${igCommenterId}:`, e.message);
    }
}

/**
 * Append a reply to the post's recent_replies log in Firestore.
 * Caps at 8 entries (oldest dropped). Sets a 30-day TTL.
 * Fire-and-forget safe — catches all errors and logs a warning.
 *
 * @param {string} businessId
 * @param {string|number} mediaId
 * @param {string} replyText
 */
export async function updatePostReplies(businessId, mediaId, replyText) {
    try {
        const ref = db
            .collection('businesses').doc(businessId)
            .collection('instagram_post_replies').doc(String(mediaId));
        const snap = await ref.get();
        const existing = snap.exists ? (snap.data().recent_replies || []) : [];
        const updated = [...existing, { text: replyText, at: Timestamp.now() }].slice(-8);
        await ref.set({
            recent_replies: updated,
            expires_at: Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
        }, { merge: true });
    } catch (e) {
        console.warn(`Instagram webhook: updatePostReplies failed for ${mediaId}:`, e.message);
    }
}

/**
 * Handle an incoming Instagram comment event.
 * Auto-replies with the configured template if all conditions are met.
 *
 * Checks (in order):
 * 1. Skip replies (parent_id present) to avoid infinite loops
 * 2. Skip if missing media.id or comment id
 * 3. Find matching business instagram_connection by ig_user_id
 * 4. Skip if no connection found
 * 5. Skip if connection is inactive
 * 6. Skip if reply_template is empty
 * 7. Skip if the post is older than the connection date
 * 8. Skip if already replied (dedup)
 * 9. Build reply message and send
 *
 * @param {string} igUserId - The Instagram user ID that owns the account
 * @param {object} commentData - The comment change value from Meta's webhook payload
 */
async function handleCommentEvent(igUserId, commentData) {
    try {
        console.log(`Instagram webhook: processing event for IG user ${igUserId}`, JSON.stringify(commentData));

        const commentId = commentData.id;
        const mediaId = commentData.media?.id;
        const parentId = commentData.parent_id;

        // 1. Skip replies to avoid infinite loops
        if (parentId) {
            console.log(`Instagram webhook: skipping reply (parent_id: ${parentId})`);
            return;
        }

        // 2. Skip if missing required IDs
        if (!mediaId || !commentId) {
            console.log(`Instagram webhook: missing IDs — mediaId: ${mediaId}, commentId: ${commentId}`);
            return;
        }

        // 3. Find business connection by ig_user_id
        const connectionSnapshot = await db
            .collectionGroup('instagram_connection')
            .where('ig_user_id', '==', String(igUserId))
            .limit(1)
            .get();

        // 4. Skip if no connection found
        if (connectionSnapshot.empty) {
            console.log(`Instagram webhook: no connection found for IG user ${igUserId} (type: ${typeof igUserId})`);
            return;
        }

        const connectionDoc = connectionSnapshot.docs[0];
        const connection = connectionDoc.data();
        console.log(`Instagram webhook: found connection for @${connection.ig_username}, active: ${connection.is_active}, template: "${connection.reply_template}"`);

        // 5. Check per-post settings first, then fall back to global
        const businessId = connectionDoc.ref.parent.parent.id;
        const postSettingsDoc = await db.collection('businesses').doc(businessId)
            .collection('instagram_post_settings').doc(mediaId).get();

        let replyMode;
        let replyTemplate;
        let postAiInstructions;
        let usingPostSettings = false;

        if (postSettingsDoc.exists) {
            const postSettings = postSettingsDoc.data();
            if (!postSettings.is_active) {
                // Post has custom settings but auto-reply is disabled — skip entirely
                console.log(`Instagram webhook: skipping — auto-reply disabled for media ${mediaId}`);
                return;
            }
            // Use per-post custom settings (overrides global is_active)
            replyMode = postSettings.reply_mode;
            replyTemplate = postSettings.reply_template || '';
            postAiInstructions = postSettings.ai_instructions || '';
            usingPostSettings = true;
            console.log(`Instagram webhook: using per-post settings for media ${mediaId} (mode: ${replyMode})`);
        } else {
            // No post settings — use global connection settings
            if (!connection.is_active) {
                console.log('Instagram webhook: skipping — connection inactive and no post-level override');
                return;
            }
            replyMode = connection.reply_mode || 'static';
            replyTemplate = connection.reply_template || '';
            postAiInstructions = '';
        }

        // 6. Skip if no content configured for the active mode
        if (replyMode === 'static' && !replyTemplate.trim()) {
            console.log('Instagram webhook: skipping — reply_template empty');
            return;
        }
        if (replyMode === 'ai' && !openai) {
            console.log('Instagram webhook: skipping — OpenAI not configured');
            return;
        }

        // Decrypt access token
        const accessToken = decrypt(connection.access_token);

        // 7. Dedup — skip if already replied
        const alreadyReplied = await hasExistingReply(commentId, igUserId, accessToken);
        if (alreadyReplied) {
            console.log(`Instagram webhook: skipping — already replied to comment ${commentId}`);
            return;
        }

        // 8. Build reply message
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        const tenantUrl = businessDoc.exists ? businessDoc.data().tenant_url : null;
        const bookingLink = tenantUrl ? `https://${tenantUrl}` : '';

        // Extract commenter identifiers before mode branch — needed by both AI and static paths
        // for history writes after replyToComment() succeeds.
        const igCommenterId = commentData.from?.id || '';
        const username = commentData.from?.username || '';
        const commentText = commentData.text || '';

        let replyMessage;

        if (replyMode === 'ai') {
            // AI-generated reply — build detailed business context
            const businessData = businessDoc.exists ? businessDoc.data() : {};
            const [businessInfo, commenterHistory, postReplies] = await Promise.all([
                buildBusinessInfo(businessId, businessData, bookingLink),
                igCommenterId ? getCommenterHistory(businessId, igCommenterId) : Promise.resolve(null),
                getPostReplies(businessId, mediaId),
            ]);

            // Fetch post caption and timestamp for context
            let postCaption = '';
            let postTime = '';
            try {
                const media = await getMediaDetails(mediaId, accessToken);
                if (media?.caption) postCaption = media.caption;
                if (media?.timestamp) {
                    postTime = new Date(media.timestamp).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', dateStyle: 'medium', timeStyle: 'short' });
                }
            } catch (e) {
                console.log(`Instagram webhook: could not fetch post caption for media ${mediaId}`);
            }

            const tashkentNow = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' });
            const d = new Date(tashkentNow);
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const now = `${days[d.getDay()]}, ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

            const isSolo = businessData.is_solo === true;
            const systemPrompt = buildSystemPrompt({
                businessInfo,
                isSolo,
                bookingLink,
                username,
                postCaption,
                postTime,
                postAiInstructions: usingPostSettings ? postAiInstructions : '',
                aiInstructions: connection.ai_instructions || '',
                aiExampleReplies: connection.ai_example_replies || '',
                now,
                commenterHistory,
                postReplies,
            });

            const aiResponse = await openai.chat.completions.create({
                model: 'gpt-4.1-mini',
                temperature: 0.9,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: commentText },
                ],
            });
            replyMessage = (aiResponse.choices[0]?.message?.content || '').trim();

            // Skip spam/irrelevant comments or empty responses
            if (!replyMessage || replyMessage === '__SKIP__' || replyMessage.includes('__SKIP__')) {
                console.log(`Instagram webhook: AI skipped comment ${commentId} (empty or spam)`);
                return;
            }

            console.log(`Instagram webhook: AI generated reply for comment ${commentId}: "${replyMessage}"`);
        } else {
            // Static template reply (uses per-post template if available, otherwise global)
            replyMessage = replyTemplate;
            if (bookingLink) {
                replyMessage = replyMessage.replace(/\{link\}/g, bookingLink);
            }
        }

        // 9. Send reply
        await replyToComment(commentId, replyMessage, accessToken);
        console.log(`Instagram webhook: replied to comment ${commentId} for business ${businessId} (mode: ${replyMode}, post-settings: ${usingPostSettings})`);

        // History writes — fire-and-forget, must not delay webhook response
        if (igCommenterId) {
            Promise.all([
                updateCommenterHistory(businessId, igCommenterId, username, commentText),
                updatePostReplies(businessId, mediaId, replyMessage),
            ]).catch(e => console.warn('History write failed:', e.message));
        }

        // 10. Notify admin group
        if (ADMIN_GROUP_ID) {
            const commenter = commentData.from?.username || commentData.from?.id || 'unknown';
            const modeLabel = replyMode === 'ai' ? 'AI' : 'Template';
            const adminMsg =
                `📸 <b>Instagram auto-reply (${modeLabel})</b>\n\n` +
                `👤 <b>Comment by:</b> @${commenter}\n` +
                `💬 <b>Comment:</b> ${commentText}\n` +
                `↩️ <b>Reply:</b> ${replyMessage}\n` +
                `🏢 <b>Account:</b> @${connection.ig_username}`;
            sendTelegramMessage(ADMIN_GROUP_ID, adminMsg).catch(() => {});
        }
    } catch (error) {
        console.error('Instagram webhook: error handling comment event:', error);
        // Never throw — webhook must not fail
    }
}

/**
 * Build detailed business info string for AI system prompt.
 * Parallelizes Firestore reads for services and employees.
 */
async function buildBusinessInfo(businessId, businessData, bookingLink) {
    const lines = [];

    // 1. Business name
    lines.push(`Business: ${businessData.business_name || 'Unknown'}`);

    // 2. Bio
    if (businessData.bio) lines.push(`About: ${businessData.bio}`);

    // 3. Address with Google Maps link
    if (businessData.location) {
        const { lat, lng } = businessData.location;
        if (lat && lng) {
            lines.push(`Location: https://www.google.com/maps?q=${lat},${lng}`);
        }
    }

    // 4. Working hours
    if (businessData.working_hours) {
        const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const hourLines = [];
        for (const day of dayNames) {
            const h = businessData.working_hours[day];
            if (!h) continue;
            if (!h.is_open) {
                hourLines.push(`  ${day}: closed`);
            } else {
                hourLines.push(`  ${day}: ${formatTime(h.start)} - ${formatTime(h.end)}`);
            }
        }
        if (hourLines.length) {
            lines.push(`Working hours:\n${hourLines.join('\n')}`);
        }
    }

    // 5 & 6. Services and employees — parallel reads (2 round trips instead of sequential)
    const [servicesSnap, employeesSnap] = await Promise.all([
        db.collection('businesses').doc(businessId)
            .collection('services').where('is_active', '==', true).get(),
        db.collection('businesses').doc(businessId)
            .collection('employees').where('is_accepted', '==', true).get(),
    ]);

    if (!servicesSnap.empty) {
        const serviceLines = [];
        for (const doc of servicesSnap.docs) {
            const s = doc.data();
            const name = s.name?.uz || s.name?.ru || 'Service';
            serviceLines.push(`  - ${name}: ${s.price} so'm, ${s.duration_minutes} min`);
        }
        lines.push(`Services:\n${serviceLines.join('\n')}`);
    }

    if (!employeesSnap.empty) {
        // Fetch all employee services in parallel
        const empServiceSnaps = await Promise.all(
            employeesSnap.docs.map(empDoc =>
                db.collection('businesses').doc(businessId)
                    .collection('employees').doc(empDoc.id)
                    .collection('employeeServices').where('is_active', '==', true).get()
            )
        );

        const empLines = [];
        employeesSnap.docs.forEach((empDoc, i) => {
            const emp = empDoc.data();
            const empName = emp.phone_number || 'Employee';
            const position = emp.position || '';
            let line = `  - ${position}${empName !== 'Employee' ? ` (${empName})` : ''}`;

            const empServicesSnap = empServiceSnaps[i];
            if (!empServicesSnap.empty) {
                const svcNames = [];
                for (const esDoc of empServicesSnap.docs) {
                    const es = esDoc.data();
                    // Find matching business service name
                    const matchingService = servicesSnap.docs.find(d => d.id === es.service_id);
                    const svcName = matchingService ? (matchingService.data().name?.uz || matchingService.data().name?.ru || 'Service') : 'Service';
                    svcNames.push(`${svcName} (${es.price} so'm, ${es.duration_minutes} min)`);
                }
                line += `: ${svcNames.join(', ')}`;
            }
            empLines.push(line);
        });
        lines.push(`Team:\n${empLines.join('\n')}`);
    }

    // 7. Booking link
    if (bookingLink) lines.push(`Online booking: ${bookingLink}`);

    return lines.join('\n');
}

/**
 * Convert seconds from midnight to HH:MM string.
 */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default router;
