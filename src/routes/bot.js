import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import crypto from 'crypto';
import { botCreateBookingSchema } from '../schemas/booking.js';
import { sendBookingNotification } from '../utils/telegram.js';
import { sendSms } from '../utils/eskiz.js';
import { db } from '../db/db.js';

const router = Router();

// Rate limiter for booking creation (10 requests per 15 minutes per IP)
const bookingCreateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many booking requests, please try again later', error_code: 'RATE_LIMITED' },
    validate: { trustProxy: false }
});

/**
 * GET /bot/users/:telegramId
 * Look up a user by Telegram ID (HMAC signature auth, no JWT needed)
 */
router.get('/users/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const userDoc = await db.collection('users').doc(String(telegramId)).get();

        if (!userDoc.exists) {
            return res.status(404).json({
                error: 'User not found',
                error_code: 'USER_NOT_FOUND'
            });
        }

        const data = userDoc.data();
        res.json({
            id: userDoc.id,
            phone_number: data.phone_number || '',
            first_name: data.first_name || '',
            last_name: data.last_name || '',
            is_verified: data.is_verified || false
        });
    } catch (error) {
        console.error('Error in /bot/users/:telegramId:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * PUT /bot/users/:telegramId
 * Register or update a user from the Telegram bot.
 * Creates user doc if not exists; updates first_name/last_name only if exists (never overwrites phone).
 */
router.put('/users/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const { first_name, last_name } = req.body || {};
        const userId = String(telegramId);
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        const now = new Date();

        if (!userDoc.exists) {
            // Create new user
            const userData = {
                telegram_id: Number(telegramId),
                first_name: first_name || '',
                last_name: last_name || '',
                phone_number: '',
                is_verified: false,
                created_at: now,
                updated_at: now
            };
            await userRef.set(userData);
            return res.status(201).json({
                id: userId,
                phone_number: '',
                first_name: userData.first_name,
                last_name: userData.last_name,
                is_verified: false
            });
        }

        // Update existing user (preserve phone)
        await userRef.update({
            first_name: first_name || userDoc.data().first_name || '',
            last_name: last_name || userDoc.data().last_name || '',
            updated_at: now
        });

        const updated = await userRef.get();
        const data = updated.data();
        res.json({
            id: userId,
            phone_number: data.phone_number || '',
            first_name: data.first_name || '',
            last_name: data.last_name || '',
            is_verified: data.is_verified || false
        });
    } catch (error) {
        console.error('Error in PUT /bot/users/:telegramId:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * POST /bot/otp/send
 * Send OTP SMS for phone verification from bot.
 */
router.post('/otp/send', async (req, res) => {
    try {
        const { telegram_id, phone_number } = req.body || {};

        if (!telegram_id || !phone_number) {
            return res.status(400).json({
                error: 'telegram_id and phone_number are required',
                error_code: 'MISSING_FIELDS'
            });
        }

        if (!/^998\d{9}$/.test(phone_number)) {
            return res.status(400).json({
                error: 'Invalid phone number format. Must be 998XXXXXXXXX (12 digits)',
                error_code: 'INVALID_PHONE'
            });
        }

        // Rate limit: 60s between requests per telegram_id
        try {
            const recentOtps = await db.collection('bot_otps')
                .where('telegram_id', '==', Number(telegram_id))
                .orderBy('created_at', 'desc')
                .limit(1)
                .get();

            if (!recentOtps.empty) {
                const lastOtp = recentOtps.docs[0].data();
                const lastCreated = lastOtp.created_at?.toDate ? lastOtp.created_at.toDate() : new Date(lastOtp.created_at);
                const secondsSince = (Date.now() - lastCreated.getTime()) / 1000;
                if (secondsSince < 60) {
                    return res.status(429).json({
                        error: `Please wait ${Math.ceil(60 - secondsSince)} seconds before requesting another code`,
                        error_code: 'RATE_LIMITED'
                    });
                }
            }
        } catch (indexError) {
            // Composite index may not exist yet — skip rate limiting, log for index creation
            console.warn('bot_otps rate limit query failed (create composite index: telegram_id ASC, created_at DESC):', indexError.message);
        }

        // Generate 5-digit code
        const otpCode = String(crypto.randomInt(10000, 100000));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

        const otpRef = db.collection('bot_otps').doc();
        await otpRef.set({
            telegram_id: Number(telegram_id),
            phone_number,
            otp_code: otpCode,
            created_at: now,
            expires_at: expiresAt,
            used: false
        });

        // Send SMS
        const smsMessage = `${otpCode} BLYSS ilovasiga kirish kodi. Код входа в приложение BLYSS.`;
        const smsResult = await sendSms(phone_number, smsMessage);

        res.json({
            otp_id: otpRef.id,
            message: 'OTP sent',
            sms_sent: smsResult?.success || false
        });
    } catch (error) {
        console.error('Error in POST /bot/otp/send:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * POST /bot/otp/verify
 * Verify OTP code and save phone to user doc.
 */
router.post('/otp/verify', async (req, res) => {
    try {
        const { telegram_id, otp_id, otp_code } = req.body || {};

        if (!telegram_id || !otp_id || !otp_code) {
            return res.status(400).json({
                error: 'telegram_id, otp_id, and otp_code are required',
                error_code: 'MISSING_FIELDS'
            });
        }

        const otpDoc = await db.collection('bot_otps').doc(otp_id).get();
        if (!otpDoc.exists) {
            return res.status(404).json({
                error: 'OTP not found',
                error_code: 'OTP_NOT_FOUND'
            });
        }

        const otpData = otpDoc.data();

        if (otpData.telegram_id !== Number(telegram_id)) {
            return res.status(403).json({
                error: 'OTP does not belong to this user',
                error_code: 'FORBIDDEN'
            });
        }

        if (otpData.used) {
            return res.status(400).json({
                error: 'OTP already used',
                error_code: 'OTP_USED'
            });
        }

        const expiresAt = otpData.expires_at?.toDate ? otpData.expires_at.toDate() : new Date(otpData.expires_at);
        if (Date.now() > expiresAt.getTime()) {
            return res.status(400).json({
                error: 'OTP expired',
                error_code: 'OTP_EXPIRED'
            });
        }

        if (otpData.otp_code !== String(otp_code)) {
            return res.status(400).json({
                error: 'Invalid OTP code',
                error_code: 'INVALID_OTP'
            });
        }

        // Mark OTP as used
        await db.collection('bot_otps').doc(otp_id).update({ used: true });

        // Save phone to user doc
        const userId = String(telegram_id);
        const userRef = db.collection('users').doc(userId);
        const now = new Date();

        await userRef.set({
            phone_number: otpData.phone_number,
            is_verified: true,
            updated_at: now
        }, { merge: true });

        res.json({
            success: true,
            phone_number: otpData.phone_number
        });
    } catch (error) {
        console.error('Error in POST /bot/otp/verify:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

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
router.post('/businesses/:businessId/bookings', bookingCreateLimiter, validate(botCreateBookingSchema), async (req, res) => {
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

        // 6. Check for user booking conflicts across all businesses
        const bookingEndTime = currentTime;
        const userBookingsSnapshot = await db.collection('bookings')
            .where('user_id', '==', userId)
            .where('booking_date', '==', date)
            .where('status', 'in', ['pending', 'confirmed'])
            .get();

        for (const existingBookingDoc of userBookingsSnapshot.docs) {
            const existingBooking = existingBookingDoc.data();
            const existingItems = existingBooking.items || [];
            if (existingItems.length === 0) continue;

            const existFirstItem = existingItems[0];
            const existLastItem = existingItems[existingItems.length - 1];

            const existStartTime = existFirstItem.start_time.split('T')[1];
            const [esH, esM] = existStartTime.split(':').map(Number);
            const existStart = esH * 3600 + esM * 60;

            const existEndTime = existLastItem.end_time.split('T')[1];
            const [eeH, eeM] = existEndTime.split(':').map(Number);
            const existEnd = eeH * 3600 + eeM * 60;

            if (!(bookingEndTime <= existStart || start_time >= existEnd)) {
                return res.status(409).json({
                    error: 'You already have a booking during this time',
                    error_code: 'USER_TIME_CONFLICT',
                    conflicting_booking: {
                        id: existingBookingDoc.id,
                        business_name: existingBooking.business_name,
                        start_time: existFirstItem.start_time,
                        end_time: existLastItem.end_time
                    }
                });
            }
        }

        // 7. Generate unique booking ID
        let bookingId;
        let exists = true;
        while (exists) {
            bookingId = crypto.randomBytes(16).toString('hex');
            const existingDoc = await db.collection('bookings').doc(bookingId).get();
            exists = existingDoc.exists;
        }

        // 9. Create booking
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

        // 10. Send Telegram notification to business
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

/**
 * GET /bot/businesses/:businessId/bookings/:telegramId
 * Get bookings for a user by telegram ID.
 */
router.get('/businesses/:businessId/bookings/:telegramId', async (req, res) => {
    try {
        const { businessId, telegramId } = req.params;

        if (!businessId || !telegramId) {
            return res.status(400).json({
                error: 'businessId and telegramId are required',
                error_code: 'MISSING_FIELDS'
            });
        }

        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', businessId)
            .where('customer_telegram_id', '==', Number(telegramId))
            .get();

        const bookings = bookingsSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                booking_date: data.booking_date,
                status: data.status,
                total_price: data.total_price,
                total_duration_minutes: data.total_duration_minutes,
                items: (data.items || []).map(item => ({
                    service_name: item.service_name,
                    employee_name: item.employee_name,
                    start_time: item.start_time,
                    duration_minutes: item.duration_minutes,
                    price: item.price
                })),
                created_at: data.created_at?.toDate?.().toISOString() || data.created_at
            };
        });

        bookings.sort((a, b) => (b.booking_date || '').localeCompare(a.booking_date || ''));

        res.json({ bookings });
    } catch (error) {
        console.error('Error in GET /bot/businesses/:businessId/bookings/:telegramId:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * PATCH /bot/bookings/:bookingId/cancel
 * Cancel a booking. Sets status to 'cancelled'.
 * Rejects if booking starts within 1 hour (Uzbekistan GMT+5).
 */
router.patch('/bookings/:bookingId/cancel', async (req, res) => {
    try {
        const { bookingId } = req.params;

        if (!bookingId) {
            return res.status(400).json({
                error: 'bookingId is required',
                error_code: 'MISSING_FIELDS'
            });
        }

        const bookingDoc = await db.collection('bookings').doc(bookingId).get();
        if (!bookingDoc.exists) {
            return res.status(404).json({
                error: 'Booking not found',
                error_code: 'NOT_FOUND'
            });
        }

        const booking = bookingDoc.data();

        if (booking.status === 'cancelled') {
            return res.status(400).json({
                error: 'Booking is already cancelled',
                error_code: 'ALREADY_CANCELLED'
            });
        }

        if (!['pending', 'confirmed'].includes(booking.status)) {
            return res.status(400).json({
                error: `Cannot cancel a booking with status "${booking.status}"`,
                error_code: 'INVALID_STATUS'
            });
        }

        // Check 1-hour restriction (Uzbekistan GMT+5)
        const firstItem = (booking.items || [])[0];
        if (firstItem && firstItem.start_time && booking.booking_date) {
            const bookingDateTimeStr = firstItem.start_time; // "YYYY-MM-DDTHH:mm"
            const bookingDateTimeUtc = new Date(bookingDateTimeStr + ':00.000Z');
            // Convert from UZB time to UTC by subtracting 5 hours
            const bookingUtc = new Date(bookingDateTimeUtc.getTime() - 5 * 60 * 60 * 1000);
            const nowUtc = new Date();
            const diffMs = bookingUtc.getTime() - nowUtc.getTime();

            if (diffMs < 60 * 60 * 1000) {
                return res.status(400).json({
                    error: 'Cannot cancel a booking less than 1 hour before the appointment',
                    error_code: 'TOO_LATE_TO_CANCEL'
                });
            }
        }

        await db.collection('bookings').doc(bookingId).update({
            status: 'cancelled',
            updated_at: new Date()
        });

        res.json({
            success: true,
            booking_id: bookingId,
            status: 'cancelled'
        });
    } catch (error) {
        console.error('Error in PATCH /bot/bookings/:bookingId/cancel:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

export default router;
