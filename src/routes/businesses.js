import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { businessSchema, businessResponseSchema } from '../schemas/business.js';
import { suggestAndCreateSubdomain, getCloudflareConfig } from '../utils/cloudflare.js';

const router = Router();

// Get all businesses
router.get('/', async (req, res) => {
    try {
        const snapshot = await db.collection('businesses').get();
        const businesses = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                business_name: data.business_name,
                business_type: data.business_type,
                location: data.location,
                working_graphic_type: data.working_graphic_type,
                working_hours: data.working_hours,
                business_phone_number: data.business_phone_number,
                business_owner_id: data.business_owner_id,
                business_status: data.business_status,
                marketplace_website_url: data.marketplace_website_url || null,
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
            business_name: data.business_name,
            business_type: data.business_type,
            location: data.location,
            working_graphic_type: data.working_graphic_type,
            working_hours: data.working_hours,
            business_phone_number: data.business_phone_number,
            business_owner_id: data.business_owner_id,
            business_status: data.business_status,
            marketplace_website_url: data.marketplace_website_url || null,
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
                business_name: data.business_name,
                business_type: data.business_type,
                location: data.location,
                working_graphic_type: data.working_graphic_type,
                working_hours: data.working_hours,
                business_phone_number: data.business_phone_number,
                business_owner_id: data.business_owner_id,
                business_status: data.business_status,
                marketplace_website_url: data.marketplace_website_url || null,
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
            business_type,
            location,
            working_graphic_type,
            working_hours,
            business_phone_number,
            business_owner_id
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

        // Create subdomain via Cloudflare DNS
        let marketplaceWebsiteUrl = null;
        try {
            const cloudflareConfig = getCloudflareConfig();
            const subdomainResult = await suggestAndCreateSubdomain(
                business_name,
                businessId,
                cloudflareConfig.serverIp,
                cloudflareConfig
            );
            marketplaceWebsiteUrl = subdomainResult.fullUrl;
        } catch (dnsError) {
            console.error('Failed to create DNS record:', dnsError);
            // Continue with business creation even if DNS fails
            // marketplace_website_url will remain null
        }

        const dateCreated = new Date();

        // Create business
        const businessData = {
            business_name,
            business_type,
            location,
            working_graphic_type,
            working_hours: working_hours || null,
            business_phone_number,
            business_owner_id,
            business_status: 'unverified',
            marketplace_website_url: marketplaceWebsiteUrl,
            date_created: dateCreated
        };

        await db.collection('businesses').doc(businessId).set(businessData);

        res.status(201).json({
            id: businessId,
            ...businessData,
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
            business_type,
            location,
            working_graphic_type,
            working_hours,
            business_phone_number,
            business_owner_id
        } = req.validated;

        const currentData = doc.data();

        // Verify business owner exists if changing owner
        if (business_owner_id !== currentData.business_owner_id) {
            const ownerDoc = await db.collection('business_owners').doc(business_owner_id).get();
            if (!ownerDoc.exists) {
                return res.status(404).json({ error: 'Business owner not found', error_code: 'OWNER_NOT_FOUND' });
            }
        }

        const updateData = {
            business_name,
            business_type,
            location,
            working_graphic_type,
            working_hours: working_hours || null,
            business_phone_number,
            business_owner_id
        };

        await docRef.update(updateData);

        res.json({
            id: req.params.id,
            business_name: updateData.business_name,
            business_type: updateData.business_type,
            location: updateData.location,
            working_graphic_type: updateData.working_graphic_type,
            working_hours: updateData.working_hours,
            business_phone_number: updateData.business_phone_number,
            business_owner_id: updateData.business_owner_id,
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
