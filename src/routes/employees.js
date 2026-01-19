import { Router } from 'express';
import { db } from '../db/db.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { workplaceActionSchema } from '../schemas/employee.js';

const router = Router();

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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get workplaces for authenticated user (by phone number)
router.get('/workplaces', authenticate, async (req, res) => {
    try {
        // Use collection group query to search across all employee subcollections
        const employeesSnapshot = await db.collectionGroup('employees')
            .where('phone_number', '==', req.user.phone_number)
            .where('is_rejected', '==', false)
            .get();

        if (employeesSnapshot.empty) {
            return res.json([]);
        }

        // Fetch business details for each employee record
        const workplaces = await Promise.all(employeesSnapshot.docs.map(async (employeeDoc) => {
            const employeeData = employeeDoc.data();
            const businessId = employeeDoc.ref.parent.parent.id;

            const businessDoc = await db.collection('businesses').doc(businessId).get();

            if (!businessDoc.exists) {
                return null;
            }

            const businessData = businessDoc.data();

            return {
                employee: {
                    id: employeeDoc.id,
                    phone_number: employeeData.phone_number,
                    position: employeeData.position ?? '',
                    availability_type: employeeData.availability_type ?? 'flexible',
                    working_hours: employeeData.working_hours ?? null,
                    is_accepted: employeeData.is_accepted ?? false,
                    date_accepted: employeeData.date_accepted ?? null,
                    is_rejected: employeeData.is_rejected ?? false,
                    date_created: employeeData.date_created?.toDate?.().toISOString() || employeeData.date_created
                },
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
                    date_created: businessData.date_created?.toDate?.().toISOString() || businessData.date_created
                }
            };
        }));

        // Filter out nulls (deleted businesses)
        res.json(workplaces.filter(wp => wp !== null));
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
