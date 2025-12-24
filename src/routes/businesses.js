import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { businessSchema, businessResponseSchema } from '../schemas/business.js';

const router = Router();

// Helper to format business images for response
const formatImages = (images) => {
    return (images || []).map(img => ({
        source: img.source,
        photo_reference: img.photo_reference,
        url: img.source === 'place_id_photo'
            ? `/places/photo/${img.photo_reference}`
            : img.url || null,
        is_primary: img.is_primary
    }));
};

// Get all businesses
router.get('/', async (req, res) => {
    try {
        const snapshot = await db.collection('businesses').get();
        const businesses = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                business_images: formatImages(data.business_images),
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            };
        });
        res.json(businesses);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get business by ID
router.get('/:id', async (req, res) => {
    try {
        const doc = await db.collection('businesses').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        const data = doc.data();
        res.json({
            id: doc.id,
            ...data,
            business_images: formatImages(data.business_images),
            date_created: data.date_created?.toDate?.().toISOString() || data.date_created
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get businesses by owner ID
router.get('/owner/:ownerId', async (req, res) => {
    try {
        // Verify owner exists
        const ownerDoc = await db.collection('business_owners').doc(req.params.ownerId).get();
        if (!ownerDoc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'OWNER_NOT_FOUND' });
        }

        const snapshot = await db.collection('businesses')
            .where('business_owner_id', '==', req.params.ownerId)
            .get();

        const businesses = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                business_images: formatImages(data.business_images),
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            };
        });
        res.json(businesses);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Create business
router.post('/', validate(businessSchema), async (req, res) => {
    try {
        const {
            business_name,
            business_phone_number,
            business_owner_id,
            business_address,
            business_images,
            business_hours,
            place_id
        } = req.validated;

        // Verify business owner exists
        const ownerDoc = await db.collection('business_owners').doc(business_owner_id).get();
        if (!ownerDoc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'OWNER_NOT_FOUND' });
        }

        // Generate unique 16 character ID
        let businessId;
        let businessExists = true;
        while (businessExists) {
            businessId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('businesses').doc(businessId).get();
            businessExists = existingDoc.exists;
        }

        const dateCreated = new Date();

        // Process images - store base64 data or photo_reference
        const processedImages = business_images.map(img => ({
            source: img.source,
            photo_reference: img.photo_reference || null,
            url: img.source === 'local_upload' ? img.data : null, // Store base64 as url for local uploads
            is_primary: img.is_primary
        }));

        // Create business
        const businessData = {
            business_name,
            business_phone_number,
            business_owner_id,
            business_address,
            business_images: processedImages,
            business_hours,
            place_id: place_id || null,
            business_status: 'unverified',
            date_created: dateCreated
        };

        await db.collection('businesses').doc(businessId).set(businessData);

        res.status(201).json({
            id: businessId,
            ...businessData,
            business_images: formatImages(processedImages),
            date_created: dateCreated.toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update business
router.put('/:id', validate(businessSchema), async (req, res) => {
    try {
        const docRef = db.collection('businesses').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        const {
            business_name,
            business_phone_number,
            business_owner_id,
            business_address,
            business_images,
            business_hours,
            place_id
        } = req.validated;

        const currentData = doc.data();

        // Verify business owner exists if changing owner
        if (business_owner_id !== currentData.business_owner_id) {
            const ownerDoc = await db.collection('business_owners').doc(business_owner_id).get();
            if (!ownerDoc.exists) {
                return res.status(404).json({ error: 'Business owner not found', error_code: 'OWNER_NOT_FOUND' });
            }
        }

        // Process images
        const processedImages = business_images.map(img => ({
            source: img.source,
            photo_reference: img.photo_reference || null,
            url: img.source === 'local_upload' ? img.data : null,
            is_primary: img.is_primary
        }));

        const updateData = {
            business_name,
            business_phone_number,
            business_owner_id,
            business_address,
            business_images: processedImages,
            business_hours,
            place_id: place_id || null
        };

        await docRef.update(updateData);

        res.json({
            id: req.params.id,
            ...updateData,
            business_images: formatImages(processedImages),
            business_status: currentData.business_status,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete business
router.delete('/:id', async (req, res) => {
    try {
        const docRef = db.collection('businesses').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        await docRef.delete();
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
