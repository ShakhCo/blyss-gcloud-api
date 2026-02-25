import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { discountSchema, updateDiscountSchema, loyaltyConfigSchema } from '../schemas/discount.js';

const router = Router();

/**
 * Find the authenticated user's accepted employee doc.
 * Returns { employeeDoc, businessId, employeeId } or null.
 */
async function findEmployeeWorkplace(phoneNumber) {
    const snapshot = await db.collectionGroup('employees')
        .where('phone_number', '==', phoneNumber)
        .where('is_accepted', '==', true)
        .where('is_rejected', '==', false)
        .limit(1)
        .get();

    if (snapshot.empty) return null;

    const employeeDoc = snapshot.docs[0];
    return {
        employeeDoc,
        businessId: employeeDoc.ref.parent.parent.id,
        employeeId: employeeDoc.id,
    };
}

// ─── Discount CRUD ───────────────────────────────────────────

/**
 * GET /employees/discounts
 * List all discounts for the authenticated employee.
 */
router.get('/discounts', authenticate, async (req, res) => {
    try {
        const workplace = await findEmployeeWorkplace(req.user.phone_number);
        if (!workplace) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const { businessId, employeeId } = workplace;
        const snapshot = await db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('discounts')
            .orderBy('created_at', 'desc')
            .get();

        const discounts = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            created_at: doc.data().created_at?.toDate?.().toISOString() || doc.data().created_at,
            updated_at: doc.data().updated_at?.toDate?.().toISOString() || doc.data().updated_at,
        }));

        res.json(discounts);
    } catch (error) {
        console.error('Error fetching discounts:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /employees/discounts
 * Create a new discount for the authenticated employee.
 */
router.post('/discounts', authenticate, validate(discountSchema), async (req, res) => {
    try {
        const workplace = await findEmployeeWorkplace(req.user.phone_number);
        if (!workplace) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const { businessId, employeeId } = workplace;
        const data = req.validated;
        const now = new Date();

        // Auto-generate name if not provided
        if (!data.name) {
            data.name = generateDiscountName(data);
        }

        const discountRef = db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('discounts')
            .doc(crypto.randomBytes(16).toString('hex'));

        const discountData = {
            ...data,
            created_at: now,
            updated_at: now,
        };

        await discountRef.set(discountData);

        res.json({
            id: discountRef.id,
            ...discountData,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
        });
    } catch (error) {
        console.error('Error creating discount:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * PATCH /employees/discounts/:discountId
 * Update an existing discount.
 */
router.patch('/discounts/:discountId', authenticate, validate(updateDiscountSchema), async (req, res) => {
    try {
        const workplace = await findEmployeeWorkplace(req.user.phone_number);
        if (!workplace) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const { businessId, employeeId } = workplace;
        const { discountId } = req.params;

        const discountRef = db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('discounts').doc(discountId);

        const discountDoc = await discountRef.get();
        if (!discountDoc.exists) {
            return res.status(404).json({ error: 'Discount not found', error_code: 'NOT_FOUND' });
        }

        const updateData = {
            ...req.validated,
            updated_at: new Date(),
        };

        await discountRef.update(updateData);

        const updated = { id: discountId, ...discountDoc.data(), ...updateData };
        updated.created_at = updated.created_at?.toDate?.().toISOString() || updated.created_at;
        updated.updated_at = updated.updated_at?.toDate?.().toISOString() || updated.updated_at;

        res.json(updated);
    } catch (error) {
        console.error('Error updating discount:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * DELETE /employees/discounts/:discountId
 * Delete a discount.
 */
router.delete('/discounts/:discountId', authenticate, async (req, res) => {
    try {
        const workplace = await findEmployeeWorkplace(req.user.phone_number);
        if (!workplace) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const { businessId, employeeId } = workplace;
        const { discountId } = req.params;

        const discountRef = db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('discounts').doc(discountId);

        const discountDoc = await discountRef.get();
        if (!discountDoc.exists) {
            return res.status(404).json({ error: 'Discount not found', error_code: 'NOT_FOUND' });
        }

        await discountRef.delete();
        res.json({ id: discountId, deleted: true });
    } catch (error) {
        console.error('Error deleting discount:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// ─── Loyalty Config ──────────────────────────────────────────

/**
 * GET /employees/loyalty
 * Get loyalty configuration for the authenticated employee.
 */
router.get('/loyalty', authenticate, async (req, res) => {
    try {
        const workplace = await findEmployeeWorkplace(req.user.phone_number);
        if (!workplace) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const { businessId, employeeId } = workplace;

        const loyaltyDoc = await db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('loyalty_config').doc('config')
            .get();

        if (!loyaltyDoc.exists) {
            return res.json({ is_enabled: false, rules: [] });
        }

        const data = loyaltyDoc.data();
        res.json({
            is_enabled: data.is_enabled ?? false,
            rules: data.rules ?? [],
            updated_at: data.updated_at?.toDate?.().toISOString() || data.updated_at,
        });
    } catch (error) {
        console.error('Error fetching loyalty config:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * PUT /employees/loyalty
 * Update loyalty configuration for the authenticated employee.
 */
router.put('/loyalty', authenticate, validate(loyaltyConfigSchema), async (req, res) => {
    try {
        const workplace = await findEmployeeWorkplace(req.user.phone_number);
        if (!workplace) {
            return res.status(404).json({ error: 'No accepted workplace found', error_code: 'WORKPLACE_NOT_FOUND' });
        }

        const { businessId, employeeId } = workplace;
        const data = req.validated;

        // Sort rules by visit_number
        if (data.rules) {
            data.rules.sort((a, b) => a.visit_number - b.visit_number);
        }

        const loyaltyRef = db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('loyalty_config').doc('config');

        const updateData = {
            ...data,
            updated_at: new Date(),
        };

        await loyaltyRef.set(updateData);

        res.json({
            ...updateData,
            updated_at: updateData.updated_at.toISOString(),
        });
    } catch (error) {
        console.error('Error updating loyalty config:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// ─── Helpers ─────────────────────────────────────────────────

const DAY_NAMES_SHORT = ['', 'Du', 'Se', 'Chor', 'Pay', 'Ju', 'Sha', 'Yak'];

function generateDiscountName(data) {
    const valueStr = data.discount_type === 'percentage'
        ? `${data.discount_value}%`
        : `${new Intl.NumberFormat('uz-UZ').format(data.discount_value)} so'm`;

    switch (data.trigger) {
        case 'date_range':
            return `${valueStr} — ${data.date_start} — ${data.date_end}`;
        case 'day_of_week': {
            const days = (data.days_of_week || []).map(d => DAY_NAMES_SHORT[d] || d).join(', ');
            return `${valueStr} — ${days}`;
        }
        case 'time_of_day': {
            const start = formatSecondsToTime(data.time_start || 0);
            const end = formatSecondsToTime(data.time_end || 0);
            return `${valueStr} — ${start}-${end}`;
        }
        case 'first_visit':
            return `${valueStr} — Birinchi tashrif`;
        case 'scheduled': {
            const parts = [];
            if (data.days_of_week && data.days_of_week.length > 0) {
                parts.push(data.days_of_week.map(d => DAY_NAMES_SHORT[d] || d).join(', '));
            }
            if (data.time_start != null && data.time_end != null) {
                parts.push(`${formatSecondsToTime(data.time_start)}-${formatSecondsToTime(data.time_end)}`);
            }
            if (data.date_start && data.date_end) {
                parts.push(`${data.date_start} — ${data.date_end}`);
            }
            return `${valueStr} — ${parts.join(' · ')}`;
        }
        default:
            return valueStr;
    }
}

function formatSecondsToTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default router;
