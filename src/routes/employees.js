import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { employeeSchema } from '../schemas/employee.js';

const router = Router();

// Helper function to generate unique ID
async function generateUniqueId(collection) {
    let id;
    let exists = true;
    while (exists) {
        id = crypto.randomBytes(8).toString('hex');
        const doc = await collection.doc(id).get();
        exists = doc.exists;
    }
    return id;
}

// Get all employees for a business
router.get('/business/:businessId/employees', async (req, res) => {
    try {
        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(req.params.businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        const snapshot = await db.collection('businesses')
            .doc(req.params.businessId)
            .collection('employees')
            .get();

        const employees = await Promise.all(snapshot.docs.map(async (doc) => {
            const data = doc.data();

            // Fetch business owner details
            const ownerDoc = await db.collection('business_owners').doc(data.business_owner_id).get();

            if (!ownerDoc.exists) {
                return null;
            }

            const ownerData = ownerDoc.data();

            return {
                id: doc.id,
                business_id: req.params.businessId,
                business_owner_id: data.business_owner_id,
                first_name: ownerData.first_name,
                last_name: ownerData.last_name,
                phone_number: ownerData.phone_number,
                telegram_id: ownerData.telegram_id,
                is_confirmed_by_employee: data.is_confirmed_by_employee ?? false,
                date_created: data.date_created?.toDate?.().toISOString() || data.date_created
            };
        }));

        // Filter out nulls (deleted business owners)
        res.json(employees.filter(emp => emp !== null));
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Add employee to business
router.post('/business/:businessId/employees', validate(employeeSchema), async (req, res) => {
    try {
        const { first_name, last_name, phone_number } = req.validated;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(req.params.businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Check if business owner exists by phone number
        const existingOwnerSnapshot = await db.collection('business_owners')
            .where('phone_number', '==', phone_number)
            .get();

        let businessOwnerId;
        let ownerData;

        if (!existingOwnerSnapshot.empty) {
            // Business owner exists, use it
            const ownerDoc = existingOwnerSnapshot.docs[0];
            businessOwnerId = ownerDoc.id;
            ownerData = ownerDoc.data();
        } else {
            // Create new business owner with is_verified: false
            businessOwnerId = await generateUniqueId(db.collection('business_owners'));
            const dateCreated = new Date();

            ownerData = {
                first_name,
                last_name,
                phone_number,
                telegram_id: null,
                date_created: dateCreated,
                is_verified: false
            };

            await db.collection('business_owners').doc(businessOwnerId).set(ownerData);
        }

        // Check if already an employee of this business
        const existingEmployees = await db.collection('businesses')
            .doc(req.params.businessId)
            .collection('employees')
            .where('business_owner_id', '==', businessOwnerId)
            .get();

        if (!existingEmployees.empty) {
            return res.status(409).json({ error: 'Business owner is already an employee', error_code: 'ALREADY_EMPLOYEE' });
        }

        // Generate unique employee ID
        const employeeId = await generateUniqueId(
            db.collection('businesses').doc(req.params.businessId).collection('employees')
        );

        const dateCreated = new Date();

        const employeeData = {
            business_owner_id: businessOwnerId,
            is_confirmed_by_employee: false,
            date_created: dateCreated
        };

        await db.collection('businesses')
            .doc(req.params.businessId)
            .collection('employees')
            .doc(employeeId)
            .set(employeeData);

        res.status(201).json({
            id: employeeId,
            business_id: req.params.businessId,
            business_owner_id: businessOwnerId,
            first_name: ownerData.first_name,
            last_name: ownerData.last_name,
            phone_number: ownerData.phone_number,
            telegram_id: ownerData.telegram_id,
            is_confirmed_by_employee: false,
            date_created: dateCreated.toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

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
                    name: businessData.name,
                    address: businessData.address,
                    phone_number: businessData.phone_number,
                    email: businessData.email,
                    website: businessData.website,
                    business_type: businessData.business_type,
                    working_hours: businessData.working_hours,
                    description: businessData.description
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

// Delete employee from business
router.delete('/business/:businessId/employees/:id', async (req, res) => {
    try {
        const { businessId, id: employeeId } = req.params;

        // Verify business exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ error: 'Business not found', error_code: 'BUSINESS_NOT_FOUND' });
        }

        // Verify employee exists
        const employeeDoc = await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .doc(employeeId)
            .get();

        if (!employeeDoc.exists) {
            return res.status(404).json({ error: 'Employee not found', error_code: 'NOT_FOUND' });
        }

        await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .doc(employeeId)
            .delete();

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
