import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { userSchema, userResponseSchema } from '../schemas/user.js';

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
            return res.status(409).json({ error: 'User already registered', error_code: 'USER_ALREADY_REGISTERED' });
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

export default router;
