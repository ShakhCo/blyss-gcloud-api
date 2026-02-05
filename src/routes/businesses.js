import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { uploadSingle } from '../config/multer.js';
import { businessSchema, createBusinessSchema, updateBusinessSchema, businessResponseSchema, updateWorkingHoursSchema } from '../schemas/business.js';
import { serviceSchema } from '../schemas/service.js';
import { employeeSchema, updateEmployeeWorkingHoursSchema, updateEmployeeIsOpenNowSchema, updateEmployeeSlotCapacitySchema } from '../schemas/employee.js';
import { employeeServiceSchema, addEmployeeServicesSchema, updateEmployeeServiceSchema } from '../schemas/employeeService.js';
import { sendBusinessInvitationSms } from '../utils/eskiz.js';
import { sendBusinessInvitationNotification, sendBusinessRemovalNotification } from '../utils/telegram.js';
import { uploadFile, deleteFile, getFilenameFromUrl } from '../utils/storage.js';

const router = Router();

/**
 * Check if employee is currently open based on working hours
 * @param {string|null} availabilityType - 'flexible' or 'fixed'
 * @param {object} workingHours - Working hours object with day names as keys
 * @returns {boolean} - true if currently open, false otherwise
 */
function isEmployeeOpenNow(availabilityType, workingHours) {
    // If flexible, always considered open
    if (availabilityType === 'flexible' || !workingHours) {
        return true;
    }

    const now = new Date();
    // Convert to Uzbekistan timezone (GMT+5)
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const uzbekNow = new Date(utcNow + (5 * 3600000)); // GMT+5

    const currentDay = uzbekNow.getDay(); // 0 = Sunday, 6 = Saturday
    const currentSeconds = uzbekNow.getHours() * 3600 + uzbekNow.getMinutes() * 60 + uzbekNow.getSeconds();

    // Day number to day name mapping
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = dayNames[currentDay];

    const todayHours = workingHours[todayName];

    // If today is not open, return false
    if (!todayHours || !todayHours.is_open) {
        return false;
    }

    return currentSeconds >= todayHours.start && currentSeconds <= todayHours.end;
}

/**
 * Check if business is currently open based on working hours
 * @param {object} workingHours - Working hours object with day names as keys
 * @returns {boolean} - true if currently open, false otherwise
 */
function isBusinessOpenNow(workingHours) {
    if (!workingHours) {
        return false;
    }

    const now = new Date();
    // Convert to Uzbekistan timezone (GMT+5)
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const uzbekNow = new Date(utcNow + (5 * 3600000)); // GMT+5

    const currentDay = uzbekNow.getDay(); // 0 = Sunday, 6 = Saturday
    const currentSeconds = uzbekNow.getHours() * 3600 + uzbekNow.getMinutes() * 60 + uzbekNow.getSeconds();

    // Day number to day name mapping
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = dayNames[currentDay];

    const todayHours = workingHours[todayName];

    // If today is not open, return false
    if (!todayHours || !todayHours.is_open) {
        return false;
    }

    return currentSeconds >= todayHours.start && currentSeconds <= todayHours.end;
}

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

