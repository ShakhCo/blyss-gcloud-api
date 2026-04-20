import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { thirdPartySendSmsSchema } from '../schemas/thirdPartySms.js';
import { sendSms } from '../utils/eskiz.js';

const router = Router();
const REQUIRED_MARKER = 'InformTech.uz';

router.post('/send-sms', validate(thirdPartySendSmsSchema), async (req, res) => {
    const { phone_number, message } = req.validated;

    if (!message.includes(REQUIRED_MARKER)) {
        return res.status(403).json({
            error: 'SMS body must contain the required marker',
            error_code: 'FORBIDDEN_CONTENT'
        });
    }

    try {
        const result = await sendSms(phone_number, message);
        if (!result.success) {
            return res.status(502).json({
                error: result.error,
                error_code: 'SMS_PROVIDER_ERROR'
            });
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('third-party send-sms failed:', err);
        return res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

export default router;
