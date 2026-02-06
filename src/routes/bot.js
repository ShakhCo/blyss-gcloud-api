import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import crypto from 'crypto';
import { botCreateBookingSchema } from '../schemas/booking.js';
import { sendBookingNotification } from '../utils/telegram.js';
import { db } from '../db/db.js';

const router = Router();

// Day name mapping for working hours lookup
const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Convert seconds from midnight to HH:mm format
 */
function secondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * POST /bot/businesses/:businessId/bookings
 * Create a new booking from Telegram bot (HMAC signature auth, no JWT needed)
 * The bot server is a trusted caller with the shared HMAC secret.
 */
router.post('/businesses/:businessId/bookings', validate(botCreateBookingSchema), async (req, res) => {
    try {
        const { businessId } = req.params;
        const { telegram_id, date, start_time, services, customer_name, customer_phone, notes } = req.validated;

        // 1. Verify business exists and get working hours
        const businessDoc = await db.collection('businesses').doc(businessId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }
        const businessData = businessDoc.data();

        const dateObj = new Date(date);
        const dayIndex = dateObj.getDay();
        const dayName = dayNames[dayIndex];
        const businessHours = businessData.working_hours?.[dayName];

        if (!businessHours || !businessHours.is_open) {
            return res.status(400).json({
                error: 'Business is closed on this day',
                error_code: 'BUSINESS_CLOSED'
            });
        }

        // 2. Get or create user by telegram_id
        const userId = String(telegram_id);
        const userDoc = await db.collection('users').doc(userId).get();

        if (!userDoc.exists) {
            // Auto-create user from bot booking data
            const now = new Date();
            await db.collection('users').doc(userId).set({
                telegram_id,
                first_name: customer_name.split(' ')[0] || '',
                last_name: customer_name.split(' ').slice(1).join(' ') || '',
                phone_number: customer_phone,
                is_verified: false,
                created_at: now,
                updated_at: now
            });
        }

        // 3. Get all employees with their services
        const employeesSnapshot = await db.collection('businesses')
            .doc(businessId)
            .collection('employees')
            .where('is_accepted', '==', true)
            .get();

        const businessOwnerIds = new Set();
        employeesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.business_owner_id) businessOwnerIds.add(data.business_owner_id);
        });

        const businessOwnersMap = new Map();
        if (businessOwnerIds.size > 0) {
            await Promise.all(Array.from(businessOwnerIds).map(async (ownerId) => {
                const ownerDoc = await db.collection('business_owners').doc(ownerId).get();
                if (ownerDoc.exists) businessOwnersMap.set(ownerId, ownerDoc.data());
            }));
        }

        const employeeMap = new Map();
        for (const empDoc of employeesSnapshot.docs) {
            const empData = empDoc.data();

            let first_name = '';
            let last_name = '';
            if (empData.business_owner_id && businessOwnersMap.has(empData.business_owner_id)) {
                const ownerData = businessOwnersMap.get(empData.business_owner_id);
                first_name = ownerData.first_name || '';
                last_name = ownerData.last_name || '';
            }

            const empServicesSnapshot = await db.collection('businesses')
                .doc(businessId)
                .collection('employees')
                .doc(empDoc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            const empServices = new Map();
            for (const svcDoc of empServicesSnapshot.docs) {
                const svcData = svcDoc.data();
                empServices.set(svcData.service_id, {
                    price: svcData.price,
                    duration_minutes: svcData.duration_minutes
                });
            }

            employeeMap.set(empDoc.id, {
                id: empDoc.id,
                first_name,
                last_name,
                working_hours: empData.working_hours || null,
                allowed_booking_count_per_slot: empData.allowed_booking_count_per_slot || 1,
                services: empServices
            });
        }

        // 4. Get existing bookings for conflict checking
        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', businessId)
            .where('booking_date', '==', date)
            .where('status', 'in', ['pending', 'confirmed'])
            .get();

        const employeeBookings = new Map();
        for (const bookingDoc of bookingsSnapshot.docs) {
            for (const item of bookingDoc.data().items || []) {
                if (!item.employee_id || !item.start_time) continue;

                if (!employeeBookings.has(item.employee_id)) {
                    employeeBookings.set(item.employee_id, []);
                }

                const timePart = item.start_time.split('T')[1];
                const [hours, minutes] = timePart.split(':').map(Number);
                const startSec = hours * 3600 + minutes * 60;
                const endSec = startSec + (item.duration_minutes || 30) * 60;

                employeeBookings.get(item.employee_id).push({ start: startSec, end: endSec });
            }
        }

        // 5. Build booking items chain
        const bookingItems = [];
        let currentTime = start_time;
        let totalPrice = 0;
        let totalDuration = 0;

        for (let i = 0; i < services.length; i++) {
            const { service_id, employee_id } = services[i];

            // Get service details
            const serviceDoc = await db.collection('businesses')
                .doc(businessId)
                .collection('services')
                .doc(service_id)
                .get();

            if (!serviceDoc.exists) {
                return res.status(400).json({
                    error: `Service ${service_id} not found`,
                    error_code: 'SERVICE_NOT_FOUND'
                });
            }

            const serviceData = serviceDoc.data();
            if (!serviceData.is_active) {
                return res.status(400).json({
                    error: `Service ${service_id} is not active`,
                    error_code: 'SERVICE_NOT_ACTIVE'
                });
            }

            // Find employee (assigned or any available)
            let selectedEmployee = null;
            let selectedEmpService = null;

            if (employee_id) {
                const emp = employeeMap.get(employee_id);
                if (!emp) {
                    return res.status(400).json({
                        error: `Employee ${employee_id} not found`,
                        error_code: 'EMPLOYEE_NOT_FOUND'
                    });
                }

                if (!emp.services.has(service_id)) {
                    return res.status(400).json({
                        error: `Employee ${employee_id} does not offer service ${service_id}`,
                        error_code: 'EMPLOYEE_SERVICE_NOT_FOUND'
                    });
                }

                selectedEmployee = emp;
                selectedEmpService = emp.services.get(service_id);
            } else {
                // Find any available employee
                for (const [empId, emp] of employeeMap) {
                    if (!emp.services.has(service_id)) continue;

                    const empService = emp.services.get(service_id);
                    const slotEnd = currentTime + empService.duration_minutes * 60;

                    const empHours = emp.working_hours?.[dayName];
                    if (empHours && !empHours.is_open) continue;
                    if (empHours && (currentTime < empHours.start || slotEnd > empHours.end)) continue;
                    if (slotEnd > businessHours.end) continue;

                    const empBookings = employeeBookings.get(empId) || [];
                    let bookingCount = 0;
                    for (const booking of empBookings) {
                        if (!(slotEnd <= booking.start || currentTime >= booking.end)) {
                            bookingCount++;
                        }
                    }

                    if (bookingCount < emp.allowed_booking_count_per_slot) {
                        selectedEmployee = emp;
                        selectedEmpService = empService;
                        break;
                    }
                }

                if (!selectedEmployee) {
                    return res.status(409).json({
                        error: `No available employee for service ${service_id} at ${secondsToTime(currentTime)}`,
                        error_code: 'NO_EMPLOYEE_AVAILABLE'
                    });
                }
            }

            // Validate selected employee availability
            const slotEnd = currentTime + selectedEmpService.duration_minutes * 60;

            const empHours = selectedEmployee.working_hours?.[dayName];
            if (empHours && !empHours.is_open) {
                return res.status(409).json({
                    error: `Employee ${selectedEmployee.id} is not working on this day`,
                    error_code: 'EMPLOYEE_NOT_WORKING'
                });
            }
            if (empHours && (currentTime < empHours.start || slotEnd > empHours.end)) {
                return res.status(409).json({
                    error: `Employee ${selectedEmployee.id} is not available at ${secondsToTime(currentTime)}`,
                    error_code: 'EMPLOYEE_NOT_AVAILABLE'
                });
            }
            if (slotEnd > businessHours.end) {
                return res.status(409).json({
                    error: 'Booking exceeds business hours',
                    error_code: 'EXCEEDS_BUSINESS_HOURS'
                });
            }

            const empBookings = employeeBookings.get(selectedEmployee.id) || [];
            let bookingCount = 0;
            for (const booking of empBookings) {
                if (!(slotEnd <= booking.start || currentTime >= booking.end)) {
                    bookingCount++;
                }
            }

            if (bookingCount >= selectedEmployee.allowed_booking_count_per_slot) {
                return res.status(409).json({
                    error: `Employee ${selectedEmployee.id} is fully booked at ${secondsToTime(currentTime)}`,
                    error_code: 'SLOT_NOT_AVAILABLE'
                });
            }

            // Track this booking for subsequent service conflict checks
            if (!employeeBookings.has(selectedEmployee.id)) {
                employeeBookings.set(selectedEmployee.id, []);
            }
            employeeBookings.get(selectedEmployee.id).push({ start: currentTime, end: slotEnd });

            // Build booking item
            const startTimeStr = `${date}T${secondsToTime(currentTime)}`;
            const endTimeStr = `${date}T${secondsToTime(slotEnd)}`;
            const employeeName = [selectedEmployee.first_name, selectedEmployee.last_name].filter(Boolean).join(' ') || '';

            bookingItems.push({
                id: crypto.randomBytes(8).toString('hex'),
                service_id,
                service_name: serviceData.name || { uz: '', ru: '' },
                employee_id: selectedEmployee.id,
                employee_name: employeeName,
                start_time: startTimeStr,
                end_time: endTimeStr,
                price: selectedEmpService.price,
                duration_minutes: selectedEmpService.duration_minutes,
                status: 'pending',
                order_index: i
            });

            totalPrice += selectedEmpService.price;
            totalDuration += selectedEmpService.duration_minutes;
            currentTime = slotEnd;
        }

        // 6. Generate unique booking ID
        let bookingId;
        let exists = true;
        while (exists) {
            bookingId = crypto.randomBytes(16).toString('hex');
            const existingDoc = await db.collection('bookings').doc(bookingId).get();
            exists = existingDoc.exists;
        }

        // 7. Create booking
        const now = new Date();
        const bookingPayload = {
            business_id: businessId,
            business_name: businessData.business_name,
            user_id: userId,
            customer_name,
            customer_phone,
            customer_telegram_id: telegram_id,
            booking_date: date,
            status: 'pending',
            total_price: totalPrice,
            total_duration_minutes: totalDuration,
            notes: notes || '',
            items: bookingItems,
            created_at: now,
            updated_at: now
        };

        await db.collection('bookings').doc(bookingId).set(bookingPayload);

        // 8. Send Telegram notification to business
        if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
            try {
                const firstItem = bookingItems[0];
                const serviceName = typeof firstItem.service_name === 'object'
                    ? firstItem.service_name.uz || firstItem.service_name.ru
                    : firstItem.service_name;

                await sendBookingNotification(businessData.telegram_bot.chat_id, {
                    serviceName,
                    customerName: customer_name,
                    customerPhone: customer_phone || 'N/A',
                    date,
                    time: secondsToTime(start_time),
                    employeeName: firstItem.employee_name,
                    totalPrice
                });
            } catch (telegramError) {
                console.error('Failed to send Telegram notification:', telegramError);
            }
        }

        res.status(201).json({
            id: bookingId,
            ...bookingPayload,
            created_at: now.toISOString(),
            updated_at: now.toISOString()
        });
    } catch (error) {
        console.error('Error in /bot/businesses/:businessId/bookings:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

export default router;
