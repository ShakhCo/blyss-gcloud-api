import { Router } from 'express';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { verifyOtpSchema } from '../schemas/otp.js';

const router = Router();

// OTP expiry time in minutes
const OTP_EXPIRY_MINUTES = 15;

router.post('/verify', validate(verifyOtpSchema), async (req, res) => {
    try {
        const { user_id, otp_code } = req.validated;

        // Find OTP for user
        const otpSnapshot = await db.collection('otps')
            .where('user_id', '==', user_id)
            .where('otp_code', '==', String(otp_code))
            .where('used', '==', false)
            .orderBy('date_created', 'desc')
            .limit(1)
            .get();

        if (otpSnapshot.empty) {
            return res.status(400).json({ error: 'Invalid OTP', error_code: 'INVALID_OTP' });
        }

        const otpDoc = otpSnapshot.docs[0];
        const otpData = otpDoc.data();

        // Check if OTP is expired
        const otpDate = otpData.date_created.toDate();
        const now = new Date();
        const diffMinutes = (now - otpDate) / (1000 * 60);

        if (diffMinutes > OTP_EXPIRY_MINUTES) {
            return res.status(400).json({ error: 'OTP has expired', error_code: 'OTP_EXPIRED' });
        }

        // Mark OTP as used
        await otpDoc.ref.update({ used: true });

        // Update user's is_verified status
        await db.collection('users').doc(user_id).update({ is_verified: true });

        // Get updated user
        const userDoc = await db.collection('users').doc(user_id).get();
        const user = { id: userDoc.id, ...userDoc.data() };

        res.json({ message: 'OTP verified successfully', is_verified: true, user });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
