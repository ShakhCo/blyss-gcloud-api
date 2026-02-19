import { Router } from 'express';
import { db } from '../db/db.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { workplaceActionSchema } from '../schemas/employee.js';

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

// Get workplaces for a business owner
router.get('/business-owner/:businessOwnerId/workplaces', async (req, res) => {
    try {
        const { businessOwnerId } = req.params;

        // Verify business owner exists
        const ownerDoc = await db.collection('business_owners').doc(businessOwnerId).get();
        if (!ownerDoc.exists) {
            return res.status(404).json({ error: 'Business owner not found', error_code: 'BUSINESS_OWNER_NOT_FOUND' });
        }

        // Use collection group query to efficiently search across all employee subcollections
        const employeesSnapshot = await db.collectionGroup('employees')
            .where('business_owner_id', '==', businessOwnerId)
            .get();

        if (employeesSnapshot.empty) {
            return res.json([]);
        }

        // Fetch business details in parallel
        const workplaces = await Promise.all(employeesSnapshot.docs.map(async (employeeDoc) => {
            const employeeData = employeeDoc.data();
            const businessId = employeeDoc.ref.parent.parent.id;

            const businessDoc = await db.collection('businesses').doc(businessId).get();

            if (!businessDoc.exists) {
                return null;
            }

            const businessData = businessDoc.data();

            return {
                business: {
                    id: businessDoc.id,
                    business_name: businessData.business_name,
                    business_type: businessData.business_type,
                    location: businessData.location,
                    working_graphic_type: businessData.working_graphic_type,
                    working_hours: businessData.working_hours,
                    business_phone_number: businessData.business_phone_number,
                    business_owner_id: businessData.business_owner_id,
                    business_status: businessData.business_status,
                    avatar_url: businessData.avatar_url || null,
                    avatar_updated_at: businessData.avatar_updated_at?.toDate?.().toISOString() || businessData.avatar_updated_at || null,
                    date_created: businessData.date_created?.toDate?.().toISOString() || businessData.date_created
                },
                employee: {
                    id: employeeDoc.id,
                    business_owner_id: employeeData.business_owner_id,
                    is_confirmed_by_employee: employeeData.is_confirmed_by_employee ?? false,
                    availability_type: employeeData.availability_type ?? null,
                    working_hours: employeeData.working_hours ?? null,
                    date_created: employeeData.date_created?.toDate?.().toISOString() || employeeData.date_created
                }
            };
        }));

        // Filter out nulls (deleted businesses)
        res.json(workplaces.filter(wp => wp !== null));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Get workplaces for authenticated user (by phone number)
router.get('/workplaces', authenticate, async (req, res) => {
    try {
        // Use collection group query to search across all employee subcollections
        const employeesSnapshot = await db.collectionGroup('employees')
            .where('phone_number', '==', req.user.phone_number)
            .where('is_rejected', '==', false)
            .where('is_accepted', '==', true)
            .limit(1)
            .get();

        if (employeesSnapshot.empty) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const employeeDoc = employeesSnapshot.docs[0];
        const employeeData = employeeDoc.data();
        const businessId = employeeDoc.ref.parent.parent.id;

        // Fetch business details and services in parallel
        const [businessDoc, servicesSnapshot, businessOwnerSnapshot] = await Promise.all([
            db.collection('businesses').doc(businessId).get(),
            db.collection('businesses').doc(businessId).collection('services').where('is_active', '==', true).orderBy('date_created', 'desc').get(),
            db.collection('business_owners').where('phone_number', '==', req.user.phone_number).limit(1).get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        const businessData = businessDoc.data();

        // Get first_name and last_name from business_owners
        let first_name = null;
        let last_name = null;
        if (!businessOwnerSnapshot.empty) {
            const businessOwner = businessOwnerSnapshot.docs[0].data();
            first_name = businessOwner.first_name || null;
            last_name = businessOwner.last_name || null;
        }

        // Fetch employee services
        const employeeServicesSnapshot = await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .doc(employeeDoc.id)
            .collection('employeeServices')
            .where('is_active', '==', true)
            .get();

        // Build a map of business service IDs to names
        const businessServicesMap = new Map();
        servicesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            businessServicesMap.set(doc.id, data.name);
        });

        const services = employeeServicesSnapshot.docs.map(serviceDoc => {
            const serviceData = serviceDoc.data();
            return {
                id: serviceDoc.id,
                service_id: serviceData.service_id,
                name: businessServicesMap.get(serviceData.service_id) || null,
                price: serviceData.price,
                duration_minutes: serviceData.duration_minutes
            };
        });

        // Determine is_open_now: use stored value for flexible, calculate for fixed
        const availabilityType = employeeData.availability_type ?? 'flexible';
        const workingHours = employeeData.working_hours ?? null;
        let isOpenNow;

        if (availabilityType === 'flexible') {
            // For flexible, check if business is open first
            const businessIsOpen = isBusinessOpenNow(businessData.working_hours);
            if (!businessIsOpen) {
                isOpenNow = false;
            } else {
                // Business is open, use the manually set value from DB
                isOpenNow = employeeData.is_open_now ?? false;
            }
        } else {
            // For fixed, calculate based on working hours
            isOpenNow = isEmployeeOpenNow(availabilityType, workingHours);
        }

        res.json({
            employee: {
                id: employeeDoc.id,
                first_name: first_name || '',
                last_name: last_name || '',
                phone_number: employeeData.phone_number,
                position: employeeData.position ?? '',
                availability_type: availabilityType,
                working_hours: workingHours,
                is_open_now: isOpenNow,
                is_accepted: employeeData.is_accepted ?? false,
                date_accepted: employeeData.date_accepted?.toDate?.().toISOString() || employeeData.date_accepted || '',
                services: services
            },
            business: {
                id: businessDoc.id,
                business_name: businessData.business_name,
                business_type: businessData.business_type,
                location: businessData.location,
                working_hours: businessData.working_hours,
                business_phone_number: businessData.business_phone_number,
                business_owner_id: businessData.business_owner_id,
                business_status: businessData.business_status,
                tenant_url: businessData.tenant_url || null,
                is_solo: businessData.is_solo || false,
                avatar_url: businessData.avatar_url || null,
                avatar_updated_at: businessData.avatar_updated_at?.toDate?.().toISOString() || businessData.avatar_updated_at || null,
                services: servicesSnapshot.docs.map(doc => {
                    const data = doc.data();
                    return {
                        id: doc.id,
                        name: data.name,
                        price: data.price,
                        duration_minutes: data.duration_minutes,
                        is_active: data.is_active ?? false,
                        allow_employee_customization: data.allow_employee_customization ?? true,
                        date_created: data.date_created?.toDate?.().toISOString() || data.date_created
                    };
                })
            }
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Get pending workplace invitations for authenticated user
router.get('/workplaces/pending', authenticate, async (req, res) => {
    try {
        // Use collection group query to search across all employee subcollections
        const employeesSnapshot = await db.collectionGroup('employees')
            .where('phone_number', '==', req.user.phone_number)
            .where('is_rejected', '==', false)
            .where('is_accepted', '==', false)
            .get();

        if (employeesSnapshot.empty) {
            return res.json([]);
        }

        // Fetch business details in parallel
        const pendingInvites = await Promise.all(employeesSnapshot.docs.map(async (employeeDoc) => {
            const employeeData = employeeDoc.data();
            const businessId = employeeDoc.ref.parent.parent.id;

            const businessDoc = await db.collection('businesses').doc(businessId).get();

            if (!businessDoc.exists) {
                return null;
            }

            const businessData = businessDoc.data();

            return {
                id: employeeDoc.id,
                business: {
                    id: businessDoc.id,
                    business_name: businessData.business_name,
                    business_type: businessData.business_type,
                    location: businessData.location,
                    working_graphic_type: businessData.working_graphic_type,
                    working_hours: businessData.working_hours,
                    business_phone_number: businessData.business_phone_number,
                    business_owner_id: businessData.business_owner_id,
                    business_status: businessData.business_status,
                    tenant_url: businessData.tenant_url || null,
                    avatar_url: businessData.avatar_url || null,
                    avatar_updated_at: businessData.avatar_updated_at?.toDate?.().toISOString() || businessData.avatar_updated_at || null,
                    date_created: businessData.date_created?.toDate?.().toISOString() || businessData.date_created
                },
                employee: {
                    phone_number: employeeData.phone_number,
                    position: employeeData.position ?? '',
                    is_accepted: employeeData.is_accepted ?? false,
                    date_created: employeeData.date_created?.toDate?.().toISOString() || employeeData.date_created
                }
            };
        }));

        // Filter out nulls (deleted businesses)
        res.json(pendingInvites.filter(invite => invite !== null));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Accept or deny workplace invitation
router.post('/workplaces/:employeeId/respond', authenticate, validate(workplaceActionSchema), async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { accept } = req.validated;

        // Find all employees for this user
        const employeesSnapshot = await db.collectionGroup('employees')
            .where('phone_number', '==', req.user.phone_number)
            .get();

        // Find the matching employee by ID
        const employeeDoc = employeesSnapshot.docs.find(doc => doc.id === employeeId);

        if (!employeeDoc) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'NOT_FOUND' });
        }

        if (accept) {
            // Accept workplace - update is_accepted and date_accepted
            const now = new Date();
            await employeeDoc.ref.update({
                is_accepted: true,
                date_accepted: now
            });

            // Reject all other pending invites for this user
            const rejectPromises = employeesSnapshot.docs
                .filter(doc => doc.id !== employeeId) // Exclude the accepted employee
                .filter(doc => !doc.data().is_accepted && !doc.data().is_rejected) // Only pending invites
                .map(doc => doc.ref.update({ is_rejected: true }));

            await Promise.all(rejectPromises);

            res.json({
                id: employeeId,
                is_accepted: true,
                date_accepted: now.toISOString()
            });
        } else {
            // Deny workplace - set is_rejected to true
            await employeeDoc.ref.update({
                is_rejected: true
            });

            res.json({
                id: employeeId,
                is_rejected: true
            });
        }
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * GET /employees/statistics
 * Returns booking revenue summary for yesterday, today, and tomorrow
 */
router.get('/statistics', authenticate, async (req, res) => {
    try {
        // Find employee's workplace
        const employeesSnapshot = await db.collectionGroup('employees')
            .where('phone_number', '==', req.user.phone_number)
            .where('is_accepted', '==', true)
            .where('is_rejected', '==', false)
            .limit(1)
            .get();

        if (employeesSnapshot.empty) {
            return res.status(404).json({ error: 'Workplace not found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const employeeDoc = employeesSnapshot.docs[0];
        const employeeId = employeeDoc.id;
        const businessId = employeeDoc.ref.parent.parent.id;

        // Calculate dates in Uzbekistan timezone (GMT+5)
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));

        const formatDate = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        const yesterday = new Date(uzbekNow);
        yesterday.setDate(yesterday.getDate() - 1);
        const today = new Date(uzbekNow);
        const tomorrow = new Date(uzbekNow);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const yesterdayStr = formatDate(yesterday);
        const todayStr = formatDate(today);
        const tomorrowStr = formatDate(tomorrow);

        // Fetch bookings for all 3 days in one query
        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', businessId)
            .where('booking_date', '>=', yesterdayStr)
            .where('booking_date', '<=', tomorrowStr)
            .get();

        let yesterdayTotal = 0;
        let todayTotal = 0;
        let tomorrowTotal = 0;
        let yesterdayCount = 0;
        let todayCount = 0;
        let tomorrowCount = 0;

        for (const doc of bookingsSnapshot.docs) {
            const booking = doc.data();

            // Filter to this employee's non-cancelled items
            const employeeItems = (booking.items || []).filter(
                item => item.employee_id === employeeId && item.status !== 'cancelled'
            );
            if (employeeItems.length === 0) continue;

            const itemTotal = employeeItems.reduce((sum, item) => sum + (item.price || 0), 0);

            if (booking.booking_date === yesterdayStr) {
                // Yesterday: only completed
                if (booking.status === 'completed') {
                    yesterdayTotal += itemTotal;
                    yesterdayCount++;
                }
            } else if (booking.booking_date === todayStr) {
                // Today: only confirmed + completed
                if (booking.status === 'confirmed' || booking.status === 'completed') {
                    todayTotal += itemTotal;
                    todayCount++;
                }
            } else if (booking.booking_date === tomorrowStr) {
                // Tomorrow: pending + confirmed
                if (booking.status === 'pending' || booking.status === 'confirmed') {
                    tomorrowTotal += itemTotal;
                    tomorrowCount++;
                }
            }
        }

        res.json({
            yesterday: { date: yesterdayStr, total: yesterdayTotal, count: yesterdayCount },
            today: { date: todayStr, total: todayTotal, count: todayCount },
            tomorrow: { date: tomorrowStr, total: tomorrowTotal, count: tomorrowCount },
        });
    } catch (error) {
        console.error('Error fetching employee statistics:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
