import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const {
    mockTemplateAdd,
    mockTemplateGet,
    mockTemplateDocGet,
    mockTemplateDocDelete,
    mockTemplateDocUpdate,
    mockCampaignAdd,
    mockCampaignsQueryGet,
    mockBookingsGet,
    mockBusinessGet,
    mockEmployeesGet,
    mockUserDocGet,
    mockPolish,
    mockSendSms,
    mockSendTelegramMessage,
    mockSmsSendsGet,
} = vi.hoisted(() => ({
    mockTemplateAdd: vi.fn(),
    mockTemplateGet: vi.fn(),
    mockTemplateDocGet: vi.fn(),
    mockTemplateDocDelete: vi.fn(),
    mockTemplateDocUpdate: vi.fn(),
    mockCampaignAdd: vi.fn(),
    mockCampaignsQueryGet: vi.fn(),
    mockBookingsGet: vi.fn(),
    mockBusinessGet: vi.fn(),
    mockEmployeesGet: vi.fn(),
    mockUserDocGet: vi.fn(),
    mockPolish: vi.fn(),
    mockSendSms: vi.fn(),
    mockSendTelegramMessage: vi.fn(),
    mockSmsSendsGet: vi.fn(),
}));

vi.mock('../db/db.js', () => ({
    db: {
        collection: vi.fn((name) => {
            if (name === 'sms_templates') {
                return {
                    add: mockTemplateAdd,
                    where: vi.fn().mockReturnThis(),
                    orderBy: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockReturnThis(),
                    get: mockTemplateGet,
                    doc: vi.fn(() => ({
                        get: mockTemplateDocGet,
                        delete: mockTemplateDocDelete,
                        update: mockTemplateDocUpdate,
                    })),
                };
            }
            if (name === 'sms_campaigns') {
                return {
                    add: mockCampaignAdd,
                    where: vi.fn().mockReturnThis(),
                    orderBy: vi.fn().mockReturnThis(),
                    startAfter: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockReturnThis(),
                    get: mockCampaignsQueryGet,
                };
            }
            if (name === 'bookings') {
                return {
                    where: vi.fn().mockReturnThis(),
                    orderBy: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockReturnThis(),
                    get: mockBookingsGet,
                };
            }
            if (name === 'sms_sends') {
                return {
                    where: vi.fn().mockReturnThis(),
                    get: mockSmsSendsGet,
                    doc: vi.fn(() => ({ id: 'send-doc' })),
                };
            }
            if (name === 'businesses') {
                return { doc: vi.fn(() => ({ get: mockBusinessGet })) };
            }
            if (name === 'business_owners' || name === 'users') {
                return { doc: vi.fn(() => ({ get: mockUserDocGet })) };
            }
            return {
                doc: vi.fn(() => ({ get: vi.fn().mockResolvedValue({ exists: false }) })),
                where: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
            };
        }),
        collectionGroup: vi.fn(() => ({
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: mockEmployeesGet,
        })),
    },
}));

vi.mock('../utils/aiPolish.js', () => ({ polishSmsText: mockPolish }));
vi.mock('../utils/eskiz.js', () => ({ sendSms: mockSendSms }));
vi.mock('../utils/telegram.js', () => ({
    sendTelegramMessage: mockSendTelegramMessage,
}));

import app from '../server.js';

const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-abc123';
const API_SECRET = 'test-api-secret-at-least-32-chars-long-abc123';

function makeSignedHeaders(body) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body && Object.keys(body).length > 0 ? JSON.stringify(body) : '';
    const payload = bodyStr + timestamp;
    const signature = crypto
        .createHmac('sha256', API_SECRET)
        .update(payload)
        .digest('hex');
    return { 'X-Timestamp': timestamp, 'X-Signature': signature };
}

function authToken(userType, userId) {
    return jwt.sign(
        { user_id: userId, user_type: userType, type: 'access' },
        JWT_SECRET,
        { expiresIn: '1h' },
    );
}

const ownerUser = {
    exists: true,
    id: 'owner-1',
    data: () => ({
        first_name: 'Own',
        phone_number: '998900000001',
        is_verified: true,
    }),
};

beforeEach(() => {
    vi.clearAllMocks();
    mockUserDocGet.mockResolvedValue(ownerUser);
    mockBusinessGet.mockResolvedValue({
        exists: true,
        data: () => ({ business_owner_id: 'owner-1' }),
    });
    mockEmployeesGet.mockResolvedValue({ empty: true, docs: [] });
    mockSmsSendsGet.mockResolvedValue({ docs: [] });
});

