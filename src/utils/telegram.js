/**
 * Telegram Bot utility for sending notifications
 */

const TELEGRAM_BUSINESS_BOT_TOKEN = process.env.TELEGRAM_BUSINESS_BOT_TOKEN;
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BUSINESS_BOT_TOKEN}`;

/**
 * Send a message to a Telegram user via bot
 * @param {number} telegramId - The user's Telegram ID
 * @param {string} text - The message text to send
 * @param {object} options - Additional options for the message
 * @returns {Promise<object>} - The response from Telegram API
 */
export async function sendTelegramMessage(telegramId, text, options = {}) {
    if (!TELEGRAM_BUSINESS_BOT_TOKEN) {
        console.error('TELEGRAM_BUSINESS_BOT_TOKEN is not configured');
        throw new Error('Telegram bot is not configured');
    }

    if (!telegramId) {
        console.error('telegram_id is required');
        throw new Error('telegram_id is required');
    }

    try {
        const response = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: telegramId,
                text,
                parse_mode: 'HTML',
                ...options
            })
        });

        const data = await response.json();

        if (!data.ok) {
            console.error('Telegram API error:', data.description);
            throw new Error(`Telegram API error: ${data.description}`);
        }

        return data.result;
    } catch (error) {
        console.error('Error sending Telegram message:', error);
        throw error;
    }
}

/**
 * Send a business invitation notification to a Telegram user
 * @param {number} telegramId - The user's Telegram ID
 * @param {string} businessName - The name of the business
 * @param {string} businessType - The type of business (e.g., barbershop, salon)
 * @param {string} position - The position being offered
 * @returns {Promise<void>}
 */
export async function sendBusinessInvitationNotification(telegramId, businessName, businessType, position) {
    const message = `🎉 <b>Sizni ishga taklif qilishdi!</b>\n\nSizni <b>${businessName}</b> o'z ${businessType}iga <b>${position}</b> sifatida ishga taklif qildi.\n\nTaklifni qabul qilish uchun ilovaga kiring va "Ish joylarim" bo'limiga o'ting.`;

    await sendTelegramMessage(telegramId, message);
}

/**
 * Send a business removal notification to a Telegram user
 * @param {number} telegramId - The user's Telegram ID
 * @param {string} businessName - The name of the business
 * @returns {Promise<void>}
 */
export async function sendBusinessRemovalNotification(telegramId, businessName) {
    const message = `📢 <b>Sizni biznesdan olib tashladilar!</b>\n\nSizni <b>${businessName}</b> biznesidan ishchi sifatida olib tashladilar.\n\nBoshqa ish joylarini ko'rish uchun ilovaning "Ish joylarim" bo'limiga o'ting.`;

    await sendTelegramMessage(telegramId, message);
}

/**
 * Send a new booking notification to a business via Telegram
 * @param {number} telegramId - The business owner's/employee's Telegram ID
 * @param {object} booking - The booking details
 * @param {string} booking.serviceName - The service name
 * @param {string} booking.customerName - The customer's name
 * @param {string} booking.customerPhone - The customer's phone number
 * @param {string} booking.date - The booking date (YYYY-MM-DD)
 * @param {string} booking.time - The booking time (HH:mm)
 * @param {string} booking.employeeName - The employee name
 * @param {number} booking.totalPrice - The total price
 * @returns {Promise<void>}
 */
export async function sendBookingNotification(telegramId, booking) {
    const { serviceName, customerName, customerPhone, date, time, employeeName, totalPrice } = booking;

    const message = `🆕 <b>Yangi buyurtma!</b>\n\n` +
        `📋 <b>Xizmat:</b> ${serviceName}\n` +
        `👤 <b>Mijoz:</b> ${customerName}\n` +
        `📞 <b>Telefon:</b> ${customerPhone}\n` +
        `📅 <b>Sana:</b> ${date}\n` +
        `🕐 <b>Vaqt:</b> ${time}\n` +
        `👨‍💼 <b>Xodim:</b> ${employeeName}\n` +
        `💰 <b>Narx:</b> ${totalPrice.toLocaleString()} so'm`;

    await sendTelegramMessage(telegramId, message);
}

