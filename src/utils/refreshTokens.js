import { db } from '../db/db.js';
import crypto from 'crypto';

/**
 * Store a refresh token in Firestore
 * @param {string} userId - The user ID
 * @param {string} userType - The user type ('user' or 'business_owner')
 * @param {string} refreshToken - The refresh token
 * @param {number} expiresAt - Expiration timestamp in seconds
 * @returns {Promise<string>} The refresh token document ID
 */
export const storeRefreshToken = async (userId, userType, refreshToken, expiresAt) => {
    // Generate a unique token ID
    let tokenId;
    let tokenExists = true;
    while (tokenExists) {
        tokenId = crypto.randomBytes(16).toString('hex');
        const existingDoc = await db.collection('refresh_tokens').doc(tokenId).get();
        tokenExists = existingDoc.exists;
    }

    await db.collection('refresh_tokens').doc(tokenId).set({
        user_id: userId,
        user_type: userType,
        token: refreshToken,
        created_at: new Date(),
        expires_at: new Date(expiresAt * 1000),
        is_revoked: false
    });

    return tokenId;
};

/**
 * Find a refresh token by its value
 * @param {string} refreshToken - The refresh token value
 * @returns {Promise<Object|null>} The token document or null if not found
 */
export const findRefreshToken = async (refreshToken) => {
    const snapshot = await db.collection('refresh_tokens')
        .where('token', '==', refreshToken)
        .where('is_revoked', '==', false)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    // Check if token is expired
    const now = new Date();
    const expiresAt = data.expires_at.toDate();

    if (now > expiresAt) {
        // Delete expired token
        await doc.ref.delete();
        return null;
    }

    return { id: doc.id, ...data };
};

/**
 * Revoke a refresh token
 * @param {string} tokenId - The refresh token document ID
 * @returns {Promise<boolean>} True if successfully revoked
 */
export const revokeRefreshToken = async (tokenId) => {
    await db.collection('refresh_tokens').doc(tokenId).update({
        is_revoked: true,
        revoked_at: new Date()
    });
    return true;
};

/**
 * Revoke all refresh tokens for a user
 * @param {string} userId - The user ID
 * @param {string} userType - The user type
 * @returns {Promise<number>} Number of tokens revoked
 */
export const revokeAllUserTokens = async (userId, userType) => {
    const snapshot = await db.collection('refresh_tokens')
        .where('user_id', '==', userId)
        .where('user_type', '==', userType)
        .where('is_revoked', '==', false)
        .get();

    if (snapshot.empty) {
        return 0;
    }

    const batch = db.batch();
    snapshot.docs.forEach(doc => {
        batch.update(doc.ref, {
            is_revoked: true,
            revoked_at: new Date()
        });
    });

    await batch.commit();
    return snapshot.size;
};

/**
 * Clean up expired and revoked refresh tokens
 * Should be run periodically (e.g., daily cron job)
 * @returns {Promise<number>} Number of tokens deleted
 */
export const cleanupExpiredTokens = async () => {
    const now = new Date();

    // Delete expired tokens
    const expiredSnapshot = await db.collection('refresh_tokens')
        .where('expires_at', '<', now)
        .get();

    // Delete revoked tokens older than 7 days
    const revokedDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const revokedSnapshot = await db.collection('refresh_tokens')
        .where('is_revoked', '==', true)
        .where('revoked_at', '<', revokedDate)
        .get();

    const batch = db.batch();
    let deleteCount = 0;

    expiredSnapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        deleteCount++;
    });

    revokedSnapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        deleteCount++;
    });

    if (deleteCount > 0) {
        await batch.commit();
    }

    return deleteCount;
};

/**
 * Get all active refresh tokens for a user
 * @param {string} userId - The user ID
 * @param {string} userType - The user type
 * @returns {Promise<Array>} Array of active refresh tokens
 */
export const getUserActiveTokens = async (userId, userType) => {
    const snapshot = await db.collection('refresh_tokens')
        .where('user_id', '==', userId)
        .where('user_type', '==', userType)
        .where('is_revoked', '==', false)
        .get();

    return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
    }));
};
