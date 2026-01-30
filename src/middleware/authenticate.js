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
 * @returns {{ valid: boolean, error?: string, error_code?: string, debug?: object }}
 */
const verifyRequestSignature = (req) => {
    // Skip signature verification if API_SECRET is not configured
    if (!API_SECRET) {
        return { valid: true };
    }

    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    if (!timestamp && !signature) {
        return {
            valid: false,
            error: 'Missing both X-Timestamp and X-Signature headers',
            error_code: 'MISSING_SIGNATURE'
        };
    }

    if (!timestamp) {
        return {
            valid: false,
            error: 'Missing X-Timestamp header',
            error_code: 'MISSING_TIMESTAMP'
        };
    }

    if (!signature) {
        return {
            valid: false,
            error: 'Missing X-Signature header',
            error_code: 'MISSING_SIGNATURE'
        };
    }

    // Check timestamp is not too old or in the future
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);

    if (isNaN(requestTime)) {
        return {
            valid: false,
            error: 'X-Timestamp is not a valid number',
            error_code: 'INVALID_TIMESTAMP',
            debug: { received_timestamp: timestamp }
        };
    }

    const timeDiff = now - requestTime;
    if (Math.abs(timeDiff) > MAX_TIMESTAMP_DIFF) {
        return {
            valid: false,
            error: `Request timestamp expired. Difference: ${timeDiff}s (max allowed: ${MAX_TIMESTAMP_DIFF}s)`,
            error_code: 'TIMESTAMP_EXPIRED',
            debug: {
                server_time: now,
                request_time: requestTime,
                difference_seconds: timeDiff
            }
        };
    }

    // Get raw body for signature verification
    const body = req.body && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body)
        : '{}';

    const message = body + timestamp;
    const expectedSignature = crypto
        .createHmac('sha256', API_SECRET)
        .update(message)
        .digest('hex');

    try {
        const isValid = signature.length === expectedSignature.length &&
            crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

        if (!isValid) {
            return {
                valid: false,
                error: 'Signature mismatch. Check that body and timestamp match on client and server',
                error_code: 'SIGNATURE_MISMATCH',
                debug: {
                    body_used: body,
                    timestamp_used: timestamp,
                    message_signed: message,
                    expected_signature: expectedSignature,
                    received_signature: signature
                }
            };
        }
    } catch (error) {
        return {
            valid: false,
            error: `Signature verification error: ${error.message}`,
            error_code: 'SIGNATURE_ERROR',
            debug: {
                body_used: body,
                timestamp_used: timestamp,
                expected_length: expectedSignature.length,
                received_length: signature.length
            }
        };
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
                error_code: signatureResult.error_code,
                ...(signatureResult.debug && { debug: signatureResult.debug })
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
                error_code: signatureResult.error_code,
                ...(signatureResult.debug && { debug: signatureResult.debug })
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

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
