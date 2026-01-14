import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { serviceSchema } from '../schemas/service.js';

const router = Router();

// Get all services for a business
router.get('/business/:businessId', async (req, res) => {
    try {
        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(req.params.businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        const snapshot = await db.collection('businesses')
            .doc(req.params.businessId)
            .collection('services')
            .get();

        const services = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
                is_active: data.is_active ?? false
            };
        });
        res.json(services);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get service by ID
router.get('/:id', async (req, res) => {
    try {
        // Query across all business service subcollections
        const businessesSnapshot = await db.collection('businesses').get();

        let service = null;
        let businessId = null;

        for (const businessDoc of businessesSnapshot.docs) {
            const serviceDoc = await db.collection('businesses')
                .doc(businessDoc.id)
                .collection('services')
                .doc(req.params.id)
                .get();

            if (serviceDoc.exists) {
                service = serviceDoc;
                businessId = businessDoc.id;
                break;
            }
        }

        if (!service) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        const data = service.data();
        res.json({
            id: service.id,
            business_id: businessId,
            ...data,
            date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
            is_active: data.is_active ?? false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Create service for a business
router.post('/business/:businessId', validate(serviceSchema), async (req, res) => {
    try {
        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(req.params.businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        const { name, price, duration_minutes } = req.validated;

        // Generate unique 16 character ID
        let serviceId;
        let serviceExists = true;
        while (serviceExists) {
            serviceId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('businesses')
                .doc(req.params.businessId)
                .collection('services')
                .doc(serviceId)
                .get();
            serviceExists = existingDoc.exists;
        }

        const dateCreated = new Date();

        const serviceData = {
            name,
            price,
            duration_minutes,
            is_active: false,
            date_created: dateCreated
        };

        await db.collection('businesses')
            .doc(req.params.businessId)
            .collection('services')
            .doc(serviceId)
            .set(serviceData);

        res.status(201).json({
            id: serviceId,
            business_id: req.params.businessId,
            ...serviceData,
            date_created: dateCreated.toISOString(),
            is_active: false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update service
router.put('/:id', validate(serviceSchema), async (req, res) => {
    try {
        const { name, price, duration_minutes } = req.validated;

        // Query across all business service subcollections
        const businessesSnapshot = await db.collection('businesses').get();

        let serviceDoc = null;
        let businessId = null;

        for (const businessDoc of businessesSnapshot.docs) {
            const doc = await db.collection('businesses')
                .doc(businessDoc.id)
                .collection('services')
                .doc(req.params.id)
                .get();

            if (doc.exists) {
                serviceDoc = doc;
                businessId = businessDoc.id;
                break;
            }
        }

        if (!serviceDoc) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        const updateData = {
            name,
            price,
            duration_minutes
        };

        await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .doc(req.params.id)
            .update(updateData);

        const currentData = serviceDoc.data();

        res.json({
            id: req.params.id,
            business_id: businessId,
            ...updateData,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created,
            is_active: currentData.is_active ?? false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Activate service
router.post('/business/:businessId/services/:id/activate', async (req, res) => {
    try {
        const { businessId, id: serviceId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .doc(serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .doc(serviceId)
            .update({ is_active: true });

        const currentData = serviceDoc.data();

        res.json({
            id: serviceId,
            business_id: businessId,
            name: currentData.name,
            price: currentData.price,
            duration_minutes: currentData.duration_minutes,
            is_active: true,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Deactivate service
router.post('/business/:businessId/services/:id/deactivate', async (req, res) => {
    try {
        const { businessId, id: serviceId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .doc(serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .doc(serviceId)
            .update({ is_active: false });

        const currentData = serviceDoc.data();

        res.json({
            id: serviceId,
            business_id: businessId,
            name: currentData.name,
            price: currentData.price,
            duration_minutes: currentData.duration_minutes,
            is_active: false,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete service
router.delete('/:id', async (req, res) => {
    try {
        // Query across all business service subcollections
        const businessesSnapshot = await db.collection('businesses').get();

        let serviceDoc = null;
        let businessId = null;

        for (const businessDoc of businessesSnapshot.docs) {
            const doc = await db.collection('businesses')
                .doc(businessDoc.id)
                .collection('services')
                .doc(req.params.id)
                .get();

            if (doc.exists) {
                serviceDoc = doc;
                businessId = businessDoc.id;
                break;
            }
        }

        if (!serviceDoc) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .doc(req.params.id)
            .delete();

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
