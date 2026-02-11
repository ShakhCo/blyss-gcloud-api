import { db } from '../db/db.js';

// Maximum active (pending/confirmed) bookings a single user can have at any time
const MAX_ACTIVE_BOOKINGS_PER_USER = 3;

/**
 * Check if a user has reached their active booking limit.
 * Returns null if under the limit, or an error response object if over.
 * @param {string} userId
 * @returns {Promise<{count: number, limit: number} | null>}
 */
export async function checkUserBookingLimit(userId) {
    const activeBookings = await db.collection('bookings')
        .where('user_id', '==', userId)
        .where('status', 'in', ['pending', 'confirmed'])
        .get();

    if (activeBookings.size >= MAX_ACTIVE_BOOKINGS_PER_USER) {
        return { count: activeBookings.size, limit: MAX_ACTIVE_BOOKINGS_PER_USER };
    }

    return null;
}
