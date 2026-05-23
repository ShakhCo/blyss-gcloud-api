import { Router } from 'express';
import { db } from '../db/db.js';
import { FieldValue } from '@google-cloud/firestore';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import {
    createTemplateSchema,
    listCampaignsQuerySchema,
    listTemplatesQuerySchema,
    sendCampaignSchema,
} from '../schemas/sms.js';
import { sendSms } from '../utils/eskiz.js';
import { resolveSmsContext } from '../utils/smsContext.js';
import { sendTelegramMessage } from '../utils/telegram.js';

async function sendWithConcurrency(phones, message, limit = 5) {
    const results = [];
    let cursor = 0;
    async function worker() {
        while (cursor < phones.length) {
            const idx = cursor++;
            const phone = phones[idx];
            try {
                const r = await sendSms(phone, message);
                results[idx] = { phone, success: !!r.success, error: r.error };
            } catch (err) {
                results[idx] = { phone, success: false, error: err.message };
            }
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, phones.length) }, () => worker()),
    );
    return results;
}

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

    const doc = {
        business_id,
        creator_id,
        creator_type,
        example_text,
        polished_text: example_text,
        status: 'pending_moderation',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        moderated_at: null,
    };

    const ref = await db.collection('sms_templates').add(doc);

    if (process.env.OPERATOR_TG_ID) {
        sendTelegramMessage(
            process.env.OPERATOR_TG_ID,
            `New SMS template (${creator_type} ${creator_id} @ ${business_id}):\n\n${example_text}\n\nTemplate ID: ${ref.id}`,
        ).catch((e) => console.error('operator telegram ping failed:', e.message));
    }

    return res.status(201).json({ id: ref.id, ...doc, created_at: null });
});

router.get('/templates', validate(listTemplatesQuerySchema, 'query'), async (req, res) => {
    const { creator_id, creator_type, business_id } = req.smsCtx;
    const { status } = req.validated;

    const snap = await db
        .collection('sms_templates')
        .where('business_id', '==', business_id)
        .where('creator_id', '==', creator_id)
        .where('creator_type', '==', creator_type)
        .orderBy('created_at', 'desc')
        .get();

    const items = snap.docs
        .map((d) => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
                moderated_at: data.moderated_at?.toDate?.()?.toISOString() ?? null,
            };
        })
        .filter((tpl) => !status || tpl.status === status);

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

router.get('/recipients', async (req, res) => {
    const { business_id } = req.smsCtx;

    const snap = await db
        .collection('bookings')
        .where('business_id', '==', business_id)
        .get();

    const byPhone = new Map();
    for (const doc of snap.docs) {
        const b = doc.data();
        if (!b.phone_number) continue;
        const visitDate =
            b.booking_date?.toDate?.() ??
            b.created_at?.toDate?.() ??
            null;
        const existing = byPhone.get(b.phone_number);
        if (!existing) {
            byPhone.set(b.phone_number, {
                phone_number: b.phone_number,
                name: b.client_name || null,
                last_visit_at: visitDate,
                visit_count: 1,
            });
        } else {
            existing.visit_count += 1;
            if (visitDate && (!existing.last_visit_at || visitDate > existing.last_visit_at)) {
                existing.last_visit_at = visitDate;
                if (b.client_name) existing.name = b.client_name;
            }
        }
    }

    const items = Array.from(byPhone.values())
        .sort((a, b) => (b.last_visit_at?.getTime() ?? 0) - (a.last_visit_at?.getTime() ?? 0))
        .slice(0, 500)
        .map((r) => ({
            ...r,
            last_visit_at: r.last_visit_at?.toISOString() ?? null,
        }));

    return res.json(items);
});

router.post('/send', validate(sendCampaignSchema), async (req, res) => {
    const { template_id, phone_numbers } = req.validated;
    const { creator_id, creator_type, business_id } = req.smsCtx;

    const tplRef = db.collection('sms_templates').doc(template_id);
    const tplSnap = await tplRef.get();
    if (!tplSnap.exists) {
        return res.status(404).json({ error: 'Template not found', error_code: 'NOT_FOUND' });
    }
    const tpl = tplSnap.data();
    if (tpl.business_id !== business_id) {
        return res.status(403).json({ error: 'Forbidden', error_code: 'FORBIDDEN' });
    }
    if (tpl.status !== 'confirmed') {
        return res
            .status(403)
            .json({ error: 'Template not approved', error_code: 'TEMPLATE_NOT_APPROVED' });
    }

    const results = await sendWithConcurrency(phone_numbers, tpl.polished_text, 5);
    const failures = results.filter((r) => !r.success);

    const campaignDoc = {
        business_id,
        sender_id: creator_id,
        sender_type: creator_type,
        template_id,
        message_snapshot: tpl.polished_text,
        recipient_count: phone_numbers.length,
        success_count: results.length - failures.length,
        failure_count: failures.length,
        errors: failures.slice(0, 20).map((f) => ({ phone: f.phone, error: f.error || 'unknown' })),
        sent_at: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('sms_campaigns').add(campaignDoc);

    const payload = {
        campaign_id: ref.id,
        sent: campaignDoc.success_count,
        failed: campaignDoc.failure_count,
        errors: campaignDoc.errors,
    };

    const failedTooMany = failures.length > phone_numbers.length / 2;
    return res.status(failedTooMany ? 502 : 200).json(payload);
});

router.get('/campaigns', validate(listCampaignsQuerySchema, 'query'), async (req, res) => {
    const { business_id } = req.smsCtx;
    const { limit } = req.validated;

    const snap = await db
        .collection('sms_campaigns')
        .where('business_id', '==', business_id)
        .orderBy('sent_at', 'desc')
        .limit(limit)
        .get();

    const items = snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            sent_at: data.sent_at?.toDate?.()?.toISOString() ?? null,
        };
    });
    return res.json(items);
});

export default router;