// Get businesses with active telegram bot (public, signature required)
router.get('/telegram-enabled', async (req, res) => {
    try {
        const snapshot = await db.collection('businesses')
            .where('telegram_bot.is_active', '==', true)
            .get();

        // Filter to only include businesses with a non-empty token
        const businesses = snapshot.docs
            .filter(doc => {
                const data = doc.data();
                return data.telegram_bot?.token;
            })
            .map(doc => {
                const data = doc.data();
                return {
                    business_id: doc.id,
                    tenant_url: data.tenant_url || null,
                    token: data.telegram_bot.token
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
            working_hours: data.working_hours,
            business_phone_number: data.business_phone_number,
            business_owner_id: data.business_owner_id,
            business_status: data.business_status,
            tenant_url: data.tenant_url || null,
            avatar_url: data.avatar_url || null,
            avatar_updated_at: data.avatar_updated_at?.toDate?.().toISOString() || data.avatar_updated_at || null,
            employee_invite_token: data.employee_invite_token || null,
            telegram_bot: data.telegram_bot || null,
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
            working_hours,
            business_phone_number,
            place_id
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
            working_hours,
            business_phone_number,
            business_owner_id,
            business_status: 'unverified',
            tenant_url: tenantUrl,
            employee_invite_token: employeeInviteToken,
            place_id,
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
            working_hours,
            business_phone_number
        };

        // Clip employee working hours to business hours range if working_hours are being updated
        let employeeUpdatePromises = [];
        if (working_hours) {
            const employeesSnapshot = await db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .get();

            for (const employeeDoc of employeesSnapshot.docs) {
                const employeeData = employeeDoc.data();
                const employeeWorkingHours = employeeData.working_hours;

                if (!employeeWorkingHours) continue;

                let needsUpdate = false;
                const updatedWorkingHours = { ...employeeWorkingHours };

                // Process each day
                for (const [dayName, businessDay] of Object.entries(working_hours)) {
                    const employeeDay = updatedWorkingHours[dayName];

                    if (!employeeDay) continue;

                    // If business day is closed, set employee day is_open to false
                    if (!businessDay.is_open && employeeDay.is_open) {
                        updatedWorkingHours[dayName] = {
                            ...employeeDay,
                            is_open: false
                        };
                        needsUpdate = true;
                    }

                    // If both business and employee day are open, clip employee hours to business hours range
                    if (businessDay.is_open && employeeDay.is_open) {
                        let dayNeedsUpdate = false;
                        const updatedDay = { ...employeeDay };

                        // Clip start time: employee start should not be earlier than business start
                        if (employeeDay.start < businessDay.start) {
                            updatedDay.start = businessDay.start;
                            dayNeedsUpdate = true;
                        }

                        // Clip end time: employee end should not be later than business end
                        if (employeeDay.end > businessDay.end) {
                            updatedDay.end = businessDay.end;
                            dayNeedsUpdate = true;
                        }

                        // If employee hours are now invalid (start >= end), close the day
                        if (updatedDay.start >= updatedDay.end) {
                            updatedDay.is_open = false;
                            dayNeedsUpdate = true;
                        }

                        if (dayNeedsUpdate) {
                            updatedWorkingHours[dayName] = updatedDay;
                            needsUpdate = true;
                        }
                    }
                }

                if (needsUpdate) {
                    employeeUpdatePromises.push(
                        employeeDoc.ref.update({
                            working_hours: updatedWorkingHours
                        })
                    );
                }
            }
        }

        await Promise.all([...employeeUpdatePromises, docRef.update(updateData)]);

        res.json({
            id: req.params.id,
            business_name: updateData.business_name,
            business_type: updateData.business_type,
            location: updateData.location,
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

        // Delete avatar from storage if exists
        if (currentData.avatar_url) {
            const filename = getFilenameFromUrl(currentData.avatar_url);
            if (filename) {
                try {
                    await deleteFile(filename);
                } catch (err) {
                    console.error('Failed to delete business avatar:', err.message);
                }
            }
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

// Update telegram bot settings
router.patch('/:id/telegram-bot', authenticate, async (req, res) => {
    try {
        const { token, is_active } = req.body;

        if (token === undefined && is_active === undefined) {
            return res.status(400).json({ error: 'At least one of token or is_active is required', error_code: 'MISSING_FIELDS' });
        }

        if (token !== undefined && typeof token !== 'string') {
            return res.status(400).json({ error: 'token must be a string', error_code: 'INVALID_TOKEN' });
        }

        if (is_active !== undefined && typeof is_active !== 'boolean') {
            return res.status(400).json({ error: 'is_active must be a boolean', error_code: 'INVALID_IS_ACTIVE' });
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

        // Build update object
        const currentTelegramBot = currentData.telegram_bot || {};
        const updatedTelegramBot = {
            token: token !== undefined ? token : (currentTelegramBot.token || null),
            is_active: is_active !== undefined ? is_active : (currentTelegramBot.is_active || false)
        };

        await docRef.update({ telegram_bot: updatedTelegramBot });

        res.json({
            id: req.params.id,
            telegram_bot: updatedTelegramBot
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update business name
router.patch('/:id/name', authenticate, async (req, res) => {
    try {
        // Debug logging
        console.log('PATCH /:id/name - Headers:', req.headers['content-type']);
        console.log('PATCH /:id/name - Body exists:', !!req.body);
        console.log('PATCH /:id/name - Raw body:', req.body);

        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({ error: 'Request body is required with Content-Type: application/json', error_code: 'NO_BODY' });
        }

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

// Update business working hours
router.patch('/:id/working-hours', authenticate, validate(updateWorkingHoursSchema), async (req, res) => {
    try {
        const { working_hours } = req.validated;

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

        // Create a set of closed days (where is_open: false)
        const closedDays = new Set();
        for (const [dayName, dayData] of Object.entries(working_hours)) {
            if (!dayData.is_open) {
                closedDays.add(dayName);
            }
        }

        // Fetch all employees for this business
        const employeesSnapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .get();

        // Update employees whose working hours need to be clipped to business hours range
        const updatePromises = [];

        for (const employeeDoc of employeesSnapshot.docs) {
            const employeeData = employeeDoc.data();
            const employeeWorkingHours = employeeData.working_hours;

            if (!employeeWorkingHours) continue;

            let needsUpdate = false;
            const updatedWorkingHours = { ...employeeWorkingHours };

            // Process each day
            for (const [dayName, businessDay] of Object.entries(working_hours)) {
                const employeeDay = updatedWorkingHours[dayName];

                if (!employeeDay) continue;

                // If business day is closed, set employee day is_open to false
                if (!businessDay.is_open && employeeDay.is_open) {
                    updatedWorkingHours[dayName] = {
                        ...employeeDay,
                        is_open: false
                    };
                    needsUpdate = true;
                }

                // If both business and employee day are open, clip employee hours to business hours range
                if (businessDay.is_open && employeeDay.is_open) {
                    let dayNeedsUpdate = false;
                    const updatedDay = { ...employeeDay };

                    // Clip start time: employee start should not be earlier than business start
                    if (employeeDay.start < businessDay.start) {
                        updatedDay.start = businessDay.start;
                        dayNeedsUpdate = true;
                    }

                    // Clip end time: employee end should not be later than business end
                    if (employeeDay.end > businessDay.end) {
                        updatedDay.end = businessDay.end;
                        dayNeedsUpdate = true;
                    }

                    // If employee hours are now invalid (start >= end), close the day
                    if (updatedDay.start >= updatedDay.end) {
                        updatedDay.is_open = false;
                        dayNeedsUpdate = true;
                    }

                    if (dayNeedsUpdate) {
                        updatedWorkingHours[dayName] = updatedDay;
                        needsUpdate = true;
                    }
                }
            }

            if (needsUpdate) {
                updatePromises.push(
                    employeeDoc.ref.update({
                        working_hours: updatedWorkingHours
                    })
                );
            }
        }

        // Execute all employee updates and business update in parallel
        await Promise.all([...updatePromises, docRef.update({ working_hours })]);

        res.json({
            id: req.params.id,
            working_hours
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Upload business avatar
router.post('/:id/avatar', authenticate, uploadSingle.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded', error_code: 'NO_FILE' });
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

        // Delete old avatar if exists
        if (currentData.avatar_url) {
            const oldFilename = getFilenameFromUrl(currentData.avatar_url);
            if (oldFilename) {
                try {
                    await deleteFile(oldFilename);
                } catch (err) {
                    // Log but don't fail if old file deletion fails
                    console.error('Failed to delete old avatar:', err.message);
                }
            }
        }

        // Generate unique filename
        const extension = req.file.mimetype.split('/')[1] || 'jpg';
        const filename = `avatars/${req.params.id}/${Date.now()}.${extension}`;

        // Upload to GCS
        const avatarUrl = await uploadFile(req.file.buffer, filename, req.file.mimetype);

        // Update business document
        await docRef.update({
            avatar_url: avatarUrl,
            avatar_updated_at: new Date()
        });

        res.json({
            id: req.params.id,
            avatar_url: avatarUrl,
            avatar_updated_at: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete business avatar
router.delete('/:id/avatar', authenticate, async (req, res) => {
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

        // Delete avatar file from GCS if exists
        if (currentData.avatar_url) {
            const filename = getFilenameFromUrl(currentData.avatar_url);
            if (filename) {
                try {
                    await deleteFile(filename);
                } catch (err) {
                    // Log but don't fail if file deletion fails
                    console.error('Failed to delete avatar file:', err.message);
                }
            }
        }

        // Remove avatar_url from business document
        await docRef.update({
            avatar_url: null,
            avatar_updated_at: new Date()
        });

        res.status(204).send();
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

        // Fetch all employees and build a map
        const employeesSnapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .get();

        const employeesMap = new Map(); // employee_id -> employee data
        employeesSnapshot.docs.forEach(doc => {
            employeesMap.set(doc.id, doc.data());
        });

        // Collect all unique business_owner_ids from accepted employees
        const businessOwnerIds = new Set();
        employeesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.business_owner_id) {
                businessOwnerIds.add(data.business_owner_id);
            }
        });

        // Fetch business owners data in parallel
        const businessOwnersMap = new Map();
        if (businessOwnerIds.size > 0) {
            const ownerPromises = Array.from(businessOwnerIds).map(async (ownerId) => {
                const ownerDoc = await db.collection('business_owners').doc(ownerId).get();
                if (ownerDoc.exists) {
                    businessOwnersMap.set(ownerId, ownerDoc.data());
                }
            });
            await Promise.all(ownerPromises);
        }

        const employeeServicesMap = new Map(); // service_id -> array of employee data

        // Fetch all employee services in parallel (batch per employee)
        const promises = employeesSnapshot.docs.map(async (employeeDoc) => {
            const employeeData = employeeDoc.data();
            const servicesSnapshot = await db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(employeeDoc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            // Get first_name and last_name from business_owners if employee is accepted
            let firstName = '';
            let lastName = '';
            if (employeeData.business_owner_id && businessOwnersMap.has(employeeData.business_owner_id)) {
                const ownerData = businessOwnersMap.get(employeeData.business_owner_id);
                firstName = ownerData.first_name || '';
                lastName = ownerData.last_name || '';
            }

            servicesSnapshot.docs.forEach(serviceDoc => {
                const serviceData = serviceDoc.data();
                if (!employeeServicesMap.has(serviceData.service_id)) {
                    employeeServicesMap.set(serviceData.service_id, []);
                }
                employeeServicesMap.get(serviceData.service_id).push({
                    price: serviceData.price,
                    duration_minutes: serviceData.duration_minutes,
                    employee_first_name: firstName,
                    employee_last_name: lastName,
                    employee_phone_number: employeeData.phone_number
                });
            });
        });

        await Promise.all(promises);

        const snapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .orderBy('date_created', 'desc')
            .get();

        const services = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
                is_active: data.is_active ?? false,
                allow_employee_customization: data.allow_employee_customization ?? true,
                employees: employeeServicesMap.get(doc.id) || []
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
            is_active: data.is_active ?? false,
            allow_employee_customization: data.allow_employee_customization ?? true
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

        const { name, price, duration_minutes, description, allow_employee_customization } = req.validated;

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
            ...(description && { description }),
            is_active: false,
            allow_employee_customization,
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

        const { name, price, duration_minutes, description, allow_employee_customization, overwrite_employees_price, overwrite_employees_duration } = req.validated;
        const currentData = serviceDoc.data();

        const updateData = {
            name,
            price,
            duration_minutes,
            allow_employee_customization,
            ...(description && { description })
        };

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .update(updateData);

        // If overwrite_employees_price or overwrite_employees_duration is true,
        // update employee services accordingly
        if (overwrite_employees_price || overwrite_employees_duration) {
            const employeeServicesSnapshot = await db.collectionGroup('employeeServices')
                .where('service_id', '==', req.params.serviceId)
                .get();

            const batch = db.batch();
            let batchHasOperations = false;

            for (const doc of employeeServicesSnapshot.docs) {
                // Path format: businesses/{businessId}/employees/{employeeId}/employeeServices/{serviceId}
                const pathParts = doc.ref.path.split('/');
                if (pathParts[1] === req.params.id) {
                    const employeeUpdateData = {};
                    if (overwrite_employees_price) {
                        employeeUpdateData.price = price;
                    }
                    if (overwrite_employees_duration) {
                        employeeUpdateData.duration_minutes = duration_minutes;
                    }
                    batch.update(doc.ref, employeeUpdateData);
                    batchHasOperations = true;
                }
            }

            if (batchHasOperations) {
                await batch.commit();
            }
        }

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

        // Delete all employee services that reference this service_id
        // Use collection group query to find all employeeServices with this service_id
        const employeeServicesSnapshot = await db.collectionGroup('employeeServices')
            .where('service_id', '==', req.params.serviceId)
            .get();

        // Filter to only employee services belonging to this business (check document path)
        const batch = db.batch();
        let batchHasOperations = false;
        for (const doc of employeeServicesSnapshot.docs) {
            // Path format: businesses/{businessId}/employees/{employeeId}/employeeServices/{serviceId}
            const pathParts = doc.ref.path.split('/');
            if (pathParts[1] === req.params.id) {
                batch.delete(doc.ref);
                batchHasOperations = true;
            }
        }
        if (batchHasOperations) {
            await batch.commit();
        }

        // Delete the business service
        await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .delete();

        res.status(204).send();
    } catch (error) {
        console.error('Delete service error:', error);
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
            allow_employee_customization: currentData.allow_employee_customization ?? true,
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
            allow_employee_customization: currentData.allow_employee_customization ?? true,
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

        // Fetch business services for name lookup
        const businessServicesSnapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .get();

        const businessServicesMap = new Map();
        businessServicesSnapshot.docs.forEach(doc => {
            businessServicesMap.set(doc.id, doc.data());
        });

        // Fetch business owner data and services for accepted employees
        const employees = await Promise.all(snapshot.docs.map(async (doc) => {
            const data = doc.data();

            let first_name = null;
            let last_name = null;
            let phone_number = data.phone_number;

            // If accepted, try to get first_name, last_name and phone_number from business_owners
            if (data.is_accepted) {
                const businessOwnerSnapshot = await db.collection('business_owners')
                    .where('phone_number', '==', data.phone_number)
                    .limit(1)
                    .get();

                if (!businessOwnerSnapshot.empty) {
                    const businessOwner = businessOwnerSnapshot.docs[0].data();
                    first_name = businessOwner.first_name || null;
                    last_name = businessOwner.last_name || null;
                    phone_number = businessOwner.phone_number || data.phone_number;
                }
            }

            // Fetch employee services
            const employeeServicesSnapshot = await db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(doc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            const services = employeeServicesSnapshot.docs.map(serviceDoc => {
                const serviceData = serviceDoc.data();
                const businessService = businessServicesMap.get(serviceData.service_id);
                return {
                    id: serviceDoc.id,
                    service_id: serviceData.service_id,
                    name: businessService?.name || null,
                    price: serviceData.price,
                    duration_minutes: serviceData.duration_minutes
                };
            });

            // Calculate is_open_now
            const availabilityType = data.availability_type ?? 'flexible';
            const workingHours = data.working_hours ?? null;

            return {
                id: doc.id,
                phone_number,
                first_name,
                last_name,
                position: data.position ?? '',
                availability_type: availabilityType,
                working_hours: workingHours,
                is_open_now: isEmployeeOpenNow(availabilityType, workingHours),
                services,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
                is_accepted: data.is_accepted ?? false,
                date_accepted: data.date_accepted ?? null,
                is_rejected: data.is_rejected ?? false
            };
        }));

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

        const { phone_number, position, availability_type, working_hours } = req.validated;

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

        // Check if phone_number is already a confirmed employee in another business
        const confirmedEmployeeSnapshot = await db.collectionGroup('employees')
            .where('phone_number', '==', phone_number)
            .where('is_accepted', '==', true)
            .limit(1)
            .get();

        if (!confirmedEmployeeSnapshot.empty) {
            return res.status(409).json({
                error: 'This phone number is already a confirmed employee in another business',
                error_code: 'ALREADY_CONFIRMED_EMPLOYEE'
            });
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

        // If adding yourself as employee, auto-accept
        const isSelf = phone_number === req.user.phone_number;

        // Ensure working_hours matches availability_type
        // For flexible: copy business hours but all days is_open: false
        // For fixed: working_hours are provided with specific open days
        let finalWorkingHours = working_hours;
        if (availability_type === 'flexible') {
            // Copy business working hours but set all days to closed
            const businessHours = businessData.working_hours || {};
            finalWorkingHours = {
                monday: { ...(businessHours.monday || { start: 0, end: 0 }), is_open: false },
                tuesday: { ...(businessHours.tuesday || { start: 0, end: 0 }), is_open: false },
                wednesday: { ...(businessHours.wednesday || { start: 0, end: 0 }), is_open: false },
                thursday: { ...(businessHours.thursday || { start: 0, end: 0 }), is_open: false },
                friday: { ...(businessHours.friday || { start: 0, end: 0 }), is_open: false },
                saturday: { ...(businessHours.saturday || { start: 0, end: 0 }), is_open: false },
                sunday: { ...(businessHours.sunday || { start: 0, end: 0 }), is_open: false }
            };
        }

        const employeeData = {
            phone_number,
            position,
            availability_type: availability_type,
            working_hours: finalWorkingHours,
            date_created: dateCreated,
            is_accepted: isSelf,
            date_accepted: isSelf ? dateCreated : null,
            is_rejected: false,
            is_open_now: false,
            business_owner_id: businessData.business_owner_id
        };

        await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .doc(employeeId)
            .set(employeeData);

        // Send SMS invitation via Eskiz
        // Skip notification if adding yourself
        if (!isSelf) {
            if (businessData.employee_invite_token) {
                // Generate invitation link
                const inviteLink = `https://blyss.uz/business/join/${businessData.employee_invite_token}`;

                // Send SMS via Eskiz service
                const smsResult = await sendBusinessInvitationSms(phone_number, businessData.business_name, inviteLink);
                if (!smsResult.success) {
                    console.error('Failed to send SMS invitation:', smsResult.error);
                }
            }

            // Check if phone number is a registered business owner with telegram_id
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
            availability_type: availability_type,
            working_hours: finalWorkingHours,
            date_created: dateCreated.toISOString(),
            is_accepted: employeeData.is_accepted,
            date_accepted: employeeData.date_accepted?.toISOString() || null,
            is_rejected: employeeData.is_rejected,
            business_owner_id: businessData.business_owner_id
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get a specific employee by ID
router.get('/:id/employees/:employeeId', authenticate, async (req, res) => {
    try {
        // Fetch business and employee in parallel
        const [businessDoc, employeeDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses').doc(req.params.id).collection('employees').doc(req.params.employeeId).get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify ownership
        if (businessDoc.data().business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        const data = employeeDoc.data();

        // Parallel queries: employee services + business services + business owner lookup
        const [employeeServicesSnapshot, businessServicesSnapshot, businessOwnerSnapshot] = await Promise.all([
            db.collection('businesses').doc(req.params.id).collection('employees').doc(req.params.employeeId).collection('employeeServices').get(),
            db.collection('businesses').doc(req.params.id).collection('services').get(),
            db.collection('business_owners').where('phone_number', '==', data.phone_number).limit(1).get()
        ]);

        // Get first_name, last_name, and business_owner_id from business_owners if found
        let first_name = null;
        let last_name = null;
        let phone_number = data.phone_number;
        let employee_business_owner_id = null;

        if (!businessOwnerSnapshot.empty) {
            const businessOwnerDoc = businessOwnerSnapshot.docs[0];
            const businessOwner = businessOwnerDoc.data();
            first_name = businessOwner.first_name || null;
            last_name = businessOwner.last_name || null;
            phone_number = businessOwner.phone_number || data.phone_number;
            employee_business_owner_id = businessOwnerDoc.id;
        }

        const employeeServices = employeeServicesSnapshot.docs.map(serviceDoc => {
            const serviceData = serviceDoc.data();
            // Get name and description from business services
            const businessService = businessServicesSnapshot.docs.find(doc => doc.id === serviceData.service_id);
            const businessServiceData = businessService?.data();
            return {
                id: serviceDoc.id,
                service_id: serviceData.service_id,
                name: businessServiceData?.name || null,
                description: businessServiceData?.description || null,
                price: serviceData.price,
                duration_minutes: serviceData.duration_minutes,
                is_active: serviceData.is_active ?? true
            };
        });

        const businessServices = businessServicesSnapshot.docs.map(doc => {
            const serviceData = doc.data();
            return {
                id: doc.id,
                name: serviceData.name,
                description: serviceData.description || null,
                price: serviceData.price,
                duration_minutes: serviceData.duration_minutes,
                is_active: serviceData.is_active ?? false,
                date_created: serviceData.date_created?.toDate?.().toISOString() || serviceData.date_created
            };
        });

        // Calculate is_open_now
        const availabilityType = data.availability_type ?? 'flexible';
        const workingHours = data.working_hours ?? null;

        res.json({
            id: employeeDoc.id,
            business_id: req.params.id,
            business_owner_id: employee_business_owner_id,
            first_name,
            last_name,
            phone_number,
            position: data.position ?? '',
            date_joined: data.date_accepted?.toDate?.().toISOString() || data.date_accepted || null,
            availability_type: availabilityType,
            working_hours: workingHours,
            is_open_now: isEmployeeOpenNow(availabilityType, workingHours),
            business_working_hours: businessDoc.data().working_hours ?? null,
            employee_services: employeeServices,
            business_services: businessServices,
            date_created: data.date_created?.toDate?.().toISOString() || data.date_created,
            is_accepted: data.is_accepted ?? false,
            is_rejected: data.is_rejected ?? false
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

// Update employee working hours
router.put('/:id/employees/:employeeId/working-hours', authenticate, validate(updateEmployeeWorkingHoursSchema), async (req, res) => {
    try {
        const [businessDoc, employeeDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        const businessData = businessDoc.data();
        const employeeData = employeeDoc.data();

        // Allow access if: business owner OR the employee themselves (accepted)
        const isBusinessOwner = businessData.business_owner_id === req.user.id;
        const isEmployee = employeeData.phone_number === req.user.phone_number && employeeData.is_accepted === true;

        if (!isBusinessOwner && !isEmployee) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const { availability_type, working_hours } = req.validated;

        // Ensure working_hours matches availability_type
        let finalWorkingHours = working_hours;
        if (availability_type === 'flexible') {
            // Get business working hours to copy
            const businessHours = businessData.working_hours || {};

            // Copy business working hours but set all days to closed
            finalWorkingHours = {
                monday: { ...(businessHours.monday || { start: 0, end: 0 }), is_open: false },
                tuesday: { ...(businessHours.tuesday || { start: 0, end: 0 }), is_open: false },
                wednesday: { ...(businessHours.wednesday || { start: 0, end: 0 }), is_open: false },
                thursday: { ...(businessHours.thursday || { start: 0, end: 0 }), is_open: false },
                friday: { ...(businessHours.friday || { start: 0, end: 0 }), is_open: false },
                saturday: { ...(businessHours.saturday || { start: 0, end: 0 }), is_open: false },
                sunday: { ...(businessHours.sunday || { start: 0, end: 0 }), is_open: false }
            };
        }

        const updateData = {
            availability_type,
            working_hours: finalWorkingHours
        };

        await employeeDoc.ref.update(updateData);

        res.json({
            id: req.params.employeeId,
            availability_type: updateData.availability_type,
            working_hours: updateData.working_hours
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update employee is_open_now
router.patch('/:id/employees/:employeeId/is-open-now', authenticate, validate(updateEmployeeIsOpenNowSchema), async (req, res) => {
    try {
        const employeeDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .doc(req.params.employeeId)
            .get();

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        const employeeData = employeeDoc.data();

        // Verify that authenticated user's phone number matches employee's phone number
        if (employeeData.phone_number !== req.user.phone_number) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const { is_open_now } = req.validated;

        // If setting is_open_now to true, verify that business is currently open
        if (is_open_now) {
            const businessDoc = await db.collection('businesses').doc(req.params.id).get();
            if (!businessDoc.exists) {
                return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
            }

            const businessData = businessDoc.data();
            if (!isBusinessOpenNow(businessData.working_hours)) {
                return res.status(400).json({ error: 'Business is currently closed', error_code: 'BUSINESS_CLOSED' });
            }
        }

        await employeeDoc.ref.update({ is_open_now });

        res.json({
            id: req.params.employeeId,
            is_open_now
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update employee slot capacity (allowed_booking_count_per_slot)
router.patch('/:id/employees/:employeeId/slot-capacity', authenticate, validate(updateEmployeeSlotCapacitySchema), async (req, res) => {
    try {
        const [businessDoc, employeeDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        const businessData = businessDoc.data();

        // Only business owner can update slot capacity
        if (businessData.business_owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const { allowed_booking_count_per_slot } = req.validated;

        await employeeDoc.ref.update({ allowed_booking_count_per_slot });

        res.json({
            id: req.params.employeeId,
            allowed_booking_count_per_slot
        });
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

        // Create employee record with flexible working hours (copy business hours, all days closed)
        const businessHours = businessData.working_hours || {};
        const flexibleWorkingHours = {
            monday: { ...(businessHours.monday || { start: 0, end: 0 }), is_open: false },
            tuesday: { ...(businessHours.tuesday || { start: 0, end: 0 }), is_open: false },
            wednesday: { ...(businessHours.wednesday || { start: 0, end: 0 }), is_open: false },
            thursday: { ...(businessHours.thursday || { start: 0, end: 0 }), is_open: false },
            friday: { ...(businessHours.friday || { start: 0, end: 0 }), is_open: false },
            saturday: { ...(businessHours.saturday || { start: 0, end: 0 }), is_open: false },
            sunday: { ...(businessHours.sunday || { start: 0, end: 0 }), is_open: false }
        };

        const employeeData = {
            phone_number: req.user.phone_number,
            availability_type: 'flexible',
            working_hours: flexibleWorkingHours,
            date_created: dateCreated,
            is_accepted: false,
            date_accepted: null,
            is_open_now: false
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
            availability_type: 'flexible',
            working_hours: flexibleWorkingHours,
            date_created: dateCreated.toISOString(),
            is_accepted: false
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// ==================== EMPLOYEE SERVICES ROUTES ====================

// Get all services for an employee
router.get('/:id/employees/:employeeId/services', authenticate, async (req, res) => {
    try {
        const [businessDoc, employeeDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        const businessData = businessDoc.data();
        const employeeData = employeeDoc.data();

        // Allow access if: business owner OR the employee themselves (accepted)
        const isBusinessOwner = businessData.business_owner_id === req.user.id;
        const isEmployee = employeeData.phone_number === req.user.phone_number && employeeData.is_accepted === true;

        if (!isBusinessOwner && !isEmployee) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const snapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('employees')
            .doc(req.params.employeeId)
            .collection('employeeServices')
            .get();

        // Fetch business services to get names
        const businessServicesSnapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .get();

        const businessServicesMap = new Map();
        businessServicesSnapshot.docs.forEach(doc => {
            businessServicesMap.set(doc.id, doc.data());
        });

        const services = snapshot.docs.map(doc => {
            const data = doc.data();
            const businessService = businessServicesMap.get(data.service_id);
            return {
                id: doc.id,
                service_id: data.service_id,
                name: businessService?.name || data.name,
                price: data.price,
                duration_minutes: data.duration_minutes,
                is_active: data.is_active ?? true,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            };
        });

        res.json(services);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Add services to an employee
router.post('/:id/employees/:employeeId/services', authenticate, validate(addEmployeeServicesSchema), async (req, res) => {
    try {
        const [businessDoc, employeeDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        const businessData = businessDoc.data();
        const employeeData = employeeDoc.data();

        // Allow access if: business owner OR the employee themselves (accepted)
        const isBusinessOwner = businessData.business_owner_id === req.user.id;
        const isEmployee = employeeData.phone_number === req.user.phone_number && employeeData.is_accepted === true;

        if (!isBusinessOwner && !isEmployee) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const { services } = req.validated;
        const dateCreated = new Date();

        // Fetch all business services to get names and validate service_ids
        const businessServicesSnapshot = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .get();

        const businessServicesMap = new Map();
        businessServicesSnapshot.docs.forEach(doc => {
            businessServicesMap.set(doc.id, doc.data());
        });

        // Check for invalid service_ids
        const invalidServiceIds = services
            .filter(s => !businessServicesMap.has(s.service_id))
            .map(s => s.service_id);

        if (invalidServiceIds.length > 0) {
            return res.status(400).json({
                error: `Invalid service_ids: ${invalidServiceIds.join(', ')}`,
                error_code: 'INVALID_SERVICE_IDS'
            });
        }

        // Add/update services for employee
        const batch = db.batch();
        const results = [];

        for (const service of services) {
            const businessService = businessServicesMap.get(service.service_id);
            const docRef = db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .collection('employeeServices')
                .doc(service.service_id);

            batch.set(docRef, {
                service_id: service.service_id,
                price: service.price,
                duration_minutes: service.duration_minutes,
                is_active: service.is_active ?? true,
                date_created: dateCreated
            }, { merge: true });

            results.push({
                id: service.service_id,
                service_id: service.service_id,
                name: businessService.name,
                price: service.price,
                duration_minutes: service.duration_minutes,
                is_active: service.is_active ?? true
            });
        }

        await batch.commit();

        res.status(201).json(results);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Update an employee's service
router.put('/:id/employees/:employeeId/services/:serviceId', authenticate, validate(updateEmployeeServiceSchema), async (req, res) => {
    try {
        const [businessDoc, employeeDoc, employeeServiceDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .collection('employeeServices')
                .doc(req.params.serviceId)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        if (!employeeServiceDoc.exists) {
            return res.status(404).json({ error: 'Employee service not found', error_code: 'EMPLOYEE_SERVICE_NOT_FOUND' });
        }

        const businessData = businessDoc.data();
        const employeeData = employeeDoc.data();

        // Allow access if: business owner OR the employee themselves (accepted)
        const isBusinessOwner = businessData.business_owner_id === req.user.id;
        const isEmployee = employeeData.phone_number === req.user.phone_number && employeeData.is_accepted === true;

        if (!isBusinessOwner && !isEmployee) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        const updateData = {};
        if (req.validated.price !== undefined) updateData.price = req.validated.price;
        if (req.validated.duration_minutes !== undefined) updateData.duration_minutes = req.validated.duration_minutes;
        if (req.validated.is_active !== undefined) updateData.is_active = req.validated.is_active;

        await employeeServiceDoc.ref.update(updateData);

        const updatedData = (await employeeServiceDoc.ref.get()).data();

        // Fetch business service to get the name
        const businessServiceDoc = await db.collection('businesses')
            .doc(req.params.id)
            .collection('services')
            .doc(req.params.serviceId)
            .get();

        const serviceName = businessServiceDoc.exists ? businessServiceDoc.data().name : updatedData.name;

        res.json({
            id: req.params.serviceId,
            service_id: updatedData.service_id,
            name: serviceName,
            price: updatedData.price,
            duration_minutes: updatedData.duration_minutes,
            is_active: updatedData.is_active ?? true
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Delete an employee's service
router.delete('/:id/employees/:employeeId/services/:serviceId', authenticate, async (req, res) => {
    try {
        const [businessDoc, employeeDoc, employeeServiceDoc] = await Promise.all([
            db.collection('businesses').doc(req.params.id).get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .get(),
            db.collection('businesses')
                .doc(req.params.id)
                .collection('employees')
                .doc(req.params.employeeId)
                .collection('employeeServices')
                .doc(req.params.serviceId)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'EMPLOYEE_NOT_FOUND' });
        }

        if (!employeeServiceDoc.exists) {
            return res.status(404).json({ error: 'Employee service not found', error_code: 'EMPLOYEE_SERVICE_NOT_FOUND' });
        }

        const businessData = businessDoc.data();
        const employeeData = employeeDoc.data();

        // Allow access if: business owner OR the employee themselves (accepted)
        const isBusinessOwner = businessData.business_owner_id === req.user.id;
        const isEmployee = employeeData.phone_number === req.user.phone_number && employeeData.is_accepted === true;

        if (!isBusinessOwner && !isEmployee) {
            return res.status(403).json({ error: 'Access denied', error_code: 'FORBIDDEN' });
        }

        await employeeServiceDoc.ref.delete();

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
