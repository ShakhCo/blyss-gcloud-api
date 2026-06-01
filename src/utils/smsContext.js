import { db } from '../db/db.js';

export async function resolveSmsContext(user, businessId) {
    if (!user || !businessId) {
        const err = new Error('Missing user or businessId');
        err.code = 'FORBIDDEN';
        throw err;
    }

    const businessDoc = await db.collection('businesses').doc(businessId).get();
    if (!businessDoc.exists) {
        const err = new Error('Business not found');
        err.code = 'NOT_FOUND';
        throw err;
    }

    const businessData = businessDoc.data();

    if (user.user_type === 'business_owner' && businessData.business_owner_id === user.id) {
        return {
            creator_id: user.id,
            creator_type: 'business_owner',
            business_id: businessId,
            business_owner_id: businessData.business_owner_id,
            tenant_url: businessData.tenant_url ?? null,
        };
    }

    if (user.phone_number) {
        const empSnap = await db
            .collectionGroup('employees')
            .where('phone_number', '==', user.phone_number)
            .limit(20)
            .get();

        if (!empSnap.empty) {
            const match = empSnap.docs.find(
                (d) => d.ref.parent.parent && d.ref.parent.parent.id === businessId,
            );
            if (match) {
                return {
                    creator_id: match.id,
                    creator_type: 'employee',
                    business_id: businessId,
                    business_owner_id: businessData.business_owner_id,
                    tenant_url: businessData.tenant_url ?? null,
                };
            }
        }
    }

    const err = new Error('Not authorized for this business');
    err.code = 'FORBIDDEN';
    throw err;
}
