import { Router } from 'express';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { verifyOtpSchema, sendOtpSchema } from '../schemas/otp.js';

const router = Router();

// OTP expiry time in minutes
const OTP_EXPIRY_MINUTES = 15;

router.post('/send', validate(sendOtpSchema), async (req, res) => {
    try {
        const { phone_number } = req.validated;

        // Find user by phone number
        const userSnapshot = await db.collection('users')
            .where('phone_number', '==', phone_number)
            .get();

        if (userSnapshot.empty) {
            return res.status(404).json({ error: 'User not found', error_code: 'USER_NOT_FOUND' });
        }

        const userDoc = userSnapshot.docs[0];

        // Generate OTP
        const otpCode = Math.floor(10000 + Math.random() * 90000).toString();

        // Store OTP
        await db.collection('otps').add({
            user_id: userDoc.id,
            otp_code: otpCode,
            date_created: new Date(),
            used: false
        });

        // Send SMS via Eskiz
        const eskizToken = process.env.ESKIZ_TOKEN;
        let otpSent = false;

        if (eskizToken) {
            try {
                await fetch('https://notify.eskiz.uz/api/message/sms/send', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${eskizToken}`
                    },
                    body: JSON.stringify({
                        mobile_phone: phone_number,
                        message: `BLYSS ilovasiga kirish uchun tasdiqlash kodi: ${otpCode}`,
                        from: '4546',
                        callback_url: ''
                    })
                });
                otpSent = true;
            } catch (smsError) {
                console.error('Failed to send SMS:', smsError);
            }
        }

        res.json({
            message: otpSent ? 'OTP sent successfully' : 'OTP created but SMS delivery failed',
            user_id: userDoc.id,
            sms_sent: otpSent
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

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
