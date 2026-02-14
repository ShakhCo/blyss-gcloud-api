const MIN_HOUR_RANGE = 3600; // 1 hour in seconds

/**
 * Check if working hours have at least 1 open day with a minimum time range.
 * @param {object} workingHours - { monday: { is_open, start, end }, ... }
 * @returns {boolean}
 */
function hasValidWorkingHours(workingHours) {
    if (!workingHours) return false;

    return Object.values(workingHours).some(
        day => day.is_open && (day.end - day.start) >= MIN_HOUR_RANGE
    );
}

/**
 * Check all verification requirements and update business_status accordingly.
 *
 * Requirements for 'verified':
 *   1. avatar_url exists
 *   2. cover_url exists
 *   3. 4+ gallery photos
 *   4. 1+ active service
 *   5. Business has valid working hours (1+ day open with 1+ hour range)
 *   6. 1+ employee with 1+ assigned service AND valid working hours
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

    // 5. Business working hours valid
    const hasBusinessHours = hasValidWorkingHours(data.working_hours);

    // 3–4, 6: run subcollection queries in parallel
    const [photosSnapshot, activeServiceSnapshot, employeesSnapshot] = await Promise.all([
        // 3. 4+ gallery photos
        db.collection('businesses').doc(businessId).collection('photos').get(),
        // 4. 1+ active service
        db.collection('businesses').doc(businessId).collection('services')
            .where('is_active', '==', true).limit(1).get(),
        // 6. employees (need to check employeeServices + working hours)
        db.collection('businesses').doc(businessId).collection('employees').get(),
    ]);

    const hasEnoughPhotos = photosSnapshot.size >= 4;
    const hasActiveService = !activeServiceSnapshot.empty;

    // 6. At least 1 employee with 1+ employeeService AND valid working hours
    let hasQualifiedEmployee = false;
    for (const empDoc of employeesSnapshot.docs) {
        const empData = empDoc.data();

        // Flexible employees are always considered to have valid hours
        const empHasValidHours = empData.availability_type === 'flexible' || hasValidWorkingHours(empData.working_hours);
        if (!empHasValidHours) continue;

        const empServicesSnapshot = await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .doc(empDoc.id)
            .collection('employeeServices')
            .limit(1)
            .get();

        if (!empServicesSnapshot.empty) {
            hasQualifiedEmployee = true;
            break;
        }
    }

    const allMet = hasAvatar && hasCover && hasEnoughPhotos && hasActiveService && hasBusinessHours && hasQualifiedEmployee;
    const newStatus = allMet ? 'verified' : 'pending';

    console.log(`[BusinessStatus] ${businessId}: avatar=${hasAvatar}, cover=${hasCover}, photos=${photosSnapshot.size}/4, activeService=${hasActiveService}, bizHours=${hasBusinessHours}, qualifiedEmp=${hasQualifiedEmployee} → ${newStatus} (was ${currentStatus})`);

    if (currentStatus !== newStatus) {
        await businessRef.update({ business_status: newStatus });
    }
}
