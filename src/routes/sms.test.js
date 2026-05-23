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
});

describe('POST /businesses/:businessId/sms/templates', () => {
    it('creates a pending_moderation template after AI polish', async () => {
        mockPolish.mockResolvedValue('Salom! Chegirma bor.\nBLYSS');
        mockTemplateAdd.mockResolvedValue({ id: 'tpl-1' });
        mockSendTelegramMessage.mockResolvedValue();

        const body = { example_text: 'salom chegirma' };
        const res = await request(app)
            .post('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            id: 'tpl-1',
            polished_text: 'Salom! Chegirma bor.\nBLYSS',
            status: 'pending_moderation',
            creator_type: 'business_owner',
            business_id: 'biz-1',
        });
        expect(mockTemplateAdd).toHaveBeenCalledOnce();
        const writtenDoc = mockTemplateAdd.mock.calls[0][0];
        expect(writtenDoc.status).toBe('pending_moderation');
        expect(writtenDoc.business_id).toBe('biz-1');
        expect(writtenDoc.creator_id).toBe('owner-1');
    });

    it('returns 400 when AI output is invalid', async () => {
        mockPolish.mockRejectedValue(
            Object.assign(new Error('bad'), { code: 'AI_OUTPUT_INVALID', rule: 'no_urls' }),
        );

        const body = { example_text: 'spam http://x.com' };
        const res = await request(app)
            .post('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error_code: 'AI_OUTPUT_INVALID' });
        expect(mockTemplateAdd).not.toHaveBeenCalled();
    });

    it('returns 503 when AI is unavailable', async () => {
        mockPolish.mockRejectedValue(
            Object.assign(new Error('no key'), { code: 'AI_UNAVAILABLE' }),
        );

        const body = { example_text: 'anything' };
        const res = await request(app)
            .post('/businesses/biz-1/sms/templates')
            .set(makeSignedHeaders(body))
            .set('Cookie', `access_token=${authToken('business_owner', 'owner-1')}`)
            .send(body);

        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ error_code: 'AI_UNAVAILABLE' });
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
