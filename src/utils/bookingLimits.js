import { db } from '../db/db.js';

// Maximum active (pending/confirmed) bookings a single user can have at any time
const MAX_ACTIVE_BOOKINGS_PER_USER = 3;

/**
 * Get today's date string in Uzbekistan timezone (GMT+5) as YYYY-MM-DD.
 */
function getTodayUzbekistan() {
    const now = new Date();
    const uzbekTime = new Date(now.getTime() + 5 * 3600000 + now.getTimezoneOffset() * 60000);
    const y = uzbekTime.getFullYear();
    const m = String(uzbekTime.getMonth() + 1).padStart(2, '0');
    const d = String(uzbekTime.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Check if a user has reached their active booking limit.
 * Only counts pending/confirmed bookings that are today or in the future.
 * Confirmed bookings in the past are not counted.
 * Returns null if under the limit, or an error response object if over.
 * @param {string} userId
 * @returns {Promise<{count: number, limit: number} | null>}
 */
export async function checkUserBookingLimit(userId) {
    const today = getTodayUzbekistan();

    const activeBookings = await db.collection('bookings')
        .where('user_id', '==', userId)
        .where('status', 'in', ['pending', 'confirmed'])
        .where('booking_date', '>=', today)
        .get();

    if (activeBookings.size >= MAX_ACTIVE_BOOKINGS_PER_USER) {
        return { count: activeBookings.size, limit: MAX_ACTIVE_BOOKINGS_PER_USER };
    }

    return null;
}
