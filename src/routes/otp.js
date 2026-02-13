import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { verifyOtpSchema, sendOtpSchema } from '../schemas/otp.js';
import { sendOtpSms } from '../utils/eskiz.js';

const router = Router();

// OTP expiry time in minutes
const OTP_EXPIRY_MINUTES = 5;

router.post('/send', validate(sendOtpSchema), async (req, res) => {
    try {
        const { phone_number, user_type } = req.validated;

        // Determine collection based on user_type
        const collection = user_type === 'business_owner' ? 'business_owners' : 'users';

        // Find user by phone number
        const userSnapshot = await db.collection(collection)
            .where('phone_number', '==', phone_number)
            .get();

        if (userSnapshot.empty) {
            const errorMsg = user_type === 'business_owner' ? 'Business owner not found' : 'User not found';
            return res.status(404).json({ error: errorMsg, error_code: 'USER_NOT_FOUND' });
        }

        const userDoc = userSnapshot.docs[0];
        const userData = userDoc.data();

        // Generate OTP
        const otpCode = crypto.randomInt(10000, 100000).toString();

        // Send OTP via SMS + Telegram (handled internally by sendOtpSms)
        const result = await sendOtpSms(phone_number, otpCode, user_type);

        if (!result.success) {
            return res.status(503).json({
                error: 'Failed to deliver OTP. Please try again later.',
                error_code: 'OTP_DELIVERY_FAILED'
            });
        }

        // Store OTP
        await db.collection('otps').add({
            user_id: userDoc.id,
            user_type,
            otp_code: otpCode,
            date_created: new Date(),
            used: false
        });

        res.json({
            message: 'OTP sent successfully',
            user_id: userDoc.id,
            delivery_method: result.delivery_method
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

router.post('/verify', validate(verifyOtpSchema), async (req, res) => {
    try {
        const { user_id, otp_code, user_type } = req.validated;

        // Determine collection based on user_type
        const collection = user_type === 'business_owner' ? 'business_owners' : 'users';

        // Find latest unused OTP for user (without matching code, to track attempts)
        const otpSnapshot = await db.collection('otps')
            .where('user_id', '==', user_id)
            .where('used', '==', false)
            .orderBy('date_created', 'desc')
            .limit(1)
            .get();

        if (otpSnapshot.empty) {
            return res.status(400).json({ error: 'Invalid OTP', error_code: 'INVALID_OTP' });
        }

        const otpDoc = otpSnapshot.docs[0];
        const otpData = otpDoc.data();

        // Check attempt limit (max 5 tries per OTP)
        const attempts = otpData.attempts || 0;
        if (attempts >= 5) {
            // Invalidate the OTP
            await otpDoc.ref.update({ used: true });
            return res.status(429).json({
                error: 'Too many failed attempts. Please request a new code.',
                error_code: 'OTP_MAX_ATTEMPTS'
            });
        }

        // Check if OTP is expired
        const otpDate = otpData.date_created.toDate();
        const now = new Date();
        const diffMinutes = (now - otpDate) / (1000 * 60);

        if (diffMinutes > OTP_EXPIRY_MINUTES) {
            return res.status(400).json({ error: 'OTP has expired', error_code: 'OTP_EXPIRED' });
        }

        // Verify OTP code
        if (otpData.otp_code !== String(otp_code)) {
            // Increment attempt counter
            await otpDoc.ref.update({ attempts: attempts + 1 });
            return res.status(400).json({ error: 'Invalid OTP code', error_code: 'INVALID_OTP' });
        }

        // Mark OTP as used
        await otpDoc.ref.update({ used: true });

        // Update user's is_verified status
        await db.collection(collection).doc(user_id).update({ is_verified: true });

        // Get updated user
        const userDocRef = await db.collection(collection).doc(user_id).get();
        const user = { id: userDocRef.id, ...userDocRef.data() };

        res.json({ message: 'OTP verified successfully', is_verified: true, user });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
