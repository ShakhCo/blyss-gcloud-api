import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBusinessGet, mockEmployeesGet } = vi.hoisted(() => ({
    mockBusinessGet: vi.fn(),
    mockEmployeesGet: vi.fn(),
}));

vi.mock('../db/db.js', () => ({
    db: {
        collection: vi.fn((name) => {
            if (name === 'businesses') {
                return {
                    doc: vi.fn(() => ({ get: mockBusinessGet })),
                };
            }
            return { get: vi.fn() };
        }),
        collectionGroup: vi.fn(() => ({
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: mockEmployeesGet,
        })),
    },
}));

import { resolveSmsContext } from './smsContext.js';

beforeEach(() => {
    mockBusinessGet.mockReset();
    mockEmployeesGet.mockReset();
});

describe('resolveSmsContext', () => {
    it('returns business_owner context when caller owns the business', async () => {
        mockBusinessGet.mockResolvedValue({
            exists: true,
            data: () => ({ business_owner_id: 'owner-1' }),
        });

        const ctx = await resolveSmsContext(
            { id: 'owner-1', user_type: 'business_owner' },
            'biz-1',
        );

        expect(ctx).toEqual({
            creator_id: 'owner-1',
            creator_type: 'business_owner',
            business_id: 'biz-1',
        });
    });

    it('returns employee context when caller has an employee record at the business', async () => {
        mockBusinessGet.mockResolvedValue({
            exists: true,
            data: () => ({ business_owner_id: 'someone-else' }),
        });
        mockEmployeesGet.mockResolvedValue({
            empty: false,
            docs: [{ id: 'emp-7', ref: { parent: { parent: { id: 'biz-1' } } } }],
        });

        const ctx = await resolveSmsContext(
            { id: 'user-9', phone_number: '998900000007', user_type: 'user' },
            'biz-1',
        );

        expect(ctx).toEqual({
            creator_id: 'emp-7',
            creator_type: 'employee',
            business_id: 'biz-1',
        });
    });

    it('throws FORBIDDEN when caller is not owner and has no employee record', async () => {
        mockBusinessGet.mockResolvedValue({
            exists: true,
            data: () => ({ business_owner_id: 'someone-else' }),
        });
        mockEmployeesGet.mockResolvedValue({ empty: true, docs: [] });

        await expect(
            resolveSmsContext(
                { id: 'user-x', phone_number: '998900000099', user_type: 'user' },
                'biz-1',
            ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('throws NOT_FOUND when business does not exist', async () => {
        mockBusinessGet.mockResolvedValue({ exists: false });

        await expect(
            resolveSmsContext({ id: 'whoever', user_type: 'business_owner' }, 'biz-missing'),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});
