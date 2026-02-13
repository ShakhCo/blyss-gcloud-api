import { Router } from 'express';
import { db } from '../db/db.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Get notifications for authenticated user
router.get('/', authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection('notifications')
            .where('phone_number', '==', req.user.phone_number)
            .orderBy('created_at', 'desc')
            .get();

        const notifications = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                title: data.title,
                description: data.description,
                type: data.type,
                phone_number: data.phone_number,
                is_viewed: data.is_viewed ?? false,
                viewed_at: data.viewed_at ?? null,
                created_at: data.created_at?.toDate?.().toISOString() || data.created_at
            };
        });

        res.json(notifications);
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Get unread count
router.get('/unread-count', authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection('notifications')
            .where('phone_number', '==', req.user.phone_number)
            .where('is_viewed', '==', false)
            .count()
            .get();

        res.json({ count: snapshot.data().count });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Mark all as viewed
router.post('/mark-all-viewed', authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection('notifications')
            .where('phone_number', '==', req.user.phone_number)
            .where('is_viewed', '==', false)
            .get();

        const now = new Date();
        const batch = db.batch();

        snapshot.docs.forEach(doc => {
            batch.update(doc.ref, {
                is_viewed: true,
                viewed_at: now
            });
        });

        await batch.commit();

        res.json({ message: 'All notifications marked as viewed' });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Mark notification as viewed
router.post('/:id/view', authenticate, async (req, res) => {
    try {
        const doc = await db.collection('notifications').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Notification not found', error_code: 'NOT_FOUND' });
        }

        const data = doc.data();

        // Verify ownership
        if (data.phone_number !== req.user.phone_number) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const now = new Date();
        await doc.ref.update({
            is_viewed: true,
            viewed_at: now
        });

        res.json({
            id: doc.id,
            is_viewed: true,
            viewed_at: now.toISOString()
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Delete notification
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const doc = await db.collection('notifications').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Notification not found', error_code: 'NOT_FOUND' });
        }

        const data = doc.data();

        // Verify ownership
        if (data.phone_number !== req.user.phone_number) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        await doc.ref.delete();
        res.status(204).send();
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
