/**
 * Eskiz SMS service for sending SMS notifications
 */

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
 * Send OTP SMS
 * @param {string} phoneNumber - The recipient's phone number
 * @param {string} otpCode - The OTP code to send
 * @param {string} userType - The user type ('user' or 'business_owner')
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendOtpSms(phoneNumber, otpCode, userType = 'user') {
    const message = userType === 'business_owner'
        ? `${otpCode} BLYSS BUSINESS ga kirish kodi. Код входа в BLYSS BUSINESS.`
        : `${otpCode} BLYSS ilovasiga kirish kodi. Код входа в приложение BLYSS.`;
    return sendSms(phoneNumber, message);
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
