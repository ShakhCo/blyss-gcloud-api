import { db } from '../db/db.js';

/**
 * Resolve the best applicable discount for a specific booking context.
 *
 * Checks employee's promotional discounts (date_range, day_of_week, time_of_day, first_visit)
 * and loyalty rewards, then returns the single best discount (highest savings).
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.employeeId
 * @param {string} params.serviceId
 * @param {number} params.basePrice - The employee's base service price (already resolved)
 * @param {string} params.bookingDate - "YYYY-MM-DD"
 * @param {number} params.bookingTime - seconds from midnight
 * @param {string} [params.customerPhone] - for first-visit + loyalty check (optional)
 * @returns {Promise<{ original_price: number, final_price: number, discount: { name: string, discount_type: string, discount_value: number, source: string } } | null>}
 */
export async function resolveDiscount({ businessId, employeeId, serviceId, basePrice, bookingDate, bookingTime, customerPhone }) {
    if (!basePrice || basePrice <= 0) return null;

    // Fetch discounts and loyalty config in parallel
    const [discountsSnapshot, loyaltyDoc, visitDoc] = await Promise.all([
        db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('discounts')
            .where('is_active', '==', true)
            .get(),
        db.collection('businesses').doc(businessId)
            .collection('employees').doc(employeeId)
            .collection('loyalty_config').doc('config')
            .get(),
        customerPhone
            ? db.collection('businesses').doc(businessId)
                .collection('employees').doc(employeeId)
                .collection('customer_visits').doc(sanitizePhone(customerPhone))
                .get()
            : Promise.resolve(null),
    ]);

    const visitCount = visitDoc?.exists ? (visitDoc.data().visit_count || 0) : 0;
    const candidates = [];

    // 1. Check promotional discounts
    for (const doc of discountsSnapshot.docs) {
        const d = doc.data();

        // Check service scope
        if (d.applies_to && d.applies_to.length > 0 && !d.applies_to.includes(serviceId)) {
            continue;
        }

        // Check trigger conditions
        if (!matchesTrigger(d, bookingDate, bookingTime, visitCount, customerPhone)) {
            continue;
        }

        const savings = calculateSavings(basePrice, d.discount_type, d.discount_value);
        if (savings > 0) {
            candidates.push({
                name: d.name || 'Chegirma',
                discount_type: d.discount_type,
                discount_value: d.discount_value,
                savings,
                source: 'promotion',
            });
        }
    }

    // 2. Check loyalty rewards
    if (loyaltyDoc.exists && customerPhone) {
        const loyalty = loyaltyDoc.data();
        if (loyalty.is_enabled && Array.isArray(loyalty.rules) && loyalty.rules.length > 0) {
            const nextVisit = visitCount + 1;
            // Find the matching rule for this visit number
            const matchingRule = loyalty.rules.find(r => r.visit_number === nextVisit);
            if (matchingRule) {
                const savings = calculateSavings(basePrice, matchingRule.discount_type, matchingRule.discount_value);
                if (savings > 0) {
                    candidates.push({
                        name: `${nextVisit}-tashrif sodiqlik`,
                        discount_type: matchingRule.discount_type,
                        discount_value: matchingRule.discount_value,
                        savings,
                        source: 'loyalty',
                    });
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    // 3. Best discount wins (highest savings in so'm)
    candidates.sort((a, b) => b.savings - a.savings);
    const best = candidates[0];
    const finalPrice = Math.max(0, basePrice - best.savings);

    return {
        original_price: basePrice,
        final_price: finalPrice,
        discount: {
            name: best.name,
            discount_type: best.discount_type,
            discount_value: best.discount_value,
            source: best.source,
        },
    };
}

/**
 * Batch-resolve discounts for multiple employees for the same service/date/time.
 * Useful for slot-employees endpoint where we list multiple employees.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {Array<{employeeId: string, serviceId: string, basePrice: number}>} params.employees
 * @param {string} params.bookingDate
 * @param {number} params.bookingTime
 * @param {string} [params.customerPhone]
 * @returns {Promise<Map<string, object>>} Map of employeeId → discount result (or null)
 */
export async function resolveDiscountsBatch({ businessId, employees, bookingDate, bookingTime, customerPhone }) {
    const results = new Map();

    // Run all resolutions in parallel
    await Promise.all(employees.map(async ({ employeeId, serviceId, basePrice }) => {
        try {
            const result = await resolveDiscount({
                businessId, employeeId, serviceId, basePrice,
                bookingDate, bookingTime, customerPhone,
            });
            results.set(employeeId, result);
        } catch (error) {
            console.error(`Error resolving discount for employee ${employeeId}:`, error);
            results.set(employeeId, null);
        }
    }));

    return results;
}

/**
 * Check if a discount's trigger conditions match the booking context.
 */
function matchesTrigger(discount, bookingDate, bookingTime, visitCount, customerPhone) {
    switch (discount.trigger) {
        case 'date_range':
            return bookingDate >= discount.date_start && bookingDate <= discount.date_end;

        case 'day_of_week': {
            // bookingDate is "YYYY-MM-DD", parse to get day of week
            // JS Date.getDay(): 0=Sun, our format: 1=Mon..7=Sun
            const date = new Date(bookingDate + 'T00:00:00+05:00'); // Tashkent timezone
            const jsDay = date.getDay(); // 0=Sun
            const ourDay = jsDay === 0 ? 7 : jsDay; // Convert: 1=Mon..7=Sun
            return Array.isArray(discount.days_of_week) && discount.days_of_week.includes(ourDay);
        }

        case 'time_of_day':
            if (discount.time_start == null || discount.time_end == null) return false;
            return bookingTime >= discount.time_start && bookingTime <= discount.time_end;

        case 'first_visit':
            // Only applies if customer phone is provided and visit count is 0
            return !!customerPhone && visitCount === 0;

        case 'scheduled': {
            // All present conditions must match (AND logic)
            const date = new Date(bookingDate + 'T00:00:00+05:00');
            const jsDay = date.getDay();
            const ourDay = jsDay === 0 ? 7 : jsDay;

            // Check days_of_week if set
            if (Array.isArray(discount.days_of_week) && discount.days_of_week.length > 0) {
                if (!discount.days_of_week.includes(ourDay)) return false;
            }
            // Check time range if set
            if (discount.time_start != null && discount.time_end != null) {
                if (bookingTime < discount.time_start || bookingTime > discount.time_end) return false;
            }
            // Check date range if set
            if (discount.date_start && discount.date_end) {
                if (bookingDate < discount.date_start || bookingDate > discount.date_end) return false;
            }
            return true;
        }

        default:
            return false;
    }
}

/**
 * Calculate savings in so'm for a given discount.
 */
function calculateSavings(basePrice, discountType, discountValue) {
    if (discountType === 'percentage') {
        return Math.round(basePrice * (Math.min(discountValue, 100) / 100));
    }
    // Fixed amount — can't save more than the price
    return Math.min(discountValue, basePrice);
}

/**
 * Sanitize phone number for use as Firestore document ID.
 * Removes any non-digit characters.
 */
function sanitizePhone(phone) {
    return phone.replace(/\D/g, '');
}
