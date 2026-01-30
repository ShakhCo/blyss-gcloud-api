import crypto from 'crypto';
import { verifyAccessToken } from '../utils/jwt.js';
import { db } from '../db/db.js';

// API secret for HMAC verification
const API_SECRET = process.env.API_SECRET;

// Max allowed timestamp difference (30 seconds)
const MAX_TIMESTAMP_DIFF = 30;

/**
 * Verify HMAC-SHA256 signature
 * @param {string} body - Request body as string
 * @param {string} timestamp - Timestamp from header
 * @param {string} signature - Signature from header
 * @returns {boolean} Whether the signature is valid
 */
const verifyHmacSignature = (body, timestamp, signature) => {
    const message = body + timestamp;
    const expectedSignature = crypto
        .createHmac('sha256', API_SECRET)
        .update(message)
        .digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
};

/**
 * Verify request signature and timestamp
 * @param {Object} req - Express request object
 * @returns {{ valid: boolean, error?: string, error_code?: string }}
 */
const verifyRequestSignature = (req) => {
    const invalidSignatureResponse = {
        valid: false,
        error: 'Invalid signature',
        error_code: 'INVALID_SIGNATURE'
    };

    // Skip signature verification if API_SECRET is not configured
    if (!API_SECRET) {
        return { valid: true };
    }

    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    if (!timestamp || !signature) {
        return invalidSignatureResponse;
    }

    // Check timestamp is not too old or in the future
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);

    if (isNaN(requestTime)) {
        return invalidSignatureResponse;
    }

    const timeDiff = now - requestTime;
    if (Math.abs(timeDiff) > MAX_TIMESTAMP_DIFF) {
        return invalidSignatureResponse;
    }

    // Get raw body for signature verification
    const body = req.body && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body)
        : '';

    const message = body + timestamp;
    const expectedSignature = crypto
        .createHmac('sha256', API_SECRET)
        .update(message)
        .digest('hex');

    try {
        const isValid = signature.length === expectedSignature.length &&
            crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

        if (!isValid) {
            return invalidSignatureResponse;
        }
    } catch (error) {
        return invalidSignatureResponse;
    }

    return { valid: true };
};

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
        // Verify HMAC signature first
        const signatureResult = verifyRequestSignature(req);
        if (!signatureResult.valid) {
            return res.status(401).json({
                error: signatureResult.error,
                error_code: signatureResult.error_code
            });
        }

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
        // Verify HMAC signature first
        const signatureResult = verifyRequestSignature(req);
        if (!signatureResult.valid) {
            return res.status(401).json({
                error: signatureResult.error,
                error_code: signatureResult.error_code
            });
        }

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

/**
 * Signature verification middleware (without JWT authentication)
 * Use this for public routes that still need request signing
 */
export const verifySignature = (req, res, next) => {
    const signatureResult = verifyRequestSignature(req);
    if (!signatureResult.valid) {
        return res.status(401).json({
            error: signatureResult.error,
            error_code: signatureResult.error_code
        });
    }
    next();
};

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
