import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp();

const DATABASE_ID = '(default)';
const db = getFirestore(DATABASE_ID);

const TELEGRAM_BUSINESS_BOT_TOKEN = defineSecret('TELEGRAM_BUSINESS_BOT_TOKEN');

async function sendTelegramMessage(botToken, chatId, text) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
        })
    });

    const data = await response.json();
    if (!data.ok) {
        console.error('Telegram API error:', data.description);
    }
    return data;
}

function formatBookingNotification(booking) {
    const firstItem = booking.items[0];
    const lastItem = booking.items[booking.items.length - 1];

    const serviceNames = booking.items.map(item => {
        return typeof item.service_name === 'object'
            ? item.service_name.uz || item.service_name.ru
            : item.service_name;
    });

    const startTime = firstItem.start_time.includes('T')
        ? firstItem.start_time.split('T')[1]
        : firstItem.start_time;

    const endTime = lastItem.end_time.includes('T')
        ? lastItem.end_time.split('T')[1]
        : lastItem.end_time;

    return `🆕 <b>Yangi buyurtma!</b>\n\n` +
        `📋 <b>Xizmat:</b> ${serviceNames.join(', ')}\n` +
        `👤 <b>Mijoz:</b> ${booking.customer_name}\n` +
        `📞 <b>Telefon:</b> ${booking.customer_phone || 'N/A'}\n` +
        `📅 <b>Sana:</b> ${booking.booking_date}\n` +
        `🕐 <b>Vaqt:</b> ${startTime} - ${endTime}\n` +
        `💰 <b>Jami:</b> ${booking.total_price.toLocaleString()} so'm`;
}

export const onBookingCreated = onDocumentCreated(
    {
        document: 'bookings/{bookingId}',
        database: DATABASE_ID,
        secrets: [TELEGRAM_BUSINESS_BOT_TOKEN]
    },
    async (event) => {
        const booking = event.data?.data();
        if (!booking || !booking.items?.length) return;

        const botToken = TELEGRAM_BUSINESS_BOT_TOKEN.value();
        if (!botToken) {
            console.error('TELEGRAM_BUSINESS_BOT_TOKEN is not configured');
            return;
        }

        const message = formatBookingNotification(booking);

        // 1. Notify business owner via their telegram bot chat_id
        try {
            const businessDoc = await db.collection('businesses').doc(booking.business_id).get();
            if (businessDoc.exists) {
                const businessData = businessDoc.data();
                if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
                    await sendTelegramMessage(botToken, businessData.telegram_bot.chat_id, message);
                }
            }
        } catch (error) {
            console.error('Failed to send business owner notification:', error);
        }

        // 2. Notify employees via their business_owner telegram_id
        try {
            const employeeIds = [...new Set(booking.items.map(item => item.employee_id))];

            const businessOwnerIds = new Set();
            for (const employeeId of employeeIds) {
                const employeeDoc = await db
                    .collection('businesses')
                    .doc(booking.business_id)
                    .collection('employees')
                    .doc(employeeId)
                    .get();

                if (employeeDoc.exists) {
                    const empData = employeeDoc.data();
                    if (empData.business_owner_id) {
                        businessOwnerIds.add(empData.business_owner_id);
                    }
                }
            }

            for (const ownerId of businessOwnerIds) {
                try {
                    const ownerDoc = await db.collection('business_owners').doc(ownerId).get();
                    if (ownerDoc.exists) {
                        const ownerData = ownerDoc.data();
                        if (ownerData.telegram_id) {
                            await sendTelegramMessage(botToken, ownerData.telegram_id, message);
                        }
                    }
                } catch (error) {
                    console.error(`Failed to send employee notification to owner ${ownerId}:`, error);
                }
            }
        } catch (error) {
            console.error('Failed to send employee notifications:', error);
        }
    }
);
