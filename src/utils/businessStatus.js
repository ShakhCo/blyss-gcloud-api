/**
 * Check all verification requirements and update business_status accordingly.
 *
 * Requirements for 'verified':
 *   1. avatar_url exists
 *   2. cover_url exists
 *   3. 4+ gallery photos
 *   4. 1+ active service
 *   5. 1+ employee with 1+ assigned service (employeeServices subcollection)
 *
 * If all met → 'verified', if any missing → 'pending'.
 * Only writes if the status actually changed.
 */
export async function checkAndUpdateBusinessStatus(db, businessId) {
    const businessRef = db.collection('businesses').doc(businessId);
    const businessDoc = await businessRef.get();

    if (!businessDoc.exists) return;

    const data = businessDoc.data();
    const currentStatus = data.business_status;

    // 1. avatar_url exists
    const hasAvatar = !!data.avatar_url;

    // 2. cover_url exists
    const hasCover = !!data.cover_url;

    // 3–5: run subcollection queries in parallel
    const [photosSnapshot, activeServiceSnapshot, employeesSnapshot] = await Promise.all([
        // 3. 4+ gallery photos
        db.collection('businesses').doc(businessId).collection('photos').get(),
        // 4. 1+ active service
        db.collection('businesses').doc(businessId).collection('services')
            .where('is_active', '==', true).limit(1).get(),
        // 5. employees (need to check employeeServices)
        db.collection('businesses').doc(businessId).collection('employees').get(),
    ]);

    const hasEnoughPhotos = photosSnapshot.size >= 4;
    const hasActiveService = !activeServiceSnapshot.empty;

    // 5. At least 1 employee with 1+ doc in employeeServices
    let hasEmployeeWithService = false;
    for (const empDoc of employeesSnapshot.docs) {
        const empServicesSnapshot = await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .doc(empDoc.id)
            .collection('employeeServices')
            .limit(1)
            .get();

        if (!empServicesSnapshot.empty) {
            hasEmployeeWithService = true;
            break;
        }
    }

    const newStatus = (hasAvatar && hasCover && hasEnoughPhotos && hasActiveService && hasEmployeeWithService)
        ? 'verified'
        : 'pending';

    if (currentStatus !== newStatus) {
        await businessRef.update({ business_status: newStatus });
    }
}
