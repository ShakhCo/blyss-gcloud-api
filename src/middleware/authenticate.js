import { verifyAccessToken } from '../utils/jwt.js';
import { db } from '../db/db.js';

// Cookie names
const ACCESS_TOKEN_COOKIE = 'access_token';
const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * Extract access token from request (cookies or Authorization header)
 * @param {Object} req - Express request object
 * @returns {string|null} The access token or null
 */
const extractAccessToken = (req) => {
    // First try to get from cookie
    if (req.cookies && req.cookies[ACCESS_TOKEN_COOKIE]) {
        return req.cookies[ACCESS_TOKEN_COOKIE];
    }

    // Then try to get from Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }

    return null;
};

/**
 * Authentication middleware to verify JWT tokens
 * and attach user data to the request
 * Supports both cookie-based and header-based authentication
 */
export const authenticate = async (req, res, next) => {
    try {
        const token = extractAccessToken(req);

        if (!token) {
            return res.status(401).json({
                error: 'Authorization token required',
                error_code: 'NO_TOKEN'
            });
        }

        // Verify token
        const decoded = verifyAccessToken(token);
        if (!decoded) {
            return res.status(401).json({
                error: 'Invalid or expired token',
                error_code: 'INVALID_TOKEN'
            });
        }

        // Fetch user data from Firestore
        const collection = decoded.user_type === 'business_owner'
            ? 'business_owners'
            : 'users';

        const userDoc = await db.collection(collection).doc(decoded.user_id).get();
        if (!userDoc.exists) {
            return res.status(401).json({
                error: 'User not found',
                error_code: 'USER_NOT_FOUND'
            });
        }

        // Attach user to request
        req.user = {
            id: userDoc.id,
            ...userDoc.data(),
            user_type: decoded.user_type
        };

        next();
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
};

/**
 * Optional authentication middleware - attaches user if token exists,
 * but doesn't require it
 */
export const optionalAuthenticate = async (req, res, next) => {
    try {
        const token = extractAccessToken(req);

        if (!token) {
            req.user = null;
            return next();
        }

        // Verify token
        const decoded = verifyAccessToken(token);
        if (!decoded) {
            req.user = null;
            return next();
        }

        // Fetch user data
        const collection = decoded.user_type === 'business_owner'
            ? 'business_owners'
            : 'users';

        const userDoc = await db.collection(collection).doc(decoded.user_id).get();
        if (!userDoc.exists) {
            req.user = null;
            return next();
        }

        req.user = {
            id: userDoc.id,
            ...userDoc.data(),
            user_type: decoded.user_type
        };

        next();
    } catch (error) {
        req.user = null;
        next();
    }
};

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
