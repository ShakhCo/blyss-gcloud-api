import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { businessSchema, createBusinessSchema, updateBusinessSchema, businessResponseSchema } from '../schemas/business.js';
import { serviceSchema } from '../schemas/service.js';
import { employeeSchema } from '../schemas/employee.js';
import { sendBusinessInvitationNotification, sendBusinessRemovalNotification } from '../utils/telegram.js';

const router = Router();

/**
 * Generate a tenant URL from business name (without creating DNS record)
 * @param {string} businessName - The business name
 * @param {string} businessId - The unique business ID
 * @returns {string} - The generated URL
 */
function generateTenantUrl(businessName, businessId) {
    const zoneDomain = process.env.CLOUDFLARE_ZONE_DOMAIN || 'blyss.uz';

    // Generate a clean subdomain from business name
    const subdomain = businessName
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
        .trim()
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Remove duplicate hyphens
        .substring(0, 50) || businessId; // Fallback to business ID if empty

    return `${subdomain}.${zoneDomain}`;
}

// Get businesses for authenticated user
router.get('/', authenticate, async (req, res) => {
    try {
        // Only business_owners can have businesses
        if (req.user.user_type !== 'business_owner') {
            return res.status(403).json({
                error: 'Only business owners can access businesses',
                error_code: 'FORBIDDEN'
            });
        }

        const snapshot = await db.collection('businesses')
            .where('business_owner_id', '==', req.user.id)
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
                tenant_url: data.tenant_url || null,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            };
        });
        res.json(businesses);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get business by ID
