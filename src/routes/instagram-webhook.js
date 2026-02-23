import { Router } from 'express';
import { db } from '../db/db.js';
import {
    verifyWebhookSignature,
    replyToComment,
    getMediaDetails,
    hasExistingReply,
} from '../utils/instagram.js';
import { sendTelegramMessage } from '../utils/telegram.js';

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
 * MUST respond 200 immediately to prevent Meta from retrying.
 */
router.post('/', (req, res) => {
    // Always respond 200 immediately to avoid Meta retries
    res.status(200).send('EVENT_RECEIVED');

    // Verify signature
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhookSignature(rawBody, signature)) {
        console.warn('Instagram webhook: invalid signature');
        return;
    }

    const body = req.body;

    if (body.object !== 'instagram') {
        return;
    }

    // Process each entry
    if (Array.isArray(body.entry)) {
        for (const entry of body.entry) {
            const igUserId = entry.id;

            if (Array.isArray(entry.changes)) {
                for (const change of entry.changes) {
                    if (change.field === 'comments') {
                        // Fire and forget — errors are caught inside handleCommentEvent
                        handleCommentEvent(igUserId, change.value);
                    }
                }
            }
        }
    }
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
        const commentId = commentData.id;
        const mediaId = commentData.media?.id;
        const parentId = commentData.parent_id;

        // 1. Skip replies to avoid infinite loops
        if (parentId) {
            return;
        }

        // 2. Skip if missing required IDs
        if (!mediaId || !commentId) {
            return;
        }

        // 3. Find business connection by ig_user_id
        const connectionSnapshot = await db
            .collectionGroup('instagram_connection')
            .where('ig_user_id', '==', igUserId)
            .limit(1)
            .get();

        // 4. Skip if no connection found
        if (connectionSnapshot.empty) {
            console.log(`Instagram webhook: no connection found for IG user ${igUserId}`);
            return;
        }

        const connectionDoc = connectionSnapshot.docs[0];
        const connection = connectionDoc.data();

        // 5. Skip if connection is inactive
        if (!connection.is_active) {
            return;
        }

        // 6. Skip if reply_template is empty/blank
        if (!connection.reply_template || !connection.reply_template.trim()) {
            return;
        }

        // 7. Check post timestamp vs connection date — skip if post is older
        const mediaDetails = await getMediaDetails(mediaId, connection.access_token);
        if (mediaDetails && mediaDetails.timestamp) {
            const postDate = new Date(mediaDetails.timestamp);
            const connectedAt = connection.connected_at?.toDate
                ? connection.connected_at.toDate()
                : new Date(connection.connected_at);

            if (postDate < connectedAt) {
                return;
            }
        }

        // 8. Dedup — skip if already replied
        const alreadyReplied = await hasExistingReply(commentId, igUserId, connection.access_token);
        if (alreadyReplied) {
            return;
        }

        // 9. Build reply message
        // connectionDoc path: businesses/{businessId}/instagram_connection/connection
        const businessId = connectionDoc.ref.parent.parent.id;
        const businessDoc = await db.collection('businesses').doc(businessId).get();

        let replyMessage = connection.reply_template;

        if (businessDoc.exists) {
            const tenantUrl = businessDoc.data().tenant_url;
            if (tenantUrl) {
                replyMessage = replyMessage.replace(/\{link\}/g, `https://${tenantUrl}`);
            }
        }

        // 10. Send reply
        await replyToComment(commentId, replyMessage, connection.access_token);
        console.log(`Instagram webhook: replied to comment ${commentId} for business ${businessId}`);

        // 11. Notify admin group
        if (ADMIN_GROUP_ID) {
            const commenter = commentData.from?.username || commentData.from?.id || 'unknown';
            const commentText = commentData.text || '';
            const adminMsg =
                `📸 <b>Instagram auto-reply</b>\n\n` +
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

export default router;
