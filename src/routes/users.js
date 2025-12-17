import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { userSchema, userResponseSchema, loginSchema } from '../schemas/user.js';

const router = Router();

router.get('/', async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc =>
            userResponseSchema.parse({ id: doc.id, ...doc.data() })
        );
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

router.post('/register', validate(userSchema), async (req, res) => {
    try {
        const { first_name, last_name, phone_number, telegram_id } = req.validated;

        // Check phone_number uniqueness
        const existingUser = await db.collection('users')
            .where('phone_number', '==', phone_number)
            .get();

        if (!existingUser.empty) {
            const existingDoc = existingUser.docs[0];
            const existingData = existingDoc.data();

            if (existingData.is_verified) {
                return res.status(409).json({ error: 'User already registered', error_code: 'USER_ALREADY_REGISTERED' });
            }

            // Delete unverified user to allow re-registration
            await existingDoc.ref.delete();
        }

        // Generate unique user ID
        let userId;
        let userExists = true;
        while (userExists) {
            userId = crypto.randomBytes(16).toString('hex');
            const existingDoc = await db.collection('users').doc(userId).get();
            userExists = existingDoc.exists;
        }

        // Create user
        await db.collection('users').doc(userId).set({
            first_name,
            last_name,
            phone_number,
            telegram_id,
            is_verified: false,
            created_at: new Date()
        });

        res.status(201).json(
            userResponseSchema.parse({ id: userId, first_name, last_name, phone_number, telegram_id, is_verified: false })
        );
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

router.post('/login', validate(loginSchema), async (req, res) => {
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
            } catch (smsError) {
                console.error('Failed to send SMS:', smsError);
            }
        }

        res.json({ message: 'OTP sent', user_id: userDoc.id });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
