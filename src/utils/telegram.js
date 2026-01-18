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
 * @returns {Promise<void>}
 */
export async function sendBusinessInvitationNotification(telegramId, businessName) {
    const message = `🎉 <b>Sizni biznesga taklif qilishdi!</b>\n\nSizni <b>${businessName}</b> biznesiga ishchi sifatida taklif qilishdi.\n\nTaklifni qabul qilish uchun ilovaga kiring va "Ish joylarim" bo'limiga o'ting.`;

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
