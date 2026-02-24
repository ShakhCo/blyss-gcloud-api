import { Router } from 'express';
import OpenAI from 'openai';
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

        // 5. Skip if connection is inactive
        if (!connection.is_active) {
            console.log('Instagram webhook: skipping — connection inactive');
            return;
        }

        // 6. Determine reply mode (default: static for backward compat)
        const replyMode = connection.reply_mode || 'static';

        // 6a. Skip if no content configured for the active mode
        if (replyMode === 'static' && (!connection.reply_template || !connection.reply_template.trim())) {
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
        const businessId = connectionDoc.ref.parent.parent.id;
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        const tenantUrl = businessDoc.exists ? businessDoc.data().tenant_url : null;
        const bookingLink = tenantUrl ? `https://${tenantUrl}` : '';

        let replyMessage;

        if (replyMode === 'ai') {
            // AI-generated reply — build detailed business context
            const commentText = commentData.text || '';
            const businessData = businessDoc.exists ? businessDoc.data() : {};
            const businessInfo = await buildBusinessInfo(businessId, businessData, bookingLink);

            // Fetch post caption for context
            let postCaption = '';
            try {
                const media = await getMediaDetails(mediaId, accessToken);
                if (media?.caption) postCaption = media.caption;
            } catch (e) {
                console.log(`Instagram webhook: could not fetch post caption for media ${mediaId}`);
            }

            let systemPrompt = `You are replying to Instagram post comments on behalf of a business. This is a PUBLIC COMMENT SECTION, NOT a private chat or DM.`;
            systemPrompt += `\n\n${businessInfo}`;
            if (postCaption) {
                systemPrompt += `\n\nPost caption (the post where this comment was written):\n"${postCaption}"`;
            }
            systemPrompt += `\n\nThere are TWO types of comments. Reply differently for each:

TYPE 1 — Questions (about prices, services, hours, location, booking):
- Answer the question using the business info above.
- Keep it short but informative (1-2 sentences).
- Include the booking link if relevant.
- Example: "Soch turish 50 000 so'm, 30 daqiqa. Bron qiling: ${bookingLink} 😊"

TYPE 2 — Reactions, emojis, greetings, compliments (🔥, ❤️, "Salom", "Beautiful", "Zo'r"):
- Thank them warmly and always include the booking link to drive engagement.
- Examples: "Izohingiz uchun rahmat! ☺️ Bron qiling: ${bookingLink}", "Raxmat sizga! 🙏 Yoziling: ${bookingLink}", "Спасибо! 🤍 Записывайтесь: ${bookingLink}"

General rules:
- This is an Instagram comment section, NOT a chat. Keep replies short and natural.
- NEVER ask "how can I help?" — that's chat behavior.
- NEVER introduce yourself or the business unprompted.
- Reply in the same language as the comment.
- No hashtags. Use 1-2 emojis naturally.
- Sound like a real person, not a bot.
- Use the post caption as context to make your reply more relevant.`;

            const aiResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: commentText },
                ],
                max_tokens: 200,
            });
            replyMessage = aiResponse.choices[0].message.content.trim();
            console.log(`Instagram webhook: AI generated reply for comment ${commentId}: "${replyMessage}"`);
        } else {
            // Static template reply
            replyMessage = connection.reply_template;
            if (bookingLink) {
                replyMessage = replyMessage.replace(/\{link\}/g, bookingLink);
            }
        }

        // 9. Send reply
        await replyToComment(commentId, replyMessage, accessToken);
        console.log(`Instagram webhook: replied to comment ${commentId} for business ${businessId} (mode: ${replyMode})`);

        // 10. Notify admin group
        if (ADMIN_GROUP_ID) {
            const commenter = commentData.from?.username || commentData.from?.id || 'unknown';
            const commentText = commentData.text || '';
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

    // 5. Services
    const servicesSnap = await db.collection('businesses').doc(businessId)
        .collection('services').where('is_active', '==', true).get();
    if (!servicesSnap.empty) {
        const serviceLines = [];
        for (const doc of servicesSnap.docs) {
            const s = doc.data();
            const name = s.name?.uz || s.name?.ru || 'Service';
            serviceLines.push(`  - ${name}: ${s.price} so'm, ${s.duration_minutes} min`);
        }
        lines.push(`Services:\n${serviceLines.join('\n')}`);
    }

    // 6. Employees with their services
    const employeesSnap = await db.collection('businesses').doc(businessId)
        .collection('employees').where('is_accepted', '==', true).get();
    if (!employeesSnap.empty) {
        const empLines = [];
        for (const empDoc of employeesSnap.docs) {
            const emp = empDoc.data();
            const empName = emp.phone_number || 'Employee';
            const position = emp.position || '';
            let line = `  - ${position}${empName !== 'Employee' ? ` (${empName})` : ''}`;

            // Get employee's services
            const empServicesSnap = await db.collection('businesses').doc(businessId)
                .collection('employees').doc(empDoc.id)
                .collection('employeeServices').where('is_active', '==', true).get();
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
        }
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