describe('POST /businesses/:businessId/sms/templates', () => {
    it('creates a pending_moderation template with the user-provided text', async () => {
        mockTemplateAdd.mockResolvedValue({ id: 'tpl-1' });
        mockSendTelegramMessage.mockResolvedValue();

        const body = { example_text: 'Salom! Chegirma bor.' };
        const res = await request(app)
            .post('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            id: 'tpl-1',
            example_text: 'Salom! Chegirma bor.',
            polished_text: 'Salom! Chegirma bor.',
            status: 'pending_moderation',
            creator_type: 'business_owner',
            business_id: 'biz-1',
        });
        expect(mockTemplateAdd).toHaveBeenCalledOnce();
        const writtenDoc = mockTemplateAdd.mock.calls[0][0];
        expect(writtenDoc.status).toBe('pending_moderation');
        expect(writtenDoc.business_id).toBe('biz-1');
        expect(writtenDoc.creator_id).toBe('owner-1');
        expect(writtenDoc.polished_text).toBe('Salom! Chegirma bor.');
    });

    it('returns 403 when caller is not authorized for the business', async () => {
        mockBusinessGet.mockResolvedValue({
            exists: true,
            data: () => ({ business_owner_id: 'someone-else' }),
        });

        const body = { example_text: 'hi' };
        const res = await request(app)
            .post('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(403);
    });
});

describe('GET /businesses/:businessId/sms/templates', () => {
    it('returns the caller\'s templates ordered by created_at desc', async () => {
        mockTemplateGet.mockResolvedValue({
            docs: [
                {
                    id: 't1',
                    data: () => ({
                        business_id: 'biz-1',
                        creator_id: 'owner-1',
                        creator_type: 'business_owner',
                        polished_text: 'a',
                        status: 'confirmed',
                        created_at: { toDate: () => new Date('2026-05-20') },
                    }),
                },
            ],
        });

        const res = await request(app)
            .get('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({ id: 't1', polished_text: 'a', status: 'confirmed' }),
        ]);
    });

    it('accepts ?status=confirmed filter', async () => {
        mockTemplateGet.mockResolvedValue({ docs: [] });

        const res = await request(app)
            .get('/businesses/biz-1/sms/templates?status=confirmed')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

describe('DELETE /businesses/:businessId/sms/templates/:id', () => {
    it('deletes a template owned by the caller', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({
                business_id: 'biz-1',
                creator_id: 'owner-1',
                creator_type: 'business_owner',
            }),
        });
        mockTemplateDocDelete.mockResolvedValue();

        const res = await request(app)
            .delete('/businesses/biz-1/sms/templates/t1')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(204);
        expect(mockTemplateDocDelete).toHaveBeenCalledOnce();
    });

    it('returns 403 when trying to delete another creator\'s template', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({
                business_id: 'biz-1',
                creator_id: 'someone-else',
                creator_type: 'business_owner',
            }),
        });

        const res = await request(app)
            .delete('/businesses/biz-1/sms/templates/t1')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(403);
        expect(mockTemplateDocDelete).not.toHaveBeenCalled();
    });

    it('returns 404 when template does not exist', async () => {
        mockTemplateDocGet.mockResolvedValue({ exists: false });

        const res = await request(app)
            .delete('/businesses/biz-1/sms/templates/nope')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(404);
    });
});

describe('GET /businesses/:businessId/sms/recipients', () => {
    it('returns distinct recipients sorted by last_visit_at desc', async () => {
        mockBookingsGet.mockResolvedValue({
            docs: [
                {
                    data: () => ({
                        customer_phone: '998900000010',
                        customer_name: 'Ali',
                        booking_date: '2026-05-01',
                        status: 'completed',
                    }),
                },
                {
                    data: () => ({
                        customer_phone: '998900000010',
                        customer_name: 'Ali',
                        booking_date: '2026-05-20',
                        status: 'pending',
                    }),
                },
                {
                    data: () => ({
                        customer_phone: '998900000011',
                        customer_name: 'Vali',
                        booking_date: '2026-04-01',
                        status: 'pending',
                    }),
                },
            ],
        });

        const res = await request(app)
            .get('/businesses/biz-1/sms/recipients')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(res.body[0]).toMatchObject({
            phone_number: '998900000010',
            name: 'Ali',
            visit_count: 2,
            in_cooldown: false,
            cooldown_until: null,
        });
        expect(res.body[1]).toMatchObject({
            phone_number: '998900000011',
            name: 'Vali',
            visit_count: 1,
            in_cooldown: false,
            cooldown_until: null,
        });
    });

    it('marks a recently-contacted recipient as in_cooldown', async () => {
        mockBookingsGet.mockResolvedValue({
            docs: [
                { data: () => ({ customer_phone: '998900000010', customer_name: 'Ali', booking_date: '2026-05-01' }) },
                { data: () => ({ customer_phone: '998900000011', customer_name: 'Vali', booking_date: '2026-04-01' }) },
            ],
        });
        mockSmsSendsGet.mockResolvedValue({
            docs: [
                { data: () => ({ phone: '998900000010', success: true, sent_at: { toDate: () => new Date('2026-05-25T00:00:00.000Z') } }) },
            ],
        });

        const res = await request(app)
            .get('/businesses/biz-1/sms/recipients')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        const ali = res.body.find((r) => r.phone_number === '998900000010');
        const vali = res.body.find((r) => r.phone_number === '998900000011');
        expect(ali).toMatchObject({ in_cooldown: true, cooldown_until: '2026-06-24T00:00:00.000Z' });
        expect(vali).toMatchObject({ in_cooldown: false, cooldown_until: null });
    });
});

