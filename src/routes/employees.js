import { Router } from 'express';
import { db } from '../db/db.js';

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

export default router;
