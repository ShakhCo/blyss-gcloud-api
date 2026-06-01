import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const { mockUserDoc, mockCollection } = vi.hoisted(() => {
    const mockUserDoc = {
        exists: true,
        id: 'user123',
        data: () => ({
            first_name: 'Test',
            last_name: 'User',
            phone_number: '998901234567',
            is_verified: true,
            user_type: 'business_owner',
            balance: 22450.5,
        }),
    };
    const mockCollection = vi.fn((name) => {
        if (name === 'business_owners' || name === 'users') {
            return {
                doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue(mockUserDoc) }),
                where: vi.fn().mockReturnThis(),
                orderBy: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
            };
        }
        return {
            doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ exists: false }), set: vi.fn() }),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
        };
    });
    return { mockUserDoc, mockCollection };
});

vi.mock('../db/db.js', () => ({ db: { collection: mockCollection } }));

import app from '../server.js';

const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-abc123';
const API_SECRET_VAL = 'test-api-secret-at-least-32-chars-long-abc123';

function makeAccessToken(overrides = {}) {
    return jwt.sign(
        { user_id: 'user123', user_type: 'business_owner', type: 'access', ...overrides },
        JWT_SECRET,
        { expiresIn: '24h' },
    );
}
function makeHmacHeaders(bodyStr = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto.createHmac('sha256', API_SECRET_VAL).update(bodyStr + timestamp).digest('hex');
    return { 'x-timestamp': timestamp, 'x-signature': signature };
}

describe('GET /auth/me — balance', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the stored decimal balance', async () => {
        const hmac = makeHmacHeaders('');
        const res = await request(app)
            .get('/auth/me')
            .set('x-timestamp', hmac['x-timestamp'])
            .set('x-signature', hmac['x-signature'])
            .set('Cookie', `access_token=${makeAccessToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(22450.5);
    });

    it('defaults balance to 0 when the stored doc has none', async () => {
        mockUserDoc.data = () => ({
            first_name: 'Test',
            last_name: 'User',
            phone_number: '998901234567',
            is_verified: true,
            user_type: 'business_owner',
        });
        const hmac = makeHmacHeaders('');
        const res = await request(app)
            .get('/auth/me')
            .set('x-timestamp', hmac['x-timestamp'])
            .set('x-signature', hmac['x-signature'])
            .set('Cookie', `access_token=${makeAccessToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(0);
    });
});
