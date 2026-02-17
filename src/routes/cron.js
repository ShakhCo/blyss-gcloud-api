import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { sendBookingStatusUpdateNotification, sendTelegramMessage } from '../utils/telegram.js';

const router = Router();

const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

/**
 * Convert 24h hours:minutes to Uzbek spoken time format.
 * Examples: 15:00 → "uchda", 22:30 → "o'n yarimda", 14:45 → "ikkiyu qirq beshda"
 */
function formatTimeInUzbek(hours, minutes) {
    const hourNames = ["o'n ikki", 'bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz", "o'n", "o'n bir"];
    const hour12 = hours % 12;
    const hourName = hourNames[hour12];

    if (minutes === 0) {
        return `${hourName}da`;
    }
    if (minutes === 30) {
        return `${hourName} yarimda`;
    }

    const ones = ['', 'bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz"];
    const tens = ['', "o'n", 'yigirma', "o'ttiz", 'qirq', 'ellik'];
    const ten = Math.floor(minutes / 10);
    const one = minutes % 10;
    const minuteName = one === 0 ? tens[ten] : `${tens[ten]} ${ones[one]}`;

    const vowels = 'aeiou';
    const connector = vowels.includes(hourName[hourName.length - 1]) ? 'yu' : 'u';

    return `${hourName}${connector} ${minuteName}da`;
}

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

            const updatedItems = (bookingData.items || []).map(item => ({
                ...item,
                status: 'cancelled'
            }));
            await bookingDoc.ref.update({
                status: 'cancelled',
                items: updatedItems,
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
 * Send Telegram reminder to customers with confirmed bookings starting within 2 hours.
 * Looks up customer's phone number in users collection to find telegram_id.
 * Only notifies once per booking (sets is_notified = true).
 * Intended to be called by Google Cloud Scheduler every 10-15 minutes.
 */
router.post('/notify-upcoming-bookings', async (req, res) => {
    try {
        // Get current time in Uzbekistan (UTC+5)
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));
        const twoHoursLater = new Date(uzbekNow.getTime() + 2 * 60 * 60 * 1000);

        const todayStr = uzbekNow.toISOString().split('T')[0];
        const laterDateStr = twoHoursLater.toISOString().split('T')[0];

        // Query confirmed bookings for today (and possibly tomorrow if near midnight)
        const datesToQuery = [todayStr];
        if (laterDateStr !== todayStr) {
            datesToQuery.push(laterDateStr);
        }

        // Fetch bookings that haven't been notified yet
        // Note: bookings without is_notified field won't match is_notified == false in Firestore,
        // so we query all confirmed bookings and filter in code
        let allBookingDocs = [];
        for (const dateStr of datesToQuery) {
            const snapshot = await db.collection('bookings')
                .where('status', '==', 'confirmed')
                .where('booking_date', '==', dateStr)
                .get();
            allBookingDocs.push(...snapshot.docs);
        }

        // Filter out already-notified bookings
        allBookingDocs = allBookingDocs.filter(doc => !doc.data().is_notified);

        if (allBookingDocs.length === 0) {
            return res.json({ notified: 0 });
        }

        const uzbekNowMinutes = uzbekNow.getHours() * 60 + uzbekNow.getMinutes();
        const twoHoursLaterMinutes = uzbekNowMinutes + 120;

        let notifiedCount = 0;

        for (const bookingDoc of allBookingDocs) {
            const bookingData = bookingDoc.data();
            const items = bookingData.items || [];

            // Filter to only confirmed (non-cancelled) items with a start_time
            const activeItems = items.filter(i => i.status !== 'cancelled' && i.start_time);
            if (activeItems.length === 0) continue;

            // Find the nearest item by start_time
            const nearestItem = activeItems.reduce((closest, item) => {
                const closestTime = closest.start_time.split('T')[1] || '';
                const itemTime = item.start_time.split('T')[1] || '';
                const [ch, cm] = closestTime.split(':').map(Number);
                const [ih, im] = itemTime.split(':').map(Number);
                const closestMin = ch * 60 + cm;
                const itemMin = ih * 60 + im;
                const closestDiff = Math.abs(closestMin - uzbekNowMinutes);
                const itemDiff = Math.abs(itemMin - uzbekNowMinutes);
                return itemDiff < closestDiff ? item : closest;
            });

            const timePart = nearestItem.start_time.split('T')[1];
            if (!timePart) continue;

            const [hours, minutes] = timePart.split(':').map(Number);
            const bookingDateStr = bookingData.booking_date;
            const bookingMinutes = hours * 60 + minutes;

            // Check if booking starts within the 2-hour window
            let isWithinWindow = false;
            if (bookingDateStr === todayStr) {
                isWithinWindow = bookingMinutes >= uzbekNowMinutes && bookingMinutes <= twoHoursLaterMinutes;
            } else if (bookingDateStr === laterDateStr && twoHoursLaterMinutes > 1440) {
                const wrappedMinutes = twoHoursLaterMinutes - 1440;
                isWithinWindow = bookingMinutes <= wrappedMinutes;
            }

            if (!isWithinWindow) continue;

            // Look up customer's telegram_id via customer_phone in users collection
            let customerTelegramId = bookingData.customer_telegram_id || null;

            if (!customerTelegramId && bookingData.customer_phone) {
                try {
                    const usersSnapshot = await db.collection('users')
                        .where('phone_number', '==', bookingData.customer_phone)
                        .limit(1)
                        .get();
                    if (!usersSnapshot.empty) {
                        customerTelegramId = usersSnapshot.docs[0].data().telegram_id || null;
                    }
                } catch (lookupError) {
                    console.error(`Failed to look up user by phone ${bookingData.customer_phone}:`, lookupError);
                }
            }

            if (!customerTelegramId) {
                // No telegram ID found, mark as notified to skip next time
                await bookingDoc.ref.update({ is_notified: true });
                continue;
            }

            // Build customer reminder message
            const timeHHMM = timePart.substring(0, 5);
            const serviceName = typeof nearestItem.service_name === 'object'
                ? nearestItem.service_name.uz || nearestItem.service_name.ru
                : nearestItem.service_name || 'Xizmat';

            const customerMessage = `🔔 <b>Eslatma: Sizda yaqinlashayotgan buyurtma bor!</b>\n\n` +
                `🏢 <b>Biznes:</b> ${bookingData.business_name}\n` +
                `📋 <b>Xizmat:</b> ${serviceName}\n` +
                `📅 <b>Sana:</b> ${bookingData.booking_date}\n` +
                `🕐 <b>Vaqt:</b> ${timeHHMM}\n\n` +
                `Iltimos, o'z vaqtida tashrif buyuring!`;

            // Send reminder notification
            try {
                await sendTelegramMessage(customerTelegramId, customerMessage);
                notifiedCount++;

                // Also notify admin group with Uzbek text time
                if (ADMIN_GROUP_ID) {
                    const uzbekTime = formatTimeInUzbek(hours, minutes);
                    const adminMessage = `Salom, bu ${bookingData.business_name}.\n` +
                        `Sizda bugun soat ${uzbekTime} broningiz bor.\n` +
                        `Iltimos, vaqtida kelishingizni so'raymiz.`;

                    const adminOptions = {};
                    if (TELEGRAM_BOT_USERNAME) {
                        adminOptions.reply_markup = {
                            inline_keyboard: [[{
                                text: '🎙 Audio Olish',
                                url: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=audio_${bookingDoc.id}`
                            }]]
                        };
                    }
                    const adminResult = await sendTelegramMessage(ADMIN_GROUP_ID, adminMessage, adminOptions).catch(err => {
                        console.error(`Failed to notify admin group for booking ${bookingDoc.id}:`, err);
                        return null;
                    });

                    // Save message ID so the bot can remove the inline button after click
                    if (adminResult && adminResult.message_id) {
                        await bookingDoc.ref.update({ admin_message_id: adminResult.message_id });
                    }
                }
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

/**
 * POST /cron/complete-past-bookings
 * Auto-complete confirmed bookings whose end time has passed.
 * Uses Asia/Tashkent (UTC+5) timezone for comparison.
 * Intended to be called by Google Cloud Scheduler every 10-15 minutes.
 */
router.post('/complete-past-bookings', async (req, res) => {
    try {
        // Get current time in Uzbekistan (UTC+5)
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));

        const todayStr = uzbekNow.toISOString().split('T')[0];
        const uzbekNowMinutes = uzbekNow.getHours() * 60 + uzbekNow.getMinutes();

        // Query confirmed bookings for today and past dates
        // Past dates: all confirmed bookings are definitely past their end time
        const pastBookings = await db.collection('bookings')
            .where('status', '==', 'confirmed')
            .where('booking_date', '<', todayStr)
            .get();

        // Today's bookings: need to check end_time
        const todayBookings = await db.collection('bookings')
            .where('status', '==', 'confirmed')
            .where('booking_date', '==', todayStr)
            .get();

        let completedCount = 0;
        const updateTime = new Date();

        // Complete all past-date bookings (with items)
        for (const bookingDoc of pastBookings.docs) {
            const bookingData = bookingDoc.data();
            const updatedItems = (bookingData.items || []).map(item =>
                item.status === 'cancelled' ? item : { ...item, status: 'completed' }
            );
            await bookingDoc.ref.update({
                status: 'completed',
                items: updatedItems,
                updated_at: updateTime
            });
            completedCount++;
        }

        // Complete today's bookings where last active item's end_time has passed
        for (const bookingDoc of todayBookings.docs) {
            const bookingData = bookingDoc.data();
            const items = bookingData.items || [];
            if (items.length === 0) continue;

            // Find the latest end_time among non-cancelled items
            const activeItems = items.filter(i => i.status !== 'cancelled');
            if (activeItems.length === 0) continue;

            const lastActiveItem = activeItems[activeItems.length - 1];
            if (!lastActiveItem?.end_time) continue;

            const timePart = lastActiveItem.end_time.split('T')[1];
            if (!timePart) continue;

            const [hours, minutes] = timePart.split(':').map(Number);
            const endMinutes = hours * 60 + minutes;

            if (endMinutes <= uzbekNowMinutes) {
                const updatedItems = items.map(item =>
                    item.status === 'cancelled' ? item : { ...item, status: 'completed' }
                );
                await bookingDoc.ref.update({
                    status: 'completed',
                    items: updatedItems,
                    updated_at: updateTime
                });
                completedCount++;
            }
        }

        console.log(`Completed ${completedCount} past bookings`);
        res.json({ completed: completedCount });
    } catch (error) {
        console.error('Error completing past bookings:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