router.get('/:id', authenticate, async (req, res) => {
    try {
        const doc = await db.collection('businesses').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        const data = doc.data();

        // Verify ownership
        if (data.business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

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
            tenant_url: data.tenant_url || null,
            employee_invite_token: data.employee_invite_token || null,
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
                tenant_url: data.tenant_url || null,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            };
        });
        res.json(businesses);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Create business
router.post('/', authenticate, validate(createBusinessSchema), async (req, res) => {
    try {
        // Only business_owners can create businesses
        if (req.user.user_type !== 'business_owner') {
            return res.status(403).json({
                error: 'Only business owners can create businesses',
                error_code: 'FORBIDDEN'
            });
        }

        const {
            business_name,
            business_type,
            location,
            working_graphic_type,
            working_hours,
            business_phone_number
        } = req.validated;

        const business_owner_id = req.user.id;

        // Generate unique 16 character ID
        let businessId;
        let businessExists = true;
        while (businessExists) {
            businessId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('businesses').doc(businessId).get();
            businessExists = existingDoc.exists;
        }

        const dateCreated = new Date();

        // Generate tenant URL (without creating DNS record)
        const tenantUrl = generateTenantUrl(business_name, businessId);

        // Generate employee invite token
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let employeeInviteToken = '';
        for (let i = 0; i < 7; i++) {
            employeeInviteToken += chars.charAt(Math.floor(Math.random() * chars.length));
        }

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
            tenant_url: tenantUrl,
            employee_invite_token: employeeInviteToken,
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
router.put('/:id', authenticate, validate(updateBusinessSchema), async (req, res) => {
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
            business_phone_number
        } = req.validated;

        const currentData = doc.data();

        // Verify ownership
        if (currentData.business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const updateData = {
            business_name,
            business_type,
            location,
            working_graphic_type,
            working_hours: working_hours || null,
            business_phone_number
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
            business_owner_id: currentData.business_owner_id,
            business_status: currentData.business_status,
            tenant_url: currentData.tenant_url,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete business
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const docRef = db.collection('businesses').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        const currentData = doc.data();

        // Verify ownership
        if (currentData.business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        await docRef.delete();
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update tenant URL
router.patch('/:id/tenant-url', authenticate, async (req, res) => {
    try {
        const { tenant_url } = req.body;

        if (!tenant_url) {
            return res.status(400).json({ error: 'tenant_url is required', error_code: 'MISSING_TENANT_URL' });
        }

        const docRef = db.collection('businesses').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        const currentData = doc.data();

        // Verify ownership
        if (currentData.business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // Update only tenant_url
        await docRef.update({ tenant_url });

        res.json({
            id: req.params.id,
            tenant_url
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update business name
router.patch('/:id/name', authenticate, async (req, res) => {
    try {
        const { business_name } = req.body;

        if (!business_name) {
            return res.status(400).json({ error: 'business_name is required', error_code: 'MISSING_BUSINESS_NAME' });
        }

        const docRef = db.collection('businesses').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }

        const currentData = doc.data();

        // Verify ownership
        if (currentData.business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // Update only business_name
        await docRef.update({ business_name });

        res.json({
            id: req.params.id,
            business_name
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// ==================== SERVICES ROUTES ====================

// Get all services for a business
router.get('/:id/services', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const snapshot = await db.collection('businesses')
            .doc(req.params.id)
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

// Get a specific service
router.get('/:id/services/:serviceId', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        const data = serviceDoc.data();
        res.json({
            id: serviceDoc.id,
            business_id: req.params.id,
            ...data,
            date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
            is_active: data.is_active ?? false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Create a service
router.post('/:id/services', authenticate, validate(serviceSchema), async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const { name, price, duration_minutes } = req.validated;

        // Generate unique 16 character ID
        let serviceId;
        let serviceExists = true;
        while (serviceExists) {
            serviceId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('businesses')
                .doc(req.params.id)
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
            .doc(req.params.id)
            .collection('services')
            .doc(serviceId)
            .set(serviceData);

        res.status(201).json({
            id: serviceId,
            business_id: req.params.id,
            ...serviceData,
            date_created: dateCreated.toISOString(),
            is_active: false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update a service
router.put('/:id/services/:serviceId', authenticate, validate(serviceSchema), async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        const { name, price, duration_minutes } = req.validated;

        const updateData = {
            name,
            price,
            duration_minutes
        };

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .update(updateData);

        const currentData = serviceDoc.data();

        res.json({
            id: req.params.serviceId,
            business_id: req.params.id,
            ...updateData,
            date_created: currentData.date_created?.toDate?.().toISOString() || currentData.date_created,
            is_active: currentData.is_active ?? false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete a service
router.delete('/:id/services/:serviceId', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .delete();

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Activate a service
router.post('/:id/services/:serviceId/activate', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .update({ is_active: true });

        const currentData = serviceDoc.data();

        res.json({
            id: req.params.serviceId,
            business_id: req.params.id,
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

// Deactivate a service
router.post('/:id/services/:serviceId/deactivate', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const serviceDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .get();

        if (!serviceDoc.exists) {
            return res.status(404).json({ error: 'Service not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .update({ is_active: false });

        const currentData = serviceDoc.data();

        res.json({
            id: req.params.serviceId,
            business_id: req.params.id,
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

// ==================== EMPLOYEES ROUTES ====================

// Get all employees for a business
router.get('/:id/employees', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const snapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .get();

        const employees = snapshot.docs.map((doc) => {
            const data = doc.data();

            return {
                id: doc.id,
                phone_number: data.phone_number,
                position: data.position ?? '',
                availability_type: data.availability_type ?? 'flexible',
                working_hours: data.working_hours ?? null,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
                is_accepted: data.is_accepted ?? false,
                date_accepted: data.date_accepted ?? null,
                is_rejected: data.is_rejected ?? false
            };
        });

        // Sort: authenticated user (if employee) first, then by date_created
        employees.sort((a, b) => {
            const aIsSelf = a.phone_number === req.user.phone_number;
            const bIsSelf = b.phone_number === req.user.phone_number;

            if (aIsSelf && !bIsSelf) return -1;
            if (!aIsSelf && bIsSelf) return 1;

            // If both or neither are self, sort by date_created
            return new Date(a.date_created) - new Date(b.date_created);
        });

        res.json(employees);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Add employee to business
router.post('/:id/employees', authenticate, validate(employeeSchema), async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const { phone_number, position } = req.validated;

        // Check if employee with this phone number already exists
        const existingSnapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .where('phone_number', '==', phone_number)
            .limit(1)
            .get();

        if (!existingSnapshot.empty) {
            return res.status(409).json({ error: 'Already an employee', error_code: 'ALREADY_EMPLOYEE' });
        }

        // Generate unique 16 character ID
        let employeeId;
        let employeeExists = true;
        while (employeeExists) {
            employeeId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(employeeId)
                .get();
            employeeExists = existingDoc.exists;
        }

        const dateCreated = new Date();

        const businessData = businessDoc.data();

        // Map working_graphic_type to availability_type
        // on_demand -> flexible, fixed_hours -> fixed
        const availabilityType = businessData.working_graphic_type === 'on_demand' ? 'flexible' : 'fixed';

        // If adding yourself as employee, auto-accept
        const isSelf = phone_number === req.user.phone_number;

        const employeeData = {
            phone_number,
            position,
            availability_type: availabilityType,
            working_hours: availabilityType === 'flexible' ? null : (businessData.working_hours || null),
            date_created: dateCreated,
            is_accepted: isSelf,
            date_accepted: isSelf ? dateCreated : null,
            is_rejected: false
        };

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .doc(employeeId)
            .set(employeeData);

        // Check if phone number is a registered business owner with telegram_id
        // Skip notification if adding yourself
        if (!isSelf) {
            const businessOwnerSnapshot = await db.collection('business_owners')
                .where('phone_number', '==', phone_number)
                .limit(1)
                .get();

            if (!businessOwnerSnapshot.empty) {
                const businessOwner = businessOwnerSnapshot.docs[0].data();
                if (businessOwner.telegram_id) {
                    // Send Telegram notification
                    try {
                        await sendBusinessInvitationNotification(businessOwner.telegram_id, businessData.business_name, businessData.business_type, position);
                    } catch (telegramError) {
                        console.error('Failed to send Telegram notification:', telegramError);
                        // Don't fail the request if Telegram notification fails
                    }
                }
            }
        }

        res.status(201).json({
            id: employeeId,
            phone_number,
            position,
            availability_type: availabilityType,
            working_hours: employeeData.working_hours,
            date_created: dateCreated.toISOString(),
            is_accepted: employeeData.is_accepted,
            date_accepted: employeeData.date_accepted?.toISOString() || null,
            is_rejected: employeeData.is_rejected
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete employee from business
router.delete('/:id/employees/:employeeId', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // employeeId is the unique employee document ID
        const employeeDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .doc(req.params.employeeId)
            .get();

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'NOT_FOUND' });
        }

        const employee = employeeDoc.data();

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .doc(req.params.employeeId)
            .delete();

        // Send Telegram notification to the employee if they have a telegram_id
        // Skip notification if removing yourself
        if (employee.phone_number !== req.user.phone_number) {
            const businessOwnerSnapshot = await db.collection('businesses_owners')
                .where('phone_number', '==', employee.phone_number)
                .limit(1)
                .get();

            if (!businessOwnerSnapshot.empty) {
                const businessOwner = businessOwnerSnapshot.docs[0].data();
                if (businessOwner.telegram_id) {
                    try {
                        await sendBusinessRemovalNotification(businessOwner.telegram_id, businessDoc.data().business_name);
                    } catch (telegramError) {
                        console.error('Failed to send Telegram notification:', telegramError);
                    }
                }
            }
        }

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Generate/regenerate employee invite token
router.post('/:id/employee-invite-token', authenticate, async (req, res) => {
    try {
        const businessDoc = await db.collection('businesses').doc(req.params.id).get();

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        // Generate 7 character alphanumeric token
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let token = '';
        for (let i = 0; i < 7; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        // Update business document
        await db.collection('businesses').doc(req.params.id).update({
            employee_invite_token: token
        });

        res.json({
            employee_invite_token: token
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Join business using employee invite token
router.post('/join/:token', authenticate, async (req, res) => {
    try {
        // Find business by employee_invite_token
        const businessesSnapshot = await db.collection('businesses')
            .where('employee_invite_token', '==', req.params.token)
            .limit(1)
            .get();

        if (businessesSnapshot.empty) {
            return res.status(404).json({
                error: 'Invalid invite token',
                error_code: 'INVALID_TOKEN'
            });
        }

        const businessDoc = businessesSnapshot.docs[0];
        const businessData = businessDoc.data();
        const businessId = businessDoc.id;

        // Check if already an employee
        const existingEmployee = await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .where('phone_number', '==', req.user.phone_number)
            .limit(1)
            .get();

        if (!existingEmployee.empty) {
            return res.status(409).json({
                error: 'Already an employee of this business',
                error_code: 'ALREADY_EMPLOYEE'
            });
        }

        // Generate unique employee ID
        let employeeId;
        let employeeExists = true;
        while (employeeExists) {
            employeeId = crypto.randomBytes(8).toString('hex');
            const existingDoc = await db.collection('businesses')
                .doc(businessId)
                .collection('employees')
                .doc(employeeId)
                .get();
            employeeExists = existingDoc.exists;
        }

        const dateCreated = new Date();

        // Create employee record
        const employeeData = {
            phone_number: req.user.phone_number,
            date_created: dateCreated,
            is_accepted: false,
            date_accepted: null
        };

        await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .doc(employeeId)
            .set(employeeData);

        // Send Telegram notification
        try {
            await sendBusinessInvitationNotification(req.user.telegram_id, businessData.business_name, businessData.business_type, '');
        } catch (telegramError) {
            console.error('Failed to send Telegram notification:', telegramError);
        }

        res.status(201).json({
            id: employeeId,
            business_id: businessId,
            business_name: businessData.business_name,
            phone_number: req.user.phone_number,
            date_created: dateCreated.toISOString(),
            is_accepted: false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
