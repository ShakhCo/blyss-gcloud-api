import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { authenticate, ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../middleware/authenticate.js';
import { generateTokenPair, getAccessTokenExpiration, getRefreshTokenExpiration, getCookieExpiration, decodeToken, verifyRefreshToken } from '../utils/jwt.js';
import { sendOtpSms } from '../utils/eskiz.js';
import {
    sendOtpSchema,
    verifyOtpSchema,
    loginSchema,
    registerSchema,
    authResponseSchema,
    meResponseSchema
} from '../schemas/auth.js';

const router = Router();
const OTP_EXPIRY_MINUTES = 5;

// Rate limiters for sensitive auth endpoints
const otpSendLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many OTP requests, please try again later', error_code: 'RATE_LIMITED' },
    validate: { trustProxy: false }
});

const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification attempts, please try again later', error_code: 'RATE_LIMITED' },
    validate: { trustProxy: false }
});

/**
 * Helper function to set auth cookies
 */
const setAuthCookies = (res, accessToken, refreshToken) => {
    // Access token - httpOnly cookie (24 hours)
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    // Refresh token - httpOnly cookie (30 days)
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
};

/**
 * Helper function to clear auth cookies
 */
const clearAuthCookies = (res) => {
    res.clearCookie(ACCESS_TOKEN_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
    res.clearCookie(REFRESH_TOKEN_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
};

// POST /auth/send-otp
router.post('/send-otp', otpSendLimiter, validate(sendOtpSchema), async (req, res) => {
    try {
        const { phone_number, user_type } = req.validated;

        // Rate limiting: Check for recent OTP within last 60 seconds
        const recentOtp = await db.collection('otps')
            .where('phone_number', '==', phone_number)
            .where('is_verified', '==', false)
            .orderBy('date_created', 'desc')
            .limit(1)
            .get();

        if (!recentOtp.empty) {
            const lastOtp = recentOtp.docs[0].data();
            const lastOtpDate = lastOtp.date_created.toDate();
            const secondsSinceLastOtp = (new Date() - lastOtpDate) / 1000;

            if (secondsSinceLastOtp < 60) {
                return res.status(429).json({
                    error: 'Please wait before requesting another OTP',
                    error_code: 'RATE_LIMIT_EXCEEDED'
                });
            }
        }

        // Generate OTP
        const otpCode = crypto.randomInt(10000, 100000).toString();
        const dateCreated = new Date();
        const expiresAt = new Date(dateCreated.getTime() + OTP_EXPIRY_MINUTES * 60000);

        // Hash OTP before storing
        const otpHash = await bcrypt.hash(otpCode, 10);

        // Create OTP document
        const otpDoc = await db.collection('otps').add({
            phone_number,
            otp_code: otpHash,
            is_verified: false,
            is_used: false,
            user_type,
            date_created: dateCreated,
            verified_at: null,
            expires_at: expiresAt
        });

        // Send OTP via SMS + Telegram
        const result = await sendOtpSms(phone_number, otpCode, user_type);

        res.json({
            message: result.success ? 'OTP sent successfully' : 'OTP created but delivery failed',
            sms_sent: result.success,
            delivery_method: result.delivery_method
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// POST /auth/verify-otp
router.post('/verify-otp', otpVerifyLimiter, validate(verifyOtpSchema), async (req, res) => {
    try {
        const { phone_number, otp_code, user_type } = req.validated;

        // Find latest unused OTP by phone number (without matching code, to track attempts)
        const otpSnapshot = await db.collection('otps')
            .where('phone_number', '==', phone_number)
            .where('is_verified', '==', false)
            .orderBy('date_created', 'desc')
            .limit(1)
            .get();

        if (otpSnapshot.empty) {
            return res.status(400).json({
                error: 'Invalid OTP code',
                error_code: 'INVALID_OTP'
            });
        }

        const otpDoc = otpSnapshot.docs[0];
        const otpData = otpDoc.data();

        // Check attempt limit (max 5 tries per OTP)
        const attempts = otpData.attempts || 0;
        if (attempts >= 5) {
            // Invalidate the OTP
            await otpDoc.ref.update({ is_verified: true });
            return res.status(429).json({
                error: 'Too many failed attempts. Please request a new code.',
                error_code: 'OTP_MAX_ATTEMPTS'
            });
        }

        // Check if OTP is expired
        const now = new Date();
        const expiresAt = otpData.expires_at.toDate();

        if (now > expiresAt) {
            return res.status(400).json({
                error: 'OTP has expired',
                error_code: 'OTP_EXPIRED'
            });
        }

        // Verify OTP code (supports both bcrypt hash and legacy plaintext)
        const storedCode = otpData.otp_code;
        const inputCode = String(otp_code);
        const isBcryptHash = storedCode.startsWith('$2');
        const isMatch = isBcryptHash
            ? await bcrypt.compare(inputCode, storedCode)
            : storedCode === inputCode;

        if (!isMatch) {
            // Increment attempt counter
            await otpDoc.ref.update({ attempts: attempts + 1 });
            return res.status(400).json({
                error: 'Invalid OTP code',
                error_code: 'INVALID_OTP'
            });
        }

        // Mark OTP as verified
        await otpDoc.ref.update({
            is_verified: true,
            verified_at: now
        });

        // Check if user exists and update is_verified if not already verified
        const collection = user_type === 'business_owner' ? 'business_owners' : 'users';
        const userSnapshot = await db.collection(collection)
            .where('phone_number', '==', phone_number)
            .limit(1)
            .get();

        if (!userSnapshot.empty) {
            const userDoc = userSnapshot.docs[0];
            const userData = userDoc.data();
            if (!userData.is_verified) {
                await userDoc.ref.update({ is_verified: true });
            }
        }

        res.json({
            message: 'OTP verified successfully',
            otp_id: otpDoc.id
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// POST /auth/login
router.post('/login', validate(loginSchema), async (req, res) => {
    try {
        const { otp_id, phone_number, user_type } = req.validated;

        // Fetch OTP document
        const otpDoc = await db.collection('otps').doc(otp_id).get();

        if (!otpDoc.exists) {
            return res.status(404).json({
                error: 'OTP not found',
                error_code: 'OTP_NOT_FOUND'
            });
        }

        const otpData = otpDoc.data();

        // Verify OTP is verified and not used
        if (!otpData.is_verified) {
            return res.status(400).json({
                error: 'OTP not verified',
                error_code: 'OTP_NOT_VERIFIED'
            });
        }

        if (otpData.is_used) {
            return res.status(400).json({
                error: 'OTP already used',
                error_code: 'OTP_ALREADY_USED'
            });
        }

        // Verify phone numbers match
        if (otpData.phone_number !== phone_number) {
            return res.status(400).json({
                error: 'Phone number mismatch',
                error_code: 'PHONE_MISMATCH'
            });
        }

        // Find user by phone number
        const collection = user_type === 'business_owner' ? 'business_owners' : 'users';
        const userSnapshot = await db.collection(collection)
            .where('phone_number', '==', phone_number)
            .get();

        if (userSnapshot.empty) {
            return res.status(404).json({
                error: 'User not found. Please register first.',
                error_code: 'USER_NOT_FOUND'
            });
        }

        const userDoc = userSnapshot.docs[0];
        const userData = userDoc.data();

        // Mark OTP as used
        await otpDoc.ref.update({ is_used: true });

        // Generate token pair (no PII in payload)
        const tokenPayload = {
            user_id: userDoc.id,
            user_type: user_type
        };

        const { accessToken, refreshToken } = generateTokenPair(tokenPayload);

        // Set cookies
        setAuthCookies(res, accessToken, refreshToken);

        // Return response with user data and tokens (for non-cookie clients)
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours

        const response = {
            user: {
                id: userDoc.id,
                user_type: user_type,
                first_name: userData.first_name,
                last_name: userData.last_name || '',
                phone_number: userData.phone_number,
                telegram_id: userData.telegram_id || null,
                is_verified: userData.is_verified || false,
                created_at: userData.created_at?.toDate?.().toISOString() || userData.date_created?.toDate?.().toISOString()
            },
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt.toISOString()
        };

        res.json(authResponseSchema.parse(response));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// POST /auth/register
router.post('/register', validate(registerSchema), async (req, res) => {
    try {
        const { otp_id, user_type, ...userData } = req.validated;

        // Fetch OTP document
        const otpDoc = await db.collection('otps').doc(otp_id).get();

        if (!otpDoc.exists) {
            return res.status(404).json({
                error: 'OTP not found',
                error_code: 'OTP_NOT_FOUND'
            });
        }

        const otpData = otpDoc.data();

        // Verify OTP is verified and not used
        if (!otpData.is_verified) {
            return res.status(400).json({
                error: 'OTP not verified',
                error_code: 'OTP_NOT_VERIFIED'
            });
        }

        if (otpData.is_used) {
            return res.status(400).json({
                error: 'OTP already used',
                error_code: 'OTP_ALREADY_USED'
            });
        }

        // Determine collection and phone number
        const collection = user_type === 'business_owner' ? 'business_owners' : 'users';
        const phoneNumber = otpData.phone_number;

        // Check if phone number already exists
        const existingUser = await db.collection(collection)
            .where('phone_number', '==', phoneNumber)
            .get();

        if (!existingUser.empty) {
            return res.status(409).json({
                error: 'Phone number already registered',
                error_code: 'PHONE_EXISTS'
            });
        }

        // Generate unique user ID
        let userId;
        let userExists = true;
        while (userExists) {
            userId = crypto.randomBytes(user_type === 'business_owner' ? 8 : 16).toString('hex');
            const existingDoc = await db.collection(collection).doc(userId).get();
            userExists = existingDoc.exists;
        }

        // Create user
        const dateCreated = new Date();
        const createData = {
            first_name: userData.first_name,
            last_name: userData.last_name || '',
            phone_number: phoneNumber,
            is_verified: true,
            created_at: dateCreated
        };

        if (user_type === 'user' && userData.telegram_id !== undefined) {
            createData.telegram_id = userData.telegram_id;
        }

        if (user_type === 'business_owner' && userData.telegram_id !== undefined) {
            createData.telegram_id = userData.telegram_id ?? null;
        }

        await db.collection(collection).doc(userId).set(createData);

        // If registering as business_owner, update any existing employee records with this phone number
        if (user_type === 'business_owner') {
            try {
                // Find all employees with this phone number that have no business_owner_id
                const employeesSnapshot = await db.collectionGroup('employees')
                    .where('phone_number', '==', phoneNumber)
                    .where('business_owner_id', '==', null)
                    .get();

                if (!employeesSnapshot.empty) {
                    const batch = db.batch();
                    employeesSnapshot.docs.forEach(doc => {
                        batch.update(doc.ref, { business_owner_id: userId });
                    });
                    await batch.commit();
                }
            } catch (updateError) {
                console.error('Failed to update employee business_owner_id:', updateError);
                // Don't fail registration if this update fails
            }
        }

        // Return success response
        res.status(201).json({
            success: true
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
    try {
        // Get refresh token from cookie or body
        let refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];

        // If not in cookie, check request body
        if (!refreshToken && req.body?.refresh_token) {
            refreshToken = req.body.refresh_token;
        }

        if (!refreshToken) {
            return res.status(401).json({
                error: 'Refresh token required',
                error_code: 'NO_REFRESH_TOKEN'
            });
        }

        // Check revocation BEFORE verifying JWT signature — use decodeToken (no throw on invalid)
        const tokenPayloadForRevocation = decodeToken(refreshToken);
        if (tokenPayloadForRevocation && tokenPayloadForRevocation.user_id && tokenPayloadForRevocation.iat) {
            const docId = `${tokenPayloadForRevocation.user_id}_${tokenPayloadForRevocation.iat}`;
            const revokedDoc = await db.collection('revoked_tokens').doc(docId).get();
            if (revokedDoc.exists) {
                clearAuthCookies(res);
                return res.status(401).json({
                    error: 'Token has been revoked',
                    error_code: 'TOKEN_REVOKED'
                });
            }
        }

        // Verify refresh token
        const decoded = verifyRefreshToken(refreshToken);
        if (!decoded) {
            clearAuthCookies(res);
            return res.status(401).json({
                error: 'Invalid or expired refresh token',
                error_code: 'INVALID_REFRESH_TOKEN'
            });
        }

        // Fetch user data
        const collection = decoded.user_type === 'business_owner' ? 'business_owners' : 'users';
        const userDoc = await db.collection(collection).doc(decoded.user_id).get();

        if (!userDoc.exists) {
            clearAuthCookies(res);
            return res.status(401).json({
                error: 'User not found',
                error_code: 'USER_NOT_FOUND'
            });
        }

        const userData = userDoc.data();

        // Generate new token pair (no PII in payload)
        const tokenPayload = {
            user_id: userDoc.id,
            user_type: decoded.user_type
        };

        const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(tokenPayload);

        // Set new cookies
        setAuthCookies(res, accessToken, newRefreshToken);

        // Return response
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        res.json({
            access_token: accessToken,
            refresh_token: newRefreshToken,
            expires_at: expiresAt.toISOString()
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req, res) => {
    try {
        // Revoke refresh token if present — write to Firestore revoked_tokens
        const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
        if (refreshToken) {
            try {
                const decoded = decodeToken(refreshToken);
                if (decoded && decoded.user_id && decoded.iat) {
                    const docId = `${decoded.user_id}_${decoded.iat}`;
                    // expiresAt matches the token's own expiry (for future TTL-based cleanup)
                    const expiresAt = decoded.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                    await db.collection('revoked_tokens').doc(docId).set({
                        revokedAt: new Date(),
                        userId: decoded.user_id,
                        expiresAt
                    });
                }
            } catch (revocationError) {
                // Revocation failure must never block logout — log and continue
                console.error('Failed to revoke refresh token:', revocationError);
            }
        }

        // Clear cookies
        clearAuthCookies(res);

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// POST /auth/logout-all
router.post('/logout-all', authenticate, async (req, res) => {
    try {
        // Clear cookies
        clearAuthCookies(res);

        res.json({ message: 'Logged out from all devices successfully' });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// GET /auth/me
router.get('/me', authenticate, async (req, res) => {
    try {
        const user = req.user;

        const response = {
            id: user.id,
            user_type: user.user_type,
            first_name: user.first_name,
            last_name: user.last_name || '',
            phone_number: user.phone_number,
            telegram_id: user.telegram_id || null,
            is_verified: user.is_verified || false,
            created_at: user.created_at?.toDate?.().toISOString() || user.date_created?.toDate?.().toISOString()
        };

        res.json(meResponseSchema.parse(response));
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
