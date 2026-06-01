import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { businessOwnerSchema, businessOwnerResponseSchema, profileUpdateSchema } from '../schemas/businessOwner.js';

const router = Router();

// Protected: requires authentication
router.get('/', authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection('business_owners').get();
        const businessOwners = snapshot.docs.map(doc => {
            const data = doc.data();
            return businessOwnerResponseSchema.parse({
                id: doc.id,
                ...data,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            });
        });
        res.json(businessOwners);
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Search business owners by phone number or name
router.get('/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.trim().length === 0) {
            return res.status(400).json({ error: 'Search query is required', error_code: 'INVALID_QUERY' });
        }

        const query = q.trim().toLowerCase();

        // Get all business owners and filter
        const snapshot = await db.collection('business_owners').get();
        const businessOwners = snapshot.docs
            .map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    date_created: data.date_created?.toDate?.().toISOString() || data.date_created
                };
            })
            .filter(owner => {
                const fullName = `${owner.first_name} ${owner.last_name}`.toLowerCase();
                return owner.phone_number.includes(query) || fullName.includes(query);
            })
            .map(owner => businessOwnerResponseSchema.parse(owner));

        res.json(businessOwners);
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Get business owner by ID
router.get('/:id', async (req, res) => {
    try {
        const doc = await db.collection('business_owners').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'NOT_FOUND' });
        }

        const data = doc.data();
        res.json(businessOwnerResponseSchema.parse({
            id: doc.id,
            ...data,
            date_created: data.date_created?.toDate?.().toISOString() || data.date_created
        }));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Create business owner
router.post('/register', validate(businessOwnerSchema), async (req, res) => {
    try {
        const { first_name, last_name, phone_number, telegram_id } = req.validated;

        // Check phone_number uniqueness
        const existingOwner = await db.collection('business_owners')
            .where('phone_number', '==', phone_number)
            .get();

        if (!existingOwner.empty) {
            return res.status(409).json({ error: 'Phone number already exists', error_code: 'PHONE_EXISTS' });
        }

        // Generate unique 16 character ID
        let ownerId;
        let ownerExists = true;
        while (ownerExists) {
            ownerId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('business_owners').doc(ownerId).get();
            ownerExists = existingDoc.exists;
        }

        const dateCreated = new Date();

        // Create business owner
        await db.collection('business_owners').doc(ownerId).set({
            first_name,
            last_name,
            phone_number,
            telegram_id: telegram_id ?? null,
            date_created: dateCreated,
            is_verified: false,
            balance: 0
        });

        res.status(201).json(businessOwnerResponseSchema.parse({
            id: ownerId,
            first_name,
            last_name,
            phone_number,
            telegram_id: telegram_id ?? null,
            date_created: dateCreated.toISOString(),
            is_verified: false,
            balance: 0
        }));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Update authenticated user's profile (first_name, last_name only)
router.patch('/profile', authenticate, validate(profileUpdateSchema), async (req, res) => {
    try {
        const { first_name, last_name } = req.validated;

        const docRef = db.collection('business_owners').doc(req.user.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'NOT_FOUND' });
        }

        const currentData = doc.data();

        await docRef.update({
            first_name,
            last_name
        });

        res.json({
            first_name,
            last_name
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Update business owner
router.put('/:id', validate(businessOwnerSchema), async (req, res) => {
    try {
        const docRef = db.collection('business_owners').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'NOT_FOUND' });
        }

        const { first_name, last_name, phone_number, telegram_id } = req.validated;
        const currentData = doc.data();

        // Check phone_number uniqueness if it's being changed
        if (phone_number !== currentData.phone_number) {
            const existingOwner = await db.collection('business_owners')
                .where('phone_number', '==', phone_number)
                .get();

            if (!existingOwner.empty) {
                return res.status(409).json({ error: 'Phone number already exists', error_code: 'PHONE_EXISTS' });
            }
        }

        await docRef.update({
            first_name,
            last_name,
            phone_number,
            telegram_id: telegram_id ?? null
        });

        res.json(businessOwnerResponseSchema.parse({
            id: req.params.id,
            first_name,
            last_name,
            phone_number,
            telegram_id: telegram_id ?? null,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created,
            is_verified: currentData.is_verified
        }));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Delete business owner
router.delete('/:id', async (req, res) => {
    try {
        const docRef = db.collection('business_owners').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'NOT_FOUND' });
        }

        await docRef.delete();
        res.status(204).send();
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
