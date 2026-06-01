import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSmsSendsGet } = vi.hoisted(() => ({ mockSmsSendsGet: vi.fn() }));

vi.mock('../db/db.js', () => ({
    db: {
        collection: vi.fn(() => ({
            where: vi.fn().mockReturnThis(),
            get: mockSmsSendsGet,
        })),
    },
}));

import { SMS_COOLDOWN_DAYS, cooldownUntil, getRecentContactMap } from './smsCooldown.js';

function sendDoc(phone, success, sentAt) {
    return { data: () => ({ phone, success, sent_at: { toDate: () => sentAt } }) };
}

describe('cooldownUntil', () => {
    it('SMS_COOLDOWN_DAYS is 30', () => {
        expect(SMS_COOLDOWN_DAYS).toBe(30);
    });

    it('returns lastSent + 30 days as ISO', () => {
        expect(cooldownUntil(new Date('2026-05-01T00:00:00.000Z'))).toBe('2026-05-31T00:00:00.000Z');
    });
});

describe('getRecentContactMap', () => {
    beforeEach(() => vi.clearAllMocks());

    it('maps phone -> latest successful send, ignoring failures', async () => {
        const older = new Date('2026-05-10T00:00:00.000Z');
        const newer = new Date('2026-05-20T00:00:00.000Z');
        mockSmsSendsGet.mockResolvedValue({
            docs: [
                sendDoc('998900000010', true, older),
                sendDoc('998900000010', true, newer),
                sendDoc('998900000011', false, newer),
            ],
        });

        const map = await getRecentContactMap('biz-1');

        expect(map.get('998900000010')).toEqual(newer);
        expect(map.has('998900000011')).toBe(false); // failed send never locks
    });

    it('returns an empty map when there are no recent sends', async () => {
        mockSmsSendsGet.mockResolvedValue({ docs: [] });
        const map = await getRecentContactMap('biz-new');
        expect(map.size).toBe(0);
    });
});
