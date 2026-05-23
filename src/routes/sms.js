import { Router } from 'express';
import { db } from '../db/db.js';
import { FieldValue } from '@google-cloud/firestore';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import {
    createTemplateSchema,
    listTemplatesQuerySchema,
} from '../schemas/sms.js';
import { polishSmsText } from '../utils/aiPolish.js';
import { resolveSmsContext } from '../utils/smsContext.js';
import { sendTelegramMessage } from '../utils/telegram.js';

const router = Router({ mergeParams: true });

router.use(authenticate);

async function withSmsContext(req, res, next) {
    try {
        req.smsCtx = await resolveSmsContext(req.user, req.params.businessId);
        next();
    } catch (err) {
        if (err.code === 'NOT_FOUND') {
            return res.status(404).json({ error: 'Business not found', error_code: 'NOT_FOUND' });
        }
        if (err.code === 'FORBIDDEN') {
            return res.status(403).json({ error: 'Not authorized for this business', error_code: 'FORBIDDEN' });
        }
        console.error('smsContext failed:', err);
        return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
}

router.use(withSmsContext);

router.post('/templates', validate(createTemplateSchema), async (req, res) => {
    const { example_text } = req.validated;
    const { creator_id, creator_type, business_id } = req.smsCtx;

    let polished;
    try {
        polished = await polishSmsText(example_text);
    } catch (err) {
        if (err.code === 'AI_UNAVAILABLE') {
            return res.status(503).json({ error: 'AI not available', error_code: 'AI_UNAVAILABLE' });
        }
        if (err.code === 'AI_OUTPUT_INVALID') {
            return res.status(400).json({
                error: `AI output failed validation: ${err.rule}`,
                error_code: 'AI_OUTPUT_INVALID',
                rule: err.rule,
            });
        }
        console.error('polishSmsText failed:', err);
        return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }

    const doc = {
        business_id,
        creator_id,
        creator_type,
        example_text,
        polished_text: polished,
        status: 'pending_moderation',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        moderated_at: null,
    };

    const ref = await db.collection('sms_templates').add(doc);

    if (process.env.OPERATOR_TG_ID) {
        sendTelegramMessage(
            process.env.OPERATOR_TG_ID,
            `New SMS template (${creator_type} ${creator_id} @ ${business_id}):\n\n${polished}\n\nTemplate ID: ${ref.id}`,
        ).catch((e) => console.error('operator telegram ping failed:', e.message));
    }

    return res.status(201).json({ id: ref.id, ...doc, created_at: null });
});

router.get('/templates', validate(listTemplatesQuerySchema, 'query'), async (req, res) => {
    const { creator_id, creator_type, business_id } = req.smsCtx;
    const { status } = req.validated;

    let query = db
        .collection('sms_templates')
        .where('business_id', '==', business_id)
        .where('creator_id', '==', creator_id)
        .where('creator_type', '==', creator_type);

    if (status) query = query.where('status', '==', status);

    query = query.orderBy('created_at', 'desc');

    const snap = await query.get();
    const items = snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
            moderated_at: data.moderated_at?.toDate?.()?.toISOString() ?? null,
        };
    });
    return res.json(items);
});

router.delete('/templates/:id', async (req, res) => {
    const { creator_id, creator_type, business_id } = req.smsCtx;
    const ref = db.collection('sms_templates').doc(req.params.id);
    const snap = await ref.get();

    if (!snap.exists) {
        return res.status(404).json({ error: 'Template not found', error_code: 'NOT_FOUND' });
    }
    const data = snap.data();
    if (
        data.business_id !== business_id ||
        data.creator_id !== creator_id ||
        data.creator_type !== creator_type
    ) {
        return res.status(403).json({ error: 'Forbidden', error_code: 'FORBIDDEN' });
    }

    await ref.delete();
    return res.status(204).end();
});

export default router;
