/**
 * Eskiz SMS service for sending SMS notifications
 */

import { db } from '../db/db.js';
import { sendTelegramMessage } from './telegram.js';

const ESKIZ_API_URL = 'https://notify.eskiz.uz/api/message/sms/send';
const ESKIZ_TOKEN = process.env.ESKIZ_TOKEN;
const ESKIZ_SENDER = '4546';

/**
 * Send an SMS via Eskiz API
 * @param {string} phoneNumber - The recipient's phone number
 * @param {string} message - The message content to send
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendSms(phoneNumber, message) {
    if (!ESKIZ_TOKEN) {
        console.error('ESKIZ_TOKEN is not configured');
        return { success: false, error: 'Eskiz is not configured' };
    }

    if (!phoneNumber) {
        console.error('phone_number is required');
        return { success: false, error: 'phone_number is required' };
    }

    if (!message) {
        console.error('message is required');
        return { success: false, error: 'message is required' };
    }

    try {
        const response = await fetch(ESKIZ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ESKIZ_TOKEN}`
            },
            body: JSON.stringify({
                mobile_phone: phoneNumber,
                message: message,
                from: ESKIZ_SENDER,
                callback_url: ''
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Eskiz API error:', response.status, errorText);
            return { success: false, error: `Eskiz API error: ${response.status}` };
        }

        return { success: true };
    } catch (error) {
        console.error('Error sending SMS via Eskiz:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Send OTP via SMS and Telegram (if user has a telegram_id)
 * @param {string} phoneNumber - The recipient's phone number
 * @param {string} otpCode - The OTP code to send
 * @param {string} userType - The user type ('user' or 'business_owner')
 * @returns {Promise<{success: boolean, delivery_method?: string, error?: string}>}
 */
export async function sendOtpSms(phoneNumber, otpCode, userType = 'user') {
    const message = userType === 'business_owner'
        ? `${otpCode} BLYSS BUSINESS ga kirish kodi. Код входа в BLYSS BUSINESS.`
        : `${otpCode} BLYSS ilovasiga kirish kodi. Код входа в приложение BLYSS.`;

    const smsResult = await sendSms(phoneNumber, message);

    // Try sending via Telegram if user has a telegram_id
    let telegramSent = false;
    try {
        const collection = userType === 'business_owner' ? 'business_owners' : 'users';
        const userSnapshot = await db.collection(collection)
            .where('phone_number', '==', phoneNumber)
            .limit(1)
            .get();

        if (!userSnapshot.empty) {
            const userData = userSnapshot.docs[0].data();
            if (userData.telegram_id) {
                await sendTelegramMessage(userData.telegram_id, message);
                telegramSent = true;
            }
        }
    } catch (err) {
        console.error('Telegram OTP delivery failed:', err.message);
    }

    const success = smsResult.success || telegramSent;
    const delivery_method = [
        smsResult.success && 'sms',
        telegramSent && 'telegram'
    ].filter(Boolean).join('+') || undefined;

    return { success, delivery_method, error: success ? undefined : smsResult.error };
}

/**
 * Send business invitation SMS
 * @param {string} phoneNumber - The recipient's phone number
 * @param {string} businessName - The name of the business
 * @param {string} inviteLink - The invitation link
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendBusinessInvitationSms(phoneNumber, businessName, inviteLink) {
    const message = `${businessName} sizni jamoaga taklif qildi. ${businessName} пригласил в команду. ${inviteLink}`;
    return sendSms(phoneNumber, message);
}
