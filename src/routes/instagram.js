import { Router } from 'express';
import { db } from '../db/db.js';
import { authenticate, verifySignature } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { instagramAuthSchema, instagramSettingsSchema } from '../schemas/instagram.js';
import { getOAuthUrl, exchangeCodeForToken, getInstagramProfile } from '../utils/instagram.js';
import { encrypt } from '../utils/encryption.js';

const router = Router();

/**
 * GET /oauth-url/:businessId
 * Returns the Meta OAuth URL for Instagram authorization
 */
router.get('/oauth-url/:businessId', verifySignature, authenticate, async (req, res) => {
    try {
        const { businessId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const oauth_url = getOAuthUrl(businessId);

        res.json({ oauth_url });
    } catch (error) {
        console.error('Error generating OAuth URL:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /auth
 * Exchange OAuth code for token and store Instagram connection
 */
router.post('/auth', validate(instagramAuthSchema), async (req, res) => {
    try {
        const { code, business_id } = req.validated;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(business_id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        // Check if already connected
        const connectionRef = db.collection('businesses').doc(business_id)
            .collection('instagram_connection').doc('connection');
        const connectionDoc = await connectionRef.get();

        if (connectionDoc.exists) {
            return res.status(409).json({ error: 'Instagram already connected', error_code: 'ALREADY_CONNECTED' });
        }

        // Exchange code for long-lived token
        const { access_token, user_id } = await exchangeCodeForToken(code);

        // Get Instagram profile info
        const { ig_user_id, ig_username } = await getInstagramProfile(access_token, user_id);

        // Store connection document
        const now = new Date();
        const connectionData = {
            ig_user_id,
            ig_username,
            access_token: encrypt(access_token),
            connected_at: now,
            is_active: true,
            reply_template: '',
            updated_at: now,
        };

        await connectionRef.set(connectionData);

        res.json({
            connected: true,
            ig_username,
            is_active: true,
            reply_template: '',
            connected_at: now,
        });
    } catch (error) {
        console.error('Error connecting Instagram:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * DELETE /auth/:businessId
 * Disconnect Instagram from a business
 */
router.delete('/auth/:businessId', verifySignature, authenticate, async (req, res) => {
    try {
        const { businessId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // Delete connection document
        await db.collection('businesses').doc(businessId)
            .collection('instagram_connection').doc('connection').delete();

        res.json({ disconnected: true });
    } catch (error) {
        console.error('Error disconnecting Instagram:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * GET /status/:businessId
 * Get Instagram connection status for a business
 */
router.get('/status/:businessId', verifySignature, authenticate, async (req, res) => {
    try {
        const { businessId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // Get connection document
        const connectionDoc = await db.collection('businesses').doc(businessId)
            .collection('instagram_connection').doc('connection').get();

        if (!connectionDoc.exists) {
            return res.json({ connected: false });
        }

        const data = connectionDoc.data();

        res.json({
            connected: true,
            ig_username: data.ig_username,
            is_active: data.is_active,
            reply_template: data.reply_template,
            connected_at: data.connected_at,
        });
    } catch (error) {
        console.error('Error getting Instagram status:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * PATCH /settings/:businessId
 * Update Instagram auto-reply settings
 */
router.patch('/settings/:businessId', verifySignature, authenticate, validate(instagramSettingsSchema), async (req, res) => {
    try {
        const { businessId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // Check connection exists
        const connectionRef = db.collection('businesses').doc(businessId)
            .collection('instagram_connection').doc('connection');
        const connectionDoc = await connectionRef.get();

        if (!connectionDoc.exists) {
            return res.status(404).json({ error: 'Instagram not connected', error_code: 'NOT_CONNECTED' });
        }

        // Build update object from validated fields
        const updateData = { updated_at: new Date() };
        const { is_active, reply_template } = req.validated;

        if (is_active !== undefined) {
            updateData.is_active = is_active;
        }
        if (reply_template !== undefined) {
            updateData.reply_template = reply_template;
        }

        await connectionRef.update(updateData);

        // Return updated state
        const updatedDoc = await connectionRef.get();
        const data = updatedDoc.data();

        res.json({
            connected: true,
            ig_username: data.ig_username,
            is_active: data.is_active,
            reply_template: data.reply_template,
        });
    } catch (error) {
        console.error('Error updating Instagram settings:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
