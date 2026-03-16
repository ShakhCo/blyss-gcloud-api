/**
 * TDD tests for AUTH-04: refresh token revocation on logout
 *
 * These tests verify:
 * 1. POST /auth/logout writes a document to Firestore revoked_tokens
 * 2. POST /auth/refresh with a revoked token returns 401 TOKEN_REVOKED
 * 3. POST /auth/logout without a refresh token cookie still succeeds (200)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// --- Use vi.hoisted() so variables are available inside vi.mock() factory ---
const { mockDocRef, mockCollection, mockUserDoc } = vi.hoisted(() => {
    const mockDocRef = {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({ exists: false }),
    };

    const mockUserDoc = {
        exists: true,
        id: 'user123',
        data: () => ({
            first_name: 'Test',
            last_name: 'User',
            phone_number: '998901234567',
            is_verified: true,
            user_type: 'business_owner',
        }),
    };

    const mockCollection = vi.fn((collectionName) => {
        if (collectionName === 'revoked_tokens') {
            return {
                doc: vi.fn().mockReturnValue(mockDocRef),
            };
        }
        // Users / business_owners collection (for authenticate middleware)
        if (collectionName === 'business_owners' || collectionName === 'users') {
            return {
                doc: vi.fn().mockReturnValue({
                    get: vi.fn().mockResolvedValue(mockUserDoc),
                }),
                where: vi.fn().mockReturnThis(),
                orderBy: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
            };
        }
        return {
            doc: vi.fn().mockReturnValue(mockDocRef),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
            add: vi.fn().mockResolvedValue({ id: 'mock-doc-id' }),
        };
    });

    return { mockDocRef, mockCollection, mockUserDoc };
});

// --- Mock Firestore db ---
vi.mock('../db/db.js', () => ({
    db: {
        collection: mockCollection,
    },
}));

// --- Mock eskiz SMS so tests don't send real messages ---
vi.mock('../utils/eskiz.js', () => ({
    sendOtpSms: vi.fn().mockResolvedValue({ success: true, delivery_method: 'sms' }),
}));

import app from '../server.js';

// Test constants (must match vitest.config.js env values)
const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-abc123';
const API_SECRET_VAL = 'test-api-secret-at-least-32-chars-long-abc123';

function makeRefreshToken(overrides = {}) {
    return jwt.sign(
        { user_id: 'user123', user_type: 'business_owner', type: 'refresh', ...overrides },
        JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function makeAccessToken(overrides = {}) {
    return jwt.sign(
        { user_id: 'user123', user_type: 'business_owner', type: 'access', ...overrides },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

function makeHmacHeaders(bodyStr = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = bodyStr + timestamp;
    const signature = crypto.createHmac('sha256', API_SECRET_VAL).update(message).digest('hex');
    return { 'x-timestamp': timestamp, 'x-signature': signature };
}

describe('Auth token revocation (AUTH-04)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: revoked_tokens doc does not exist
        mockDocRef.get.mockResolvedValue({ exists: false });
        mockDocRef.set.mockResolvedValue(undefined);

        // Reset mockCollection to default routing
        mockCollection.mockImplementation((collectionName) => {
            if (collectionName === 'revoked_tokens') {
                return {
                    doc: vi.fn().mockReturnValue(mockDocRef),
                };
            }
            if (collectionName === 'business_owners' || collectionName === 'users') {
                return {
                    doc: vi.fn().mockReturnValue({
                        get: vi.fn().mockResolvedValue(mockUserDoc),
                    }),
                    where: vi.fn().mockReturnThis(),
                    orderBy: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockReturnThis(),
                    get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
                };
            }
            return {
                doc: vi.fn().mockReturnValue(mockDocRef),
                where: vi.fn().mockReturnThis(),
                orderBy: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
                add: vi.fn().mockResolvedValue({ id: 'mock-doc-id' }),
            };
        });
    });

    describe('POST /auth/logout — token revocation', () => {
        it('writes a revoked_tokens document when refresh_token cookie is present', async () => {
            const accessToken = makeAccessToken();
            const refreshToken = makeRefreshToken();
            const hmac = makeHmacHeaders('');

            const res = await request(app)
                .post('/auth/logout')
                .set('x-timestamp', hmac['x-timestamp'])
                .set('x-signature', hmac['x-signature'])
                .set('Cookie', [
                    `access_token=${accessToken}`,
                    `refresh_token=${refreshToken}`,
                ]);

            expect(res.status).toBe(200);
            expect(res.body.message).toBe('Logged out successfully');
            // Verify revoked_tokens collection was accessed
            expect(mockCollection).toHaveBeenCalledWith('revoked_tokens');
            // Verify set was called with revocation data containing expected fields
            expect(mockDocRef.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    revokedAt: expect.any(Date),
                    userId: 'user123',
                    expiresAt: expect.any(Date),
                })
            );
        });

        it('returns 200 and skips revocation when refresh_token cookie is absent', async () => {
            const accessToken = makeAccessToken();
            const hmac = makeHmacHeaders('');

            const res = await request(app)
                .post('/auth/logout')
                .set('x-timestamp', hmac['x-timestamp'])
                .set('x-signature', hmac['x-signature'])
                .set('Cookie', `access_token=${accessToken}`);

            expect(res.status).toBe(200);
            expect(res.body.message).toBe('Logged out successfully');
            // No revocation write should happen
            expect(mockDocRef.set).not.toHaveBeenCalled();
        });
    });

    describe('POST /auth/refresh — revocation check', () => {
        it('returns 401 TOKEN_REVOKED when the refresh token has been revoked', async () => {
            const refreshToken = makeRefreshToken();
            // Simulate revoked token: doc exists in Firestore
            mockDocRef.get.mockResolvedValue({ exists: true });

            const bodyStr = JSON.stringify({ refresh_token: refreshToken });
            const hmac = makeHmacHeaders(bodyStr);

            const res = await request(app)
                .post('/auth/refresh')
                .set('x-timestamp', hmac['x-timestamp'])
                .set('x-signature', hmac['x-signature'])
                .set('Content-Type', 'application/json')
                .send({ refresh_token: refreshToken });

            expect(res.status).toBe(401);
            expect(res.body.error_code).toBe('TOKEN_REVOKED');
            expect(res.body.error).toBe('Token has been revoked');
        });

        it('returns 200 and issues new tokens when refresh token is valid and not revoked', async () => {
            const refreshToken = makeRefreshToken();
            // Token not revoked: doc does not exist
            mockDocRef.get.mockResolvedValue({ exists: false });

            const bodyStr = JSON.stringify({ refresh_token: refreshToken });
            const hmac = makeHmacHeaders(bodyStr);

            const res = await request(app)
                .post('/auth/refresh')
                .set('x-timestamp', hmac['x-timestamp'])
                .set('x-signature', hmac['x-signature'])
                .set('Content-Type', 'application/json')
                .send({ refresh_token: refreshToken });

            expect(res.status).toBe(200);
            expect(res.body.access_token).toBeDefined();
            expect(res.body.refresh_token).toBeDefined();
        });
    });
});
