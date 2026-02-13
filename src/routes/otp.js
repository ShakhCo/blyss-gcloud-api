import { Router } from 'express';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { verifyOtpSchema, sendOtpSchema } from '../schemas/otp.js';
import { sendOtpSms } from '../utils/eskiz.js';
import { sendTelegramMessage } from '../utils/telegram.js';

const router = Router();

// OTP expiry time in minutes
const OTP_EXPIRY_MINUTES = 15;

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
        const otpCode = Math.floor(10000 + Math.random() * 90000).toString();

        // Try sending SMS via canonical sendOtpSms template
        const smsResult = await sendOtpSms(phone_number, otpCode, user_type);

        let deliveryMethod = null;

        if (smsResult.success) {
            deliveryMethod = 'sms';
        } else {
            // SMS failed — try Telegram fallback if user has telegram_id
            console.log(`[otp/send] SMS failed for ${phone_number}, trying Telegram fallback...`);
            if (userData.telegram_id) {
                try {
                    await sendTelegramMessage(
                        userData.telegram_id,
                        `🔐 <b>${otpCode}</b> — BLYSS kirish kodi.\n\nКод входа в BLYSS: <b>${otpCode}</b>`
                    );
                    deliveryMethod = 'telegram';
                    console.log(`[otp/send] OTP sent via Telegram to ${collection} ${userDoc.id}`);
                } catch (telegramError) {
                    console.error('[otp/send] Telegram fallback also failed:', telegramError);
                }
            }
        }

        // Only store OTP if delivery succeeded
        if (!deliveryMethod) {
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
            delivery_method: deliveryMethod
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

router.post('/verify', validate(verifyOtpSchema), async (req, res) => {
    try {
        const { user_id, otp_code, user_type } = req.validated;

        // Determine collection based on user_type
        const collection = user_type === 'business_owner' ? 'business_owners' : 'users';

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
        await db.collection(collection).doc(user_id).update({ is_verified: true });

        // Get updated user
        const userDocRef = await db.collection(collection).doc(user_id).get();
        const user = { id: userDocRef.id, ...userDocRef.data() };

        res.json({ message: 'OTP verified successfully', is_verified: true, user });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
