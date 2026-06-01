import { db } from '../db/db.js';

export const SMS_COOLDOWN_DAYS = 30;
const COOLDOWN_MS = SMS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

// ISO timestamp when a customer last contacted at `lastSent` (Date) becomes eligible again.
export function cooldownUntil(lastSent) {
    return new Date(lastSent.getTime() + COOLDOWN_MS).toISOString();
}

// Map<phone, Date> of the latest SUCCESSFUL send per phone within the cooldown window.
export async function getRecentContactMap(businessId, now = new Date()) {
    const cutoff = new Date(now.getTime() - COOLDOWN_MS);
    const snap = await db
        .collection('sms_sends')
        .where('business_id', '==', businessId)
        .where('sent_at', '>=', cutoff)
        .get();

    const map = new Map();
    for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.success) continue;
        const sentAt = d.sent_at?.toDate?.() ?? null;
        if (!sentAt) continue;
        const prev = map.get(d.phone);
        if (!prev || sentAt > prev) map.set(d.phone, sentAt);
    }
    return map;
}
