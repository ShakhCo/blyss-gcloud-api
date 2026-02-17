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

function formatEmployeeNotification(booking, employeeItems) {
    const firstItem = employeeItems[0];
    const lastItem = employeeItems[employeeItems.length - 1];

    const serviceNames = employeeItems.map(item => {
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

    const subtotal = employeeItems.reduce((sum, item) => sum + (item.price || 0), 0);

    return `🆕 <b>Yangi buyurtma!</b>\n\n` +
        `📋 <b>Xizmat:</b> ${serviceNames.join(', ')}\n` +
        `👤 <b>Mijoz:</b> ${booking.customer_name}\n` +
        `📞 <b>Telefon:</b> ${booking.customer_phone || 'N/A'}\n` +
        `📅 <b>Sana:</b> ${booking.booking_date}\n` +
        `🕐 <b>Vaqt:</b> ${startTime} - ${endTime}\n` +
        `💰 <b>Narx:</b> ${subtotal.toLocaleString()} so'm`;
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

        // Notify each employee with only their items
        try {
            // Group items by employee_id
            const itemsByEmployee = new Map();
            for (const item of booking.items) {
                if (!item.employee_id) continue;
                if (!itemsByEmployee.has(item.employee_id)) {
                    itemsByEmployee.set(item.employee_id, []);
                }
                itemsByEmployee.get(item.employee_id).push(item);
            }

            for (const [employeeId, empItems] of itemsByEmployee) {
                try {
                    const employeeDoc = await db
                        .collection('businesses')
                        .doc(booking.business_id)
                        .collection('employees')
                        .doc(employeeId)
                        .get();

                    if (!employeeDoc.exists) continue;
                    const empData = employeeDoc.data();
                    if (!empData.business_owner_id) continue;

                    const ownerDoc = await db.collection('business_owners').doc(empData.business_owner_id).get();
                    if (!ownerDoc.exists) continue;

                    const ownerData = ownerDoc.data();
                    if (ownerData.telegram_id) {
                        const empMessage = formatEmployeeNotification(booking, empItems);
                        await sendTelegramMessage(botToken, ownerData.telegram_id, empMessage);
                    }
                } catch (error) {
                    console.error(`Failed to send employee notification to ${employeeId}:`, error);
                }
            }
        } catch (error) {
            console.error('Failed to send employee notifications:', error);
        }
    }
);
