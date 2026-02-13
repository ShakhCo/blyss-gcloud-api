import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { sendBookingStatusUpdateNotification } from '../utils/telegram.js';

const router = Router();

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Middleware to verify cron requests via Bearer token.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyCronAuth(req, res, next) {
    if (!CRON_SECRET) {
        return res.status(500).json({ error: 'CRON_SECRET not configured', error_code: 'CONFIG_ERROR' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', error_code: 'UNAUTHORIZED' });
    }

    const token = authHeader.slice(7);
    try {
        const isValid = token.length === CRON_SECRET.length &&
            crypto.timingSafeEqual(Buffer.from(token), Buffer.from(CRON_SECRET));
        if (!isValid) {
            return res.status(401).json({ error: 'Unauthorized', error_code: 'UNAUTHORIZED' });
        }
    } catch {
        return res.status(401).json({ error: 'Unauthorized', error_code: 'UNAUTHORIZED' });
    }

    next();
}

router.use(verifyCronAuth);

/**
 * POST /cron/expire-pending-bookings
 * Auto-cancel bookings that have been pending for more than 30 minutes.
 * Intended to be called by Google Cloud Scheduler every 5 minutes.
 */
router.post('/expire-pending-bookings', async (req, res) => {
    try {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

        const staleBookings = await db.collection('bookings')
            .where('status', '==', 'pending')
            .where('created_at', '<=', thirtyMinutesAgo)
            .get();

        if (staleBookings.empty) {
            return res.json({ expired: 0 });
        }

        const now = new Date();
        let expiredCount = 0;

        for (const bookingDoc of staleBookings.docs) {
            const bookingData = bookingDoc.data();

            await bookingDoc.ref.update({
                status: 'cancelled',
                cancelled_reason: 'auto_expired',
                updated_at: now
            });
            expiredCount++;

            // Notify customer via Telegram if they have a telegram_id
            if (bookingData.customer_telegram_id) {
                try {
                    const firstItem = bookingData.items?.[0];
                    const serviceName = typeof firstItem?.service_name === 'object'
                        ? firstItem.service_name.uz || firstItem.service_name.ru
                        : firstItem?.service_name || 'Service';

                    await sendBookingStatusUpdateNotification(bookingData.customer_telegram_id, {
                        businessName: bookingData.business_name,
                        serviceName,
                        date: bookingData.booking_date,
                        time: firstItem?.start_time?.split('T')[1] || '',
                        status: 'cancelled'
                    });
                } catch (telegramError) {
                    console.error(`Failed to notify customer ${bookingData.customer_telegram_id}:`, telegramError);
                }
            }

            // Notify business via Telegram
            try {
                const businessDoc = await db.collection('businesses').doc(bookingData.business_id).get();
                if (businessDoc.exists) {
                    const businessData = businessDoc.data();
                    if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
                        const firstItem = bookingData.items?.[0];
                        const serviceName = typeof firstItem?.service_name === 'object'
                            ? firstItem.service_name.uz || firstItem.service_name.ru
                            : firstItem?.service_name || 'Service';

                        const message = `⏰ <b>Buyurtma muddati tugadi!</b>\n\n` +
                            `📋 <b>Xizmat:</b> ${serviceName}\n` +
                            `👤 <b>Mijoz:</b> ${bookingData.customer_name}\n` +
                            `📅 <b>Sana:</b> ${bookingData.booking_date}\n` +
                            `🕐 <b>Vaqt:</b> ${firstItem?.start_time?.split('T')[1] || ''}\n\n` +
                            `Buyurtma 30 daqiqa ichida tasdiqlanmaganligi sababli avtomatik bekor qilindi.`;

                        const { sendTelegramMessage } = await import('../utils/telegram.js');
                        await sendTelegramMessage(businessData.telegram_bot.chat_id, message);
                    }
                }
            } catch (bizNotifyError) {
                console.error(`Failed to notify business ${bookingData.business_id}:`, bizNotifyError);
            }
        }

        console.log(`Expired ${expiredCount} pending bookings`);
        res.json({ expired: expiredCount });
    } catch (error) {
        console.error('Error expiring pending bookings:', error);
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
