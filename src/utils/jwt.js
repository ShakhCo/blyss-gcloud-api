import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is required. Server cannot start without it.');
}
const ACCESS_TOKEN_EXPIRY = '24h'; // 24 hours
const REFRESH_TOKEN_EXPIRY = '30d'; // 30 days

// Token types for different purposes
const TokenTypes = {
    ACCESS: 'access',
    REFRESH: 'refresh'
};

/**
 * Generate an access token (short-lived)
 * @param {Object} payload - The payload to include in the token
 * @returns {string} The generated access token
 */
export const generateAccessToken = (payload) => {
    return jwt.sign(
        { ...payload, type: TokenTypes.ACCESS },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
};

/**
 * Generate a refresh token (long-lived)
 * @param {Object} payload - The payload to include in the token
 * @returns {string} The generated refresh token
 */
export const generateRefreshToken = (payload) => {
    return jwt.sign(
        { ...payload, type: TokenTypes.REFRESH },
        JWT_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRY }
    );
};

/**
 * Generate both access and refresh tokens
 * @param {Object} payload - The payload to include in the tokens
 * @returns {Object} Object containing access and refresh tokens
 */
export const generateTokenPair = (payload) => {
    return {
        accessToken: generateAccessToken(payload),
        refreshToken: generateRefreshToken(payload)
    };
};

/**
 * Verify and decode a JWT token
 * @param {string} token - The JWT token to verify
 * @returns {Object|null} The decoded payload or null if invalid
 */
export const verifyToken = (token) => {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
};

/**
 * Verify an access token specifically
 * @param {string} token - The access token to verify
 * @returns {Object|null} The decoded payload or null if invalid
 */
export const verifyAccessToken = (token) => {
    const decoded = verifyToken(token);
    if (decoded && decoded.type === TokenTypes.ACCESS) {
        return decoded;
    }
    return null;
};

/**
 * Verify a refresh token specifically
 * @param {string} token - The refresh token to verify
 * @returns {Object|null} The decoded payload or null if invalid
 */
export const verifyRefreshToken = (token) => {
    const decoded = verifyToken(token);
    if (decoded && decoded.type === TokenTypes.REFRESH) {
        return decoded;
    }
    return null;
};

/**
 * Get the expiration timestamp for access token (24 hours from now)
 * @returns {number} Expiration timestamp in seconds
 */
export const getAccessTokenExpiration = () => {
    const now = Math.floor(Date.now() / 1000);
    return now + (24 * 60 * 60); // 24 hours in seconds
};

/**
 * Get the expiration timestamp for refresh token (30 days from now)
 * @returns {number} Expiration timestamp in seconds
 */
export const getRefreshTokenExpiration = () => {
    const now = Math.floor(Date.now() / 1000);
    return now + (30 * 24 * 60 * 60); // 30 days in seconds
};

/**
 * Decode a token without verification (for getting expiry time)
 * @param {string} token - The JWT token to decode
 * @returns {Object|null} The decoded payload or null if invalid
 */
export const decodeToken = (token) => {
    try {
        return jwt.decode(token);
    } catch (error) {
        return null;
    }
};

/**
 * Calculate cookie expiration date from days
 * @param {number} days - Number of days until expiration
 * @returns {Date} Expiration date
 */
export const getCookieExpiration = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
};

export { TokenTypes };
