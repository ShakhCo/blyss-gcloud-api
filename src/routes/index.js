import { Router } from 'express';
import { verifySignature } from '../middleware/authenticate.js';
import authRouter from './auth.js';
import usersRouter from './users.js';
import otpRouter from './otp.js';
import businessOwnersRouter from './businessOwners.js';
import businessesRouter from './businesses.js';
import placesRouter from './places.js';
import employeesRouter from './employees.js';
import publicRouter from './public.js';
import notificationsRouter from './notifications.js';
import distanceRouter from './distance.js';
import aiRouter from './ai.js';
import conversationsRouter from './conversations.js';
import bookingsRouter from './bookings.js';
import telegramRouter from './telegram.js';
import botRouter from './bot.js';
import cronRouter from './cron.js';
import instagramRouter from './instagram.js';
import instagramWebhookRouter from './instagram-webhook.js';

const router = Router();

// Public routes (no signature verification required)
router.use('/public', publicRouter);

// Telegram Mini App routes (uses init data auth, no signature verification)
router.use('/telegram', telegramRouter);

// Bot routes (HMAC signature auth for Telegram bot server)
router.use('/bot', verifySignature, botRouter);

// Cron routes (Bearer token auth for Cloud Scheduler)
router.use('/cron', cronRouter);

// Instagram webhook (public — Meta sends events here, verified via its own signature)
router.use('/instagram/webhook', instagramWebhookRouter);

// Booking routes (mixed public and authenticated endpoints - handled internally)
router.use('/', bookingsRouter);

// All other routes require signature verification
router.use('/auth', verifySignature, authRouter);
router.use('/users', verifySignature, usersRouter);
router.use('/otp', verifySignature, otpRouter);
router.use('/business-owners', verifySignature, businessOwnersRouter);
router.use('/businesses', verifySignature, businessesRouter);
router.use('/places', verifySignature, placesRouter);
router.use('/employees', verifySignature, employeesRouter);
router.use('/notifications', verifySignature, notificationsRouter);
router.use('/distance', verifySignature, distanceRouter);
router.use('/ai', verifySignature, aiRouter);
router.use('/businesses/:businessId/conversations', verifySignature, conversationsRouter);
router.use('/instagram', verifySignature, instagramRouter);

export default router;
