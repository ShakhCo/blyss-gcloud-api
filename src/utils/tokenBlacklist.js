import { db } from '../db/db.js';

/**
 * Add a token to the blacklist
 * @param {string} token - The JWT token to blacklist
 * @param {number} expiresAt - Expiration timestamp in seconds
 */
export const addToBlacklist = async (token, expiresAt) => {
    await db.collection('token_blacklist').add({
        token,
        blacklisted_at: new Date(),
        expires_at: new Date(expiresAt * 1000)
    });
};

/**
 * Check if a token is blacklisted
 * @param {string} token - The JWT token to check
 * @returns {Promise<boolean>} True if token is blacklisted
 */
export const isTokenBlacklisted = async (token) => {
    const snapshot = await db.collection('token_blacklist')
        .where('token', '==', token)
        .limit(1)
        .get();

    return !snapshot.empty;
};

/**
 * Clean up expired tokens from the blacklist
 * Should be run periodically (e.g., daily cron job)
 */
export const cleanupExpiredTokens = async () => {
    const now = new Date();
    const snapshot = await db.collection('token_blacklist')
        .where('expires_at', '<', now)
        .get();

    if (snapshot.empty) {
        return { deleted: 0 };
    }

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));

    await batch.commit();
    return { deleted: snapshot.size };
};
