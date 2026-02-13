import { Router } from 'express';
import { db } from '../db/db.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router({ mergeParams: true });

/**
 * POST /businesses/:businessId/conversations
 * Save user message. Creates conversation if doesn't exist.
 * Requires signature verification (applied at router level).
 */
router.post('/', async (req, res) => {
    try {
        const { businessId } = req.params;
        const { telegram_id, first_name, last_name, message_text } = req.body;

        // Validate required fields
        if (!telegram_id || !message_text) {
            return res.status(400).json({
                error: 'telegram_id and message_text are required',
                error_code: 'VALIDATION_ERROR'
            });
        }

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const now = new Date();
        const conversationRef = db
            .collection('businesses')
            .doc(businessId)
            .collection('customer_conversations')
            .doc(telegram_id);

        // Check if conversation exists
        const conversationDoc = await conversationRef.get();

        if (!conversationDoc.exists) {
            // Create new conversation
            await conversationRef.set({
                telegram_id,
                first_name: first_name || null,
                last_name: last_name || null,
                created_at: now,
                last_message_at: now
            });
        } else {
            // Update last_message_at
            await conversationRef.update({
                last_message_at: now,
                // Update name if provided (user might change their Telegram name)
                ...(first_name !== undefined && { first_name }),
                ...(last_name !== undefined && { last_name })
            });
        }

        // Add message to subcollection
        const messageRef = await conversationRef.collection('messages').add({
            sender_type: 'user',
            sender_id: null,
            sender_name: first_name || 'User',
            text: message_text,
            created_at: now
        });

        res.status(201).json({
            conversation_id: telegram_id,
            message_id: messageRef.id,
            created_at: now.toISOString()
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /businesses/:businessId/conversations/:telegramId/ai-reply
 * Save AI-generated reply. Called by Python bot after generating response.
 * Requires signature verification (applied at router level).
 */
router.post('/:telegramId/ai-reply', async (req, res) => {
    try {
        const { businessId, telegramId } = req.params;
        const { message_text } = req.body;

        // Validate required fields
        if (!message_text) {
            return res.status(400).json({
                error: 'message_text is required',
                error_code: 'VALIDATION_ERROR'
            });
        }

        const conversationRef = db
            .collection('businesses')
            .doc(businessId)
            .collection('customer_conversations')
            .doc(telegramId);

        // Verify conversation exists
        const conversationDoc = await conversationRef.get();
        if (!conversationDoc.exists) {
            return res.status(404).json({
                error: 'Conversation not found',
                error_code: 'CONVERSATION_NOT_FOUND'
            });
        }

        const now = new Date();

        // Update last_message_at
        await conversationRef.update({
            last_message_at: now
        });

        // Add AI message to subcollection
        const messageRef = await conversationRef.collection('messages').add({
            sender_type: 'ai',
            sender_id: null,
            sender_name: 'AI Assistant',
            text: message_text,
            created_at: now
        });

        res.status(201).json({
            message_id: messageRef.id,
            created_at: now.toISOString()
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * GET /businesses/:businessId/conversations/:telegramId/messages
 * Get message history for AI context. Python bot calls this before generating AI reply.
 * Requires signature verification (applied at router level).
 */
router.get('/:telegramId/messages', async (req, res) => {
    try {
        const { businessId, telegramId } = req.params;
        const limit = parseInt(req.query.limit) || 20;

        const conversationRef = db
            .collection('businesses')
            .doc(businessId)
            .collection('customer_conversations')
            .doc(telegramId);

        // Get conversation
        const conversationDoc = await conversationRef.get();
        if (!conversationDoc.exists) {
            return res.status(404).json({
                error: 'Conversation not found',
                error_code: 'CONVERSATION_NOT_FOUND'
            });
        }

        const conversationData = conversationDoc.data();

        // Get messages ordered by created_at, limited
        const messagesSnapshot = await conversationRef
            .collection('messages')
            .orderBy('created_at', 'desc')
            .limit(limit)
            .get();

        // Reverse to get chronological order
        const messages = messagesSnapshot.docs.reverse().map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                sender_type: data.sender_type,
                sender_name: data.sender_name,
                text: data.text,
                created_at: data.created_at?.toDate?.().toISOString() || data.created_at
            };
        });

        res.json({
            conversation: {
                telegram_id: conversationData.telegram_id,
                first_name: conversationData.first_name,
                last_name: conversationData.last_name
            },
            messages
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * GET /businesses/:businessId/conversations
 * List all conversations for business dashboard.
 * Requires JWT authentication.
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const { businessId } = req.params;

        // Verify business exists and user has access
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const businessData = businessDoc.data();

        // Check if user is the business owner
        if (businessData.business_owner_id !== req.user.id) {
            // Check if user is an employee of this business
            const employeeSnapshot = await db
                .collection('businesses')
                .doc(businessId)
                .collection('employees')
                .where('business_owner_id', '==', req.user.id)
                .where('is_accepted', '==', true)
                .limit(1)
                .get();

            if (employeeSnapshot.empty) {
                return res.status(403).json({
                    error: 'Access denied',
                    error_code: 'ACCESS_DENIED'
                });
            }
        }

        // Get all conversations ordered by last_message_at
        const conversationsSnapshot = await db
            .collection('businesses')
            .doc(businessId)
            .collection('customer_conversations')
            .orderBy('last_message_at', 'desc')
            .get();

        const conversations = conversationsSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                telegram_id: data.telegram_id,
                first_name: data.first_name,
                last_name: data.last_name,
                last_message_at: data.last_message_at?.toDate?.().toISOString() || data.last_message_at
            };
        });

        res.json(conversations);
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /businesses/:businessId/conversations/:telegramId/reply
 * Owner or staff sends reply from dashboard.
 * Requires JWT authentication.
 */
router.post('/:telegramId/reply', authenticate, async (req, res) => {
    try {
        const { businessId, telegramId } = req.params;
        const { message_text } = req.body;

        // Validate required fields
        if (!message_text) {
            return res.status(400).json({
                error: 'message_text is required',
                error_code: 'VALIDATION_ERROR'
            });
        }

        // Verify business exists and user has access
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const businessData = businessDoc.data();
        let senderType = 'staff';
        let senderId = req.user.id;
        let senderName = req.user.first_name || 'Staff';

        // Check if user is the business owner
        if (businessData.business_owner_id === req.user.id) {
            senderType = 'business_owner';
            senderName = req.user.first_name || 'Business Owner';
        } else {
            // Check if user is an employee of this business
            const employeeSnapshot = await db
                .collection('businesses')
                .doc(businessId)
                .collection('employees')
                .where('business_owner_id', '==', req.user.id)
                .where('is_accepted', '==', true)
                .limit(1)
                .get();

            if (employeeSnapshot.empty) {
                return res.status(403).json({
                    error: 'Access denied',
                    error_code: 'ACCESS_DENIED'
                });
            }
        }

        const conversationRef = db
            .collection('businesses')
            .doc(businessId)
            .collection('customer_conversations')
            .doc(telegramId);

        // Verify conversation exists
        const conversationDoc = await conversationRef.get();
        if (!conversationDoc.exists) {
            return res.status(404).json({
                error: 'Conversation not found',
                error_code: 'CONVERSATION_NOT_FOUND'
            });
        }

        const now = new Date();

        // Update last_message_at
        await conversationRef.update({
            last_message_at: now
        });

        // Add message to subcollection
        const messageRef = await conversationRef.collection('messages').add({
            sender_type: senderType,
            sender_id: senderId,
            sender_name: senderName,
            text: message_text,
            created_at: now
        });

        res.status(201).json({
            message_id: messageRef.id,
            sender_type: senderType,
            created_at: now.toISOString()
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