/**
 * Send a booking cancellation notification to a business via Telegram
 * @param {number} telegramId - The business owner's/employee's Telegram ID
 * @param {object} booking - The booking details
 * @param {string} booking.serviceName - The service name
 * @param {string} booking.customerName - The customer's name
 * @param {string} booking.date - The booking date (YYYY-MM-DD)
 * @param {string} booking.time - The booking time (HH:mm)
 * @returns {Promise<void>}
 */
export async function sendBookingCancellationNotification(telegramId, booking) {
    const { serviceName, customerName, date, time } = booking;

    const message = `❌ <b>Buyurtma bekor qilindi!</b>\n\n` +
        `📋 <b>Xizmat:</b> ${serviceName}\n` +
        `👤 <b>Mijoz:</b> ${customerName}\n` +
        `📅 <b>Sana:</b> ${date}\n` +
        `🕐 <b>Vaqt:</b> ${time}`;

    await sendTelegramMessage(telegramId, message);
}

/**
 * Send a booking status update notification to a customer via Telegram
 * @param {number} telegramId - The customer's Telegram ID
 * @param {object} details - The notification details
 * @param {string} details.businessName - The business name
 * @param {string} details.serviceName - The service name
 * @param {string} details.date - The booking date (YYYY-MM-DD)
 * @param {string} details.time - The booking time (HH:mm)
 * @param {string} details.status - The new booking status
 * @returns {Promise<void>}
 */
export async function sendBookingStatusUpdateNotification(telegramId, details) {
    const { businessName, serviceName, date, time, endTime, status, cancelledReason, employeeName, otherBookings } = details;

    let message;

    if (status === 'cancelled') {
        const startHHMM = time ? time.substring(0, 5) : '';
        const endHHMM = endTime ? endTime.substring(0, 5) : '';

        message = `❌ <b>Buyurtmangiz bekor qilindi!</b>\n\n`;
        if (employeeName && startHHMM && endHHMM) {
            message += `<b>${businessName}</b> da <b>${employeeName}</b> bilan ${date} soat <b>${startHHMM}</b> dan <b>${endHHMM}</b> gacha qilingan buyurtmangiz bekor qilindi. Noqulaylik uchun uzr so'raymiz.`;
        } else {
            message += `<b>${businessName}</b> da ${date} kuni qilingan buyurtmangiz bekor qilindi. Noqulaylik uchun uzr so'raymiz.`;
        }

        if (cancelledReason) {
            message += `\n\n📝 <b>Sabab:</b> ${cancelledReason}`;
        }

        if (otherBookings && otherBookings.length > 0) {
            message += `\n\n⏰ Biroq, sizning boshqa buyurtmalaringiz faol:`;
            for (const booking of otherBookings) {
                message += `\n• <b>${booking.employeeName}</b> bilan soat <b>${booking.startTime}</b> da`;
            }
            message += `\nKechikmaslikni iltimos qilamiz!`;
        }
    } else {
        const statusMessages = {
            confirmed: '✅ <b>Buyurtmangiz tasdiqlandi!</b>',
            completed: '🎉 <b>Buyurtmangiz yakunlandi!</b>',
            no_show: '⚠️ <b>Buyurtmangiz "Kelmadi" deb belgilandi</b>'
        };

        const statusMessage = statusMessages[status] || `📋 <b>Buyurtma holati: ${status}</b>`;

        message = `${statusMessage}\n\n` +
            `🏢 <b>Biznes:</b> ${businessName}\n` +
            `📋 <b>Xizmat:</b> ${serviceName}\n` +
            `📅 <b>Sana:</b> ${date}\n` +
            `🕐 <b>Vaqt:</b> ${time}`;
    }

    await sendTelegramMessage(telegramId, message);
}
