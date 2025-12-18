import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { businessOwnerSchema, businessOwnerResponseSchema } from '../schemas/businessOwner.js';

const router = Router();

// Get all business owners
router.get('/', async (req, res) => {
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
            is_verified: false
        });

        res.status(201).json(businessOwnerResponseSchema.parse({
            id: ownerId,
            first_name,
            last_name,
            phone_number,
            telegram_id: telegram_id ?? null,
            date_created: dateCreated.toISOString(),
            is_verified: false
        }));
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
