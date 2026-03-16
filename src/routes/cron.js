import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { sendBookingStatusUpdateNotification, sendTelegramMessage, sendCustomerBotMessage } from '../utils/telegram.js';
import { sendSms } from '../utils/eskiz.js';

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

        // Phase 1: Filter bookings within the 2-hour window and collect their info
        const eligibleBookings = [];

        for (const bookingDoc of allBookingDocs) {
            const bookingData = bookingDoc.data();
            const items = bookingData.items || [];

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

            let isWithinWindow = false;
            if (bookingDateStr === todayStr) {
                isWithinWindow = bookingMinutes >= uzbekNowMinutes && bookingMinutes <= twoHoursLaterMinutes;
            } else if (bookingDateStr === laterDateStr && twoHoursLaterMinutes > 1440) {
                const wrappedMinutes = twoHoursLaterMinutes - 1440;
                isWithinWindow = bookingMinutes <= wrappedMinutes;
            }

            if (!isWithinWindow) continue;

            eligibleBookings.push({ bookingDoc, bookingData, nearestItem, hours, minutes, bookingMinutes });
        }

        // Phase 2: Group by customer_phone to avoid duplicate customer notifications
        const customerGroups = new Map();

        for (const entry of eligibleBookings) {
            const phone = entry.bookingData.customer_phone || `no_phone_${entry.bookingDoc.id}`;
            if (!customerGroups.has(phone)) {
                customerGroups.set(phone, []);
            }
            customerGroups.get(phone).push(entry);
        }

        for (const [phone, bookings] of customerGroups) {
            // Sort by start time to find the earliest booking
            bookings.sort((a, b) => a.bookingMinutes - b.bookingMinutes);
            const earliest = bookings[0];

            const timePart = earliest.nearestItem.start_time.split('T')[1];
            const timeHHMM = timePart.substring(0, 5);

            // Resolve customer telegram_id once per group
            let customerTelegramId = null;
            for (const b of bookings) {
                if (b.bookingData.customer_telegram_id) {
                    customerTelegramId = b.bookingData.customer_telegram_id;
                    break;
                }
            }
            if (!customerTelegramId && !phone.startsWith('no_phone_')) {
                try {
                    const usersSnapshot = await db.collection('users')
                        .where('phone_number', '==', phone)
                        .limit(1)
                        .get();
                    if (!usersSnapshot.empty) {
                        customerTelegramId = usersSnapshot.docs[0].data().telegram_id || null;
                    }
                } catch (lookupError) {
                    console.error(`Failed to look up user by phone ${phone}:`, lookupError);
                }
            }

            // Send ONE customer notification per phone number using the earliest booking time
            const businessName = earliest.bookingData.business_name;
            const bilingualMessage = `Salom, bu ${businessName}. Siz bugun soat ${timeHHMM}ga yozilgansiz. Iltimos, vaqtida kelishingizni so'raymiz.\n\nЗдравствуйте, это ${businessName}. У вас запись сегодня на ${timeHHMM}. Пожалуйста, приходите вовремя.`;

            if (!phone.startsWith('no_phone_')) {
                try {
                    await sendSms(phone, bilingualMessage);
                } catch (smsError) {
                    console.error(`Failed to send SMS to ${phone}:`, smsError);
                }
            }

            if (customerTelegramId) {
                try {
                    await sendCustomerBotMessage(customerTelegramId, bilingualMessage);
                } catch (customerTgError) {
                    console.error(`Failed to notify customer ${customerTelegramId}:`, customerTgError);
                }
            }

            // Send individual admin group messages per booking (each needs its own audio button)
            for (const entry of bookings) {
                if (ADMIN_GROUP_ID) {
                    try {
                        const uzbekTime = formatTimeInUzbek(entry.hours, entry.minutes);
                        const adminMessage = `Salom, bu ${entry.bookingData.business_name}.\n` +
                            `Sizda bugun soat ${uzbekTime} broningiz bor.\n` +
                            `Iltimos, vaqtida kelishingizni so'raymiz.`;

                        const adminOptions = {};
                        if (TELEGRAM_BOT_USERNAME) {
                            adminOptions.reply_markup = {
                                inline_keyboard: [[{
                                    text: '🎙 Audio Olish',
                                    url: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=audio_${entry.bookingDoc.id}`
                                }]]
                            };
                        }
                        const adminResult = await sendTelegramMessage(ADMIN_GROUP_ID, adminMessage, adminOptions);

                        if (adminResult && adminResult.message_id) {
                            await entry.bookingDoc.ref.update({ admin_message_id: adminResult.message_id });
                        }
                    } catch (adminError) {
                        console.error(`Failed to notify admin group for booking ${entry.bookingDoc.id}:`, adminError);
                    }
                }

                // Mark each booking as notified
                await entry.bookingDoc.ref.update({ is_notified: true });
                notifiedCount++;
            }

            // Mark any other same-day bookings for this customer as notified
            // to prevent duplicate notifications when consecutive bookings
            // enter the 2-hour window on different cron runs
            if (!phone.startsWith('no_phone_')) {
                const notifiedIds = new Set(bookings.map(b => b.bookingDoc.id));
                const sameDaySnapshot = await db.collection('bookings')
                    .where('status', '==', 'confirmed')
                    .where('booking_date', '==', todayStr)
                    .where('customer_phone', '==', phone)
                    .where('business_id', '==', earliest.bookingData.business_id)
                    .get();
                for (const doc of sameDaySnapshot.docs) {
                    if (!notifiedIds.has(doc.id) && !doc.data().is_notified) {
                        await doc.ref.update({ is_notified: true });
                    }
                }
            }
        }

        console.log(`Notified ${notifiedCount} bookings (${customerGroups.size} unique customers)`);
        res.json({ notified: notifiedCount, customers: customerGroups.size });
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

/**
 * POST /cron/send-review-requests
 * Find completed bookings (2+ hours ago) without review_request_sent,
 * group by (customer_phone, business_id, booking_date),
 * create one review doc per group, send one SMS per group,
 * and mark all bookings as review_request_sent.
 * Intended to be called by Google Cloud Scheduler every 30 minutes.
 */
router.post('/send-review-requests', async (req, res) => {
    try {
        // Get current time in Uzbekistan (UTC+5)
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));
        const twoHoursAgo = new Date(uzbekNow.getTime() - 2 * 60 * 60 * 1000);

        // Find completed bookings that haven't had review requests sent
        // We query all completed bookings and filter in code (Firestore doesn't support != queries well)
        const completedBookings = await db.collection('bookings')
            .where('status', '==', 'completed')
            .get();

        if (completedBookings.empty) {
            return res.json({ reviews_created: 0, sms_sent: 0 });
        }

        // Filter: not already sent, and completed 2+ hours ago
        const eligible = [];
        
        for (const doc of completedBookings.docs) {
            const data = doc.data();
            if (data.review_request_sent) continue;

            // Check if booking was completed at least 2 hours ago
            const updatedAt = data.updated_at instanceof Date ? data.updated_at : data.updated_at?.toDate?.();
            if (!updatedAt || updatedAt > twoHoursAgo) continue;

            eligible.push({ doc, data });
        }

        if (eligible.length === 0) {
            return res.json({ reviews_created: 0, sms_sent: 0 });
        }

        // Group by (customer_phone, business_id, booking_date)
        const groups = new Map();
        for (const { doc, data } of eligible) {
            const key = `${data.customer_phone}|${data.business_id}|${data.booking_date}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    customer_phone: data.customer_phone,
                    customer_name: data.customer_name,
                    business_id: data.business_id,
                    business_name: data.business_name,
                    booking_date: data.booking_date,
                    bookings: []
                });
            }
            groups.get(key).bookings.push({ doc, data });
        }

        let reviewsCreated = 0;
        let smsSent = 0;
        const REVIEW_BASE_URL = process.env.REVIEW_BASE_URL || 'https://blyss.uz';

        for (const [, group] of groups) {
            // Generate token
            const token = crypto.randomBytes(16).toString('hex');

            // Collect all service items from all bookings in the group
            const items = [];
            const bookingIds = [];

            for (const { doc, data } of group.bookings) {
                bookingIds.push(doc.id);
                for (const item of (data.items || [])) {
                    // Skip cancelled items
                    if (item.status === 'cancelled') continue;

                    items.push({
                        booking_item_id: item.id,
                        service_id: item.service_id,
                        service_name: item.service_name,
                        employee_id: item.employee_id,
                        employee_name: item.employee_name,
                        start_time: item.start_time?.split('T')[1] || '',
                        price: item.price || 0,
                        rating: null
                    });
                }
            }

            // Skip if no ratable items
            if (items.length === 0) {
                // Still mark bookings so we don't reprocess them
                for (const { doc } of group.bookings) {
                    await doc.ref.update({ review_request_sent: true });
                }
                continue;
            }

            // Create review document
            await db.collection('reviews').doc(token).set({
                business_id: group.business_id,
                business_name: group.business_name,
                customer_phone: group.customer_phone,
                customer_name: group.customer_name,
                booking_date: group.booking_date,
                booking_ids: bookingIds,
                items,
                status: 'pending',
                comment: null,
                created_at: new Date(),
                submitted_at: null
            });

            reviewsCreated++;

            // Fetch business tenant_url for the review link
            let reviewBaseUrl = REVIEW_BASE_URL;
            try {
                const businessDoc = await db.collection('businesses').doc(group.business_id).get();
                if (businessDoc.exists && businessDoc.data().tenant_url) {
                    reviewBaseUrl = `https://${businessDoc.data().tenant_url}`;
                }
            } catch (bizError) {
                console.error(`Failed to fetch business ${group.business_id} for tenant_url:`, bizError);
            }

            // Send bilingual SMS
            const link = `${reviewBaseUrl}/rate?token=${token}`;
            const smsMessage = `${group.business_name}ga tashrifingiz uchun rahmat! Iltimos, xizmatimizni baholang: ${link} ⭐ Keyingi safar oldindan yozilib kelishingiz mumkin: ${reviewBaseUrl}`;

            try {
                await sendSms(group.customer_phone, smsMessage);
                smsSent++;
            } catch (smsError) {
                console.error(`Failed to send review SMS to ${group.customer_phone}:`, smsError);
            }

            // Notify admin group via Telegram
            if (ADMIN_GROUP_ID) {
                try {
                    const serviceList = items.map(i => {
                        const name = typeof i.service_name === 'object'
                            ? i.service_name.uz || i.service_name.ru
                            : i.service_name || 'Service';
                        return `  - ${name} (${i.price?.toLocaleString() || 0} so'm)`;
                    }).join('\n');

                    const adminMsg = `⭐ <b>Review so'rovi yuborildi</b>\n\n` +
                        `🏢 <b>Business:</b> ${group.business_name}\n` +
                        `👤 <b>Mijoz:</b> ${group.customer_name || 'N/A'}\n` +
                        `📱 <b>Telefon:</b> ${group.customer_phone}\n` +
                        `📅 <b>Sana:</b> ${group.booking_date}\n` +
                        `💈 <b>Xizmatlar:</b>\n${serviceList}\n\n` +
                        `🔗 <b>Link:</b> ${link}`;

                    await sendTelegramMessage(ADMIN_GROUP_ID, adminMsg);
                } catch (adminError) {
                    console.error(`Failed to notify admin group for review:`, adminError);
                }
            }

            // Mark all bookings in this group
            for (const { doc } of group.bookings) {
                await doc.ref.update({ review_request_sent: true });
            }
        }

        console.log(`Review requests: ${reviewsCreated} created, ${smsSent} SMS sent`);
        res.json({ reviews_created: reviewsCreated, sms_sent: smsSent });
    } catch (error) {
        console.error('Error sending review requests:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /cron/test-review-requests
 * Test route: sends review request SMS only to customers of business 2e4aec013254a05e.
 * Same logic as send-review-requests but filtered to one business and no 2-hour delay.
 */
router.post('/test-review-requests', async (req, res) => {
    const TEST_BUSINESS_ID = '2e4aec013254a05e';
    try {
        const completedBookings = await db.collection('bookings')
            .where('status', '==', 'completed')
            .where('business_id', '==', TEST_BUSINESS_ID)
            .get();

        if (completedBookings.empty) {
            return res.json({ reviews_created: 0, sms_sent: 0, message: 'No completed bookings found' });
        }

        const eligible = [];
        for (const doc of completedBookings.docs) {
            const data = doc.data();
            if (data.review_request_sent) continue;
            eligible.push({ doc, data });
        }

        if (eligible.length === 0) {
            return res.json({ reviews_created: 0, sms_sent: 0, message: 'All bookings already have review_request_sent' });
        }

        // Group by (customer_phone, business_id, booking_date)
        const groups = new Map();
        for (const { doc, data } of eligible) {
            const key = `${data.customer_phone}|${data.business_id}|${data.booking_date}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    customer_phone: data.customer_phone,
                    customer_name: data.customer_name,
                    business_id: data.business_id,
                    business_name: data.business_name,
                    booking_date: data.booking_date,
                    bookings: []
                });
            }
            groups.get(key).bookings.push({ doc, data });
        }

        let reviewsCreated = 0;
        let smsSent = 0;
        const REVIEW_BASE_URL = process.env.REVIEW_BASE_URL || 'https://blyss.uz';

        for (const [, group] of groups) {
            const token = crypto.randomBytes(16).toString('hex');

            const items = [];
            const bookingIds = [];

            for (const { doc, data } of group.bookings) {
                bookingIds.push(doc.id);
                for (const item of (data.items || [])) {
                    if (item.status === 'cancelled') continue;
                    items.push({
                        booking_item_id: item.id,
                        service_id: item.service_id,
                        service_name: item.service_name,
                        employee_id: item.employee_id,
                        employee_name: item.employee_name,
                        start_time: item.start_time?.split('T')[1] || '',
                        price: item.price || 0,
                        rating: null
                    });
                }
            }

            if (items.length === 0) {
                for (const { doc } of group.bookings) {
                    await doc.ref.update({ review_request_sent: true });
                }
                continue;
            }

            await db.collection('reviews').doc(token).set({
                business_id: group.business_id,
                business_name: group.business_name,
                customer_phone: group.customer_phone,
                customer_name: group.customer_name,
                booking_date: group.booking_date,
                booking_ids: bookingIds,
                items,
                status: 'pending',
                comment: null,
                created_at: new Date(),
                submitted_at: null
            });

            reviewsCreated++;

            let reviewBaseUrl = REVIEW_BASE_URL;
            try {
                const businessDoc = await db.collection('businesses').doc(group.business_id).get();
                if (businessDoc.exists && businessDoc.data().tenant_url) {
                    reviewBaseUrl = `https://${businessDoc.data().tenant_url}`;
                }
            } catch (bizError) {
                console.error(`Failed to fetch business ${group.business_id} for tenant_url:`, bizError);
            }

            const link = `${reviewBaseUrl}/rate?token=${token}`;
            const smsMessage = `${group.business_name}ga tashrifingiz uchun rahmat! Iltimos, xizmatimizni baholang: ${link} ⭐ Keyingi safar oldindan yozilib kelishingiz mumkin: ${reviewBaseUrl}`;

            try {
                await sendSms(group.customer_phone, smsMessage);
                smsSent++;
            } catch (smsError) {
                console.error(`Failed to send review SMS to ${group.customer_phone}:`, smsError);
            }

            // Notify admin group via Telegram
            if (ADMIN_GROUP_ID) {
                try {
                    const serviceList = items.map(i => {
                        const name = typeof i.service_name === 'object'
                            ? i.service_name.uz || i.service_name.ru
                            : i.service_name || 'Service';
                        return `  - ${name} (${i.price?.toLocaleString() || 0} so'm)`;
                    }).join('\n');

                    const adminMsg = `⭐ <b>[TEST] Review so'rovi yuborildi</b>\n\n` +
                        `🏢 <b>Business:</b> ${group.business_name}\n` +
                        `👤 <b>Mijoz:</b> ${group.customer_name || 'N/A'}\n` +
                        `📱 <b>Telefon:</b> ${group.customer_phone}\n` +
                        `📅 <b>Sana:</b> ${group.booking_date}\n` +
                        `💈 <b>Xizmatlar:</b>\n${serviceList}\n\n` +
                        `🔗 <b>Link:</b> ${link}`;

                    await sendTelegramMessage(ADMIN_GROUP_ID, adminMsg);
                } catch (adminError) {
                    console.error(`Failed to notify admin group for test review:`, adminError);
                }
            }

            for (const { doc } of group.bookings) {
                await doc.ref.update({ review_request_sent: true });
            }
        }

        console.log(`[TEST] Review requests for ${TEST_BUSINESS_ID}: ${reviewsCreated} created, ${smsSent} SMS sent`);
        res.json({ reviews_created: reviewsCreated, sms_sent: smsSent, eligible_bookings: eligible.length, groups: groups.size });
    } catch (error) {
        console.error('Error in test-review-requests:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /cron/send-winback-notifications
 * Find customers who haven't visited a business for 20+ days.
 * Sends one SMS per (customer_phone, business_id) pair.
 * Uses `winback_notifications` collection to avoid re-sending.
 */
router.post('/send-winback-notifications', async (req, res) => {
    try {
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));
        const todayStr = uzbekNow.toISOString().split('T')[0]; // YYYY-MM-DD

        // 20 days ago
        const cutoffDate = new Date(uzbekNow);
        cutoffDate.setDate(cutoffDate.getDate() - 20);
        const cutoffStr = cutoffDate.toISOString().split('T')[0];

        // Get all completed bookings
        const completedBookings = await db.collection('bookings')
            .where('status', '==', 'completed')
            .get();

        if (completedBookings.empty) {
            return res.json({ notifications_sent: 0 });
        }

        // Group by (customer_phone, business_id), track latest booking_date
        const groups = new Map();
        for (const doc of completedBookings.docs) {
            const data = doc.data();
            if (!data.customer_phone || !data.business_id || !data.booking_date) continue;

            const key = `${data.customer_phone}|${data.business_id}`;
            const existing = groups.get(key);

            if (!existing || data.booking_date > existing.latest_date) {
                groups.set(key, {
                    customer_phone: data.customer_phone,
                    customer_name: data.customer_name,
                    business_id: data.business_id,
                    business_name: data.business_name,
                    latest_date: data.booking_date
                });
            }
        }

        // Filter: latest visit 20+ days ago
        const eligible = [];
        for (const [key, group] of groups) {
            if (group.latest_date <= cutoffStr) {
                eligible.push({ key, ...group });
            }
        }

        if (eligible.length === 0) {
            return res.json({ notifications_sent: 0, checked: groups.size });
        }

        // Check which ones already got a winback notification
        const winbackKeys = eligible.map(e => `${e.customer_phone}_${e.business_id}`);

        // Firestore IN query supports max 30 items, batch if needed
        const alreadySent = new Set();
        for (let i = 0; i < winbackKeys.length; i += 30) {
            const batch = winbackKeys.slice(i, i + 30);
            const snap = await db.collection('winback_notifications')
                .where('__name__', 'in', batch)
                .get();
            for (const doc of snap.docs) {
                alreadySent.add(doc.id);
            }
        }

        // Cache business tenant URLs
        const businessCache = new Map();

        let sent = 0;
        for (const group of eligible) {
            const docId = `${group.customer_phone}_${group.business_id}`;
            if (alreadySent.has(docId)) continue;

            // Get business tenant_url
            if (!businessCache.has(group.business_id)) {
                try {
                    const bizDoc = await db.collection('businesses').doc(group.business_id).get();
                    businessCache.set(group.business_id, bizDoc.exists ? bizDoc.data() : null);
                } catch {
                    businessCache.set(group.business_id, null);
                }
            }

            const bizData = businessCache.get(group.business_id);
            const tenantUrl = bizData?.tenant_url
                ? `https://${bizData.tenant_url}`
                : 'https://blyss.uz';
            const businessName = bizData?.business_name || group.business_name;

            const smsMessage = `Salom, bu ${businessName}! So'nggi tashrifingizdan beri ancha vaqt o'tdi 🙂 Sizni yana kutib qolamiz! Здравствуйте, это ${businessName}! С вашего последнего визита прошло уже много времени 🙂 Будем рады видеть вас снова! Yozilish/Запись: ${tenantUrl}`;

            try {
                await sendSms(group.customer_phone, smsMessage);
                sent++;

                // Record so we don't re-send
                await db.collection('winback_notifications').doc(docId).set({
                    customer_phone: group.customer_phone,
                    business_id: group.business_id,
                    business_name: businessName,
                    last_visit_date: group.latest_date,
                    sent_at: new Date()
                });
            } catch (smsErr) {
                console.error(`Failed to send winback SMS to ${group.customer_phone}:`, smsErr);
            }

            // Notify admin group
            if (ADMIN_GROUP_ID) {
                try {
                    const adminMsg = `📩 <b>Winback SMS yuborildi</b>\n\n` +
                        `🏢 <b>Business:</b> ${businessName}\n` +
                        `👤 <b>Mijoz:</b> ${group.customer_name || 'N/A'}\n` +
                        `📱 <b>Telefon:</b> ${group.customer_phone}\n` +
                        `📅 <b>Oxirgi tashrif:</b> ${group.latest_date}`;
                    await sendTelegramMessage(ADMIN_GROUP_ID, adminMsg);
                } catch (adminErr) {
                    console.error('Failed to notify admin group for winback:', adminErr);
                }
            }
        }

        console.log(`Winback notifications: ${sent} sent out of ${eligible.length} eligible`);
        res.json({ notifications_sent: sent, eligible: eligible.length, checked: groups.size });
    } catch (error) {
        console.error('Error sending winback notifications:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
