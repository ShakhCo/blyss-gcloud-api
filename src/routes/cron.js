import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { sendBookingStatusUpdateNotification, sendTelegramMessage } from '../utils/telegram.js';

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

/**
 * POST /cron/notify-upcoming-bookings
 * Send Telegram reminder to customers with confirmed bookings starting within 1 hour.
 * Only notifies once per booking (sets is_notified = true).
 * Intended to be called by Google Cloud Scheduler every 10-15 minutes.
 */
router.post('/notify-upcoming-bookings', async (req, res) => {
    try {
        // Get current time in Uzbekistan (UTC+5)
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));
        const oneHourLater = new Date(uzbekNow.getTime() + 60 * 60 * 1000);

        const todayStr = uzbekNow.toISOString().split('T')[0];
        const tomorrowStr = oneHourLater.toISOString().split('T')[0];

        // Query confirmed bookings for today (and possibly tomorrow if near midnight)
        const datesToQuery = [todayStr];
        if (tomorrowStr !== todayStr) {
            datesToQuery.push(tomorrowStr);
        }

        let allBookingDocs = [];
        for (const dateStr of datesToQuery) {
            const snapshot = await db.collection('bookings')
                .where('status', '==', 'confirmed')
                .where('is_notified', '==', false)
                .where('booking_date', '==', dateStr)
                .get();
            allBookingDocs.push(...snapshot.docs);
        }

        if (allBookingDocs.length === 0) {
            return res.json({ notified: 0 });
        }

        // Format current Uzbekistan time as comparable string
        const uzbekNowMinutes = uzbekNow.getHours() * 60 + uzbekNow.getMinutes();
        const oneHourLaterMinutes = uzbekNowMinutes + 60;

        let notifiedCount = 0;

        for (const bookingDoc of allBookingDocs) {
            const bookingData = bookingDoc.data();
            const firstItem = bookingData.items?.[0];
            if (!firstItem?.start_time) continue;

            // Parse start_time (format: YYYY-MM-DDTHH:mm)
            const timePart = firstItem.start_time.split('T')[1];
            if (!timePart) continue;

            const [hours, minutes] = timePart.split(':').map(Number);
            const bookingDateStr = bookingData.booking_date;

            // Calculate booking time in minutes from midnight
            const bookingMinutes = hours * 60 + minutes;

            // For same-day bookings: check if within window
            // For cross-midnight: handle the date boundary
            let isWithinWindow = false;
            if (bookingDateStr === todayStr) {
                isWithinWindow = bookingMinutes >= uzbekNowMinutes && bookingMinutes <= oneHourLaterMinutes;
            } else if (bookingDateStr === tomorrowStr && oneHourLaterMinutes > 1440) {
                // Cross-midnight case: oneHourLaterMinutes wrapped into next day
                const wrappedMinutes = oneHourLaterMinutes - 1440;
                isWithinWindow = bookingMinutes <= wrappedMinutes;
            }

            if (!isWithinWindow) continue;

            // Check if customer has telegram_id
            const customerTelegramId = bookingData.customer_telegram_id;
            if (!customerTelegramId) {
                // No telegram ID on booking, mark as notified to skip next time
                await bookingDoc.ref.update({ is_notified: true });
                continue;
            }

            // Send reminder notification
            try {
                const serviceName = typeof firstItem.service_name === 'object'
                    ? firstItem.service_name.uz || firstItem.service_name.ru
                    : firstItem.service_name || 'Xizmat';

                const message = `🔔 <b>Eslatma: Sizda yaqinlashayotgan buyurtma bor!</b>\n\n` +
                    `🏢 <b>Biznes:</b> ${bookingData.business_name}\n` +
                    `📋 <b>Xizmat:</b> ${serviceName}\n` +
                    `📅 <b>Sana:</b> ${bookingData.booking_date}\n` +
                    `🕐 <b>Vaqt:</b> ${timePart}\n\n` +
                    `Iltimos, o'z vaqtida tashrif buyuring!`;

                await sendTelegramMessage(customerTelegramId, message);
                notifiedCount++;
            } catch (telegramError) {
                console.error(`Failed to notify customer ${customerTelegramId} for booking ${bookingDoc.id}:`, telegramError);
            }

            // Mark booking as notified regardless of telegram success to avoid retries
            await bookingDoc.ref.update({ is_notified: true });
        }

        console.log(`Notified ${notifiedCount} upcoming bookings`);
        res.json({ notified: notifiedCount });
    } catch (error) {
        console.error('Error notifying upcoming bookings:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
