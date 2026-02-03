import { Router } from 'express';
import { telegramAuth } from '../middleware/telegramAuth.js';

const router = Router();

// Apply Telegram auth middleware to all routes
router.use(telegramAuth);

/**
 * GET /telegram/me
 * Returns the current authenticated Telegram user from init data
 */
router.get('/me', (req, res) => {
    res.json(req.telegramUser);
});

export default router;