describe('POST /businesses/:businessId/sms/send', () => {
    it('sends to all phones and writes a campaign on success', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({
                business_id: 'biz-1',
                creator_id: 'owner-1',
                creator_type: 'business_owner',
                polished_text: 'Salom!\nBLYSS',
                status: 'confirmed',
            }),
        });
        mockSendSms.mockResolvedValue({ success: true });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-1' });

        const body = {
            template_id: 't1',
            phone_numbers: ['998900000010', '998900000011'],
        };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            campaign_id: 'camp-1',
            sent: 2,
            failed: 0,
        });
        expect(mockSendSms).toHaveBeenCalledTimes(2);
        expect(mockCampaignAdd).toHaveBeenCalledOnce();
        const camp = mockCampaignAdd.mock.calls[0][0];
        expect(camp).toMatchObject({
            business_id: 'biz-1',
            template_id: 't1',
            message_snapshot: 'Salom!\nBLYSS',
            recipient_count: 2,
            success_count: 2,
            failure_count: 0,
        });
    });

    it('returns 403 when template is not confirmed', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({
                business_id: 'biz-1',
                creator_id: 'owner-1',
                creator_type: 'business_owner',
                polished_text: 'x',
                status: 'pending_moderation',
            }),
        });

        const body = { template_id: 't1', phone_numbers: ['998900000010'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error_code: 'TEMPLATE_NOT_APPROVED' });
        expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('returns 403 when template belongs to another business', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({
                business_id: 'biz-OTHER',
                creator_id: 'owner-1',
                creator_type: 'business_owner',
                polished_text: 'x',
                status: 'confirmed',
            }),
        });

        const body = { template_id: 't1', phone_numbers: ['998900000010'] };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(403);
    });

    it('returns 502 when >50% of sends fail, still writes the campaign', async () => {
        mockTemplateDocGet.mockResolvedValue({
            exists: true,
            id: 't1',
            data: () => ({
                business_id: 'biz-1',
                creator_id: 'owner-1',
                creator_type: 'business_owner',
                polished_text: 'x',
                status: 'confirmed',
            }),
        });
        mockSendSms
            .mockResolvedValueOnce({ success: false, error: 'eskiz down' })
            .mockResolvedValueOnce({ success: false, error: 'eskiz down' })
            .mockResolvedValueOnce({ success: true });
        mockCampaignAdd.mockResolvedValue({ id: 'camp-2' });

        const body = {
            template_id: 't1',
            phone_numbers: ['998900000010', '998900000011', '998900000012'],
        };
        const res = await request(app)
            .post('/businesses/biz-1/sms/send')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ failed: 2, sent: 1 });
        expect(mockCampaignAdd).toHaveBeenCalledOnce();
    });
});

describe('GET /businesses/:businessId/sms/campaigns', () => {
    it('returns campaigns for the business, newest first', async () => {
        mockCampaignsQueryGet.mockResolvedValue({
            docs: [
                {
                    id: 'c2',
                    data: () => ({
                        business_id: 'biz-1',
                        sender_id: 'owner-1',
                        sender_type: 'business_owner',
                        template_id: 't1',
                        message_snapshot: 'Salom!',
                        recipient_count: 3,
                        success_count: 3,
                        failure_count: 0,
                        errors: [],
                        sent_at: { toDate: () => new Date('2026-05-22') },
                    }),
                },
            ],
        });

        const res = await request(app)
            .get('/businesses/biz-1/sms/campaigns')
            .set(makeSignedHeaders())
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({
            id: 'c2',
            recipient_count: 3,
            success_count: 3,
        });
    });
});
