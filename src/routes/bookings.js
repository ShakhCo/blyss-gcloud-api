import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { db } from '../db/db.js';
import { validate } from '../middleware/validate.js';
import { authenticate, verifySignature } from '../middleware/authenticate.js';
import {
    createBookingSchema,
    availableSlotsQuerySchema,
    userBookingsQuerySchema,
    businessBookingsQuerySchema,
    updateBookingStatusSchema,
    serviceEmployeesQuerySchema
} from '../schemas/booking.js';
import {
    sendBookingNotification,
    sendBookingCancellationNotification,
    sendBookingStatusUpdateNotification
} from '../utils/telegram.js';
import { checkUserBookingLimit } from '../utils/bookingLimits.js';

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

// Day name mapping for working hours lookup
const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Convert seconds from midnight to HH:mm format
 * @param {number} seconds - Seconds from midnight
 * @returns {string} Time in HH:mm format
 */
function secondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Convert HH:mm to minutes from midnight
 * @param {string} time - Time in HH:mm format
 * @returns {number} Minutes from midnight
 */
function timeToMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Calculate end time from start time and duration
 * @param {string} startTime - Start time in YYYY-MM-DDTHH:mm format
 * @param {number} durationMinutes - Duration in minutes
 * @returns {string} End time in YYYY-MM-DDTHH:mm format
 */
function calculateEndTime(startTime, durationMinutes) {
    const [datePart, timePart] = startTime.split('T');
    const [hours, minutes] = timePart.split(':').map(Number);
    const totalMinutes = hours * 60 + minutes + durationMinutes;
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMinutes = totalMinutes % 60;
    return `${datePart}T${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;
}

/**
 * Check if employee is currently open based on availability type and working hours
 * @param {string} availabilityType - 'flexible' or 'fixed'
 * @param {object} workingHours - Working hours object
 * @returns {boolean}
 */
function isEmployeeOpenNow(availabilityType, workingHours) {
    if (availabilityType === 'flexible' || !workingHours) {
        return true;
    }

    const now = new Date();
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const uzbekNow = new Date(utcNow + (5 * 3600000)); // GMT+5

    const dayIndex = uzbekNow.getDay();
    const dayName = dayNames[dayIndex];
    const dayHours = workingHours[dayName];

    if (!dayHours || !dayHours.is_open) {
        return false;
    }

    const currentSeconds = uzbekNow.getHours() * 3600 + uzbekNow.getMinutes() * 60 + uzbekNow.getSeconds();
    return currentSeconds >= dayHours.start && currentSeconds <= dayHours.end;
}

// ============================================
// PUBLIC ENDPOINTS
// ============================================

/**
 * GET /public/businesses/:businessId/services/:serviceId/employees
 * Get employees who offer a specific service
 */
router.get(
    '/public/businesses/:businessId/services/:serviceId/employees',
    verifySignature,
    validate(serviceEmployeesQuerySchema, 'query'),
    async (req, res) => {
        try {
            const { businessId, serviceId } = req.params;
            const { date } = req.validated;

            // Fetch business
            const businessDoc = await db.collection('businesses').doc(businessId).get();
            if (!businessDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }

            // Fetch service
            const serviceDoc = await db.collection('businesses')
                .doc(businessId)
                .collection('services')
                .doc(serviceId)
                .get();

            if (!serviceDoc.exists) {
                return res.status(404).json({
                    error: 'Service not found',
                    error_code: 'SERVICE_NOT_FOUND'
                });
            }

            const serviceData = serviceDoc.data();

            // Fetch accepted employees
            const employeesSnapshot = await db.collection('businesses')
                .doc(businessId)
                .collection('employees')
                .where('is_accepted', '==', true)
                .get();

            // For each employee, check if they offer this service
            const employees = [];
            const businessOwnersMap = new Map();

            // Collect business owner IDs
            const businessOwnerIds = new Set();
            employeesSnapshot.docs.forEach(doc => {
                const data = doc.data();
                if (data.business_owner_id) {
                    businessOwnerIds.add(data.business_owner_id);
                }
            });

            // Fetch business owners data
            if (businessOwnerIds.size > 0) {
                const ownerPromises = Array.from(businessOwnerIds).map(async (ownerId) => {
                    const ownerDoc = await db.collection('business_owners').doc(ownerId).get();
                    if (ownerDoc.exists) {
                        businessOwnersMap.set(ownerId, ownerDoc.data());
                    }
                });
                await Promise.all(ownerPromises);
            }

            // Check each employee's services
            for (const employeeDoc of employeesSnapshot.docs) {
                const employeeData = employeeDoc.data();

                // Check if employee has this service
                const employeeServiceSnapshot = await db.collection('businesses')
                    .doc(businessId)
                    .collection('employees')
                    .doc(employeeDoc.id)
                    .collection('employeeServices')
                    .where('service_id', '==', serviceId)
                    .where('is_active', '==', true)
                    .limit(1)
                    .get();

                if (employeeServiceSnapshot.empty) {
                    continue;
                }

                const employeeServiceData = employeeServiceSnapshot.docs[0].data();

                // Get name from business_owners
                let firstName = null;
                let lastName = null;
                if (employeeData.business_owner_id && businessOwnersMap.has(employeeData.business_owner_id)) {
                    const ownerData = businessOwnersMap.get(employeeData.business_owner_id);
                    firstName = ownerData.first_name || null;
                    lastName = ownerData.last_name || null;
                }

                // If date is provided, check if employee is available that day
                if (date) {
                    const dateObj = new Date(date);
                    const dayIndex = dateObj.getDay();
                    const dayName = dayNames[dayIndex];
                    const dayHours = employeeData.working_hours?.[dayName];

                    if (dayHours && !dayHours.is_open) {
                        continue; // Employee not working that day
                    }
                }

                employees.push({
                    id: employeeDoc.id,
                    first_name: firstName,
                    last_name: lastName,
                    position: employeeData.position || '',
                    availability_type: employeeData.availability_type || 'flexible',
                    working_hours: employeeData.working_hours || null,
                    is_open_now: isEmployeeOpenNow(employeeData.availability_type, employeeData.working_hours),
                    service_price: employeeServiceData.price,
                    service_duration_minutes: employeeServiceData.duration_minutes
                });
            }

            res.json({
                service: {
                    id: serviceDoc.id,
                    name: serviceData.name || { uz: '', ru: '' },
                    price: serviceData.price,
                    duration_minutes: serviceData.duration_minutes
                },
                employees
            });
        } catch (error) {
            console.error('Error fetching service employees:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

/**
 * GET /public/businesses/:businessId/available-slots
 * Get available time slots for booking
 */
router.get(
    '/public/businesses/:businessId/available-slots',
    verifySignature,
    validate(availableSlotsQuerySchema, 'query'),
    async (req, res) => {
        try {
            const { businessId } = req.params;
            const { date, service_id, employee_id, duration_minutes } = req.validated;

            // Fetch business
            const businessDoc = await db.collection('businesses').doc(businessId).get();
            if (!businessDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }

            const businessData = businessDoc.data();

            // Check if business is open on this day
            const dateObj = new Date(date);
            const dayIndex = dateObj.getDay();
            const dayName = dayNames[dayIndex];
            const businessHours = businessData.working_hours?.[dayName];

            if (!businessHours || !businessHours.is_open) {
                return res.json({
                    date,
                    business_open: false,
                    service_duration_minutes: duration_minutes || 30,
                    slots: [],
                    message: 'Business is closed on this day'
                });
            }

            // Fetch service to get default duration
            const serviceDoc = await db.collection('businesses')
                .doc(businessId)
                .collection('services')
                .doc(service_id)
                .get();

            if (!serviceDoc.exists) {
                return res.status(404).json({
                    error: 'Service not found',
                    error_code: 'SERVICE_NOT_FOUND'
                });
            }

            const serviceData = serviceDoc.data();
            const serviceDuration = duration_minutes || serviceData.duration_minutes || 30;

            // Get employees to check
            let employeesToCheck = [];

            if (employee_id) {
                // Single employee specified
                const employeeDoc = await db.collection('businesses')
                    .doc(businessId)
                    .collection('employees')
                    .doc(employee_id)
                    .get();

                if (!employeeDoc.exists) {
                    return res.status(404).json({
                        error: 'Employee not found',
                        error_code: 'EMPLOYEE_NOT_FOUND'
                    });
                }

                employeesToCheck = [{ id: employeeDoc.id, ...employeeDoc.data() }];
            } else {
                // Get all employees who offer this service
                const employeesSnapshot = await db.collection('businesses')
                    .doc(businessId)
                    .collection('employees')
                    .where('is_accepted', '==', true)
                    .get();

                for (const empDoc of employeesSnapshot.docs) {
                    const empServiceSnapshot = await db.collection('businesses')
                        .doc(businessId)
                        .collection('employees')
                        .doc(empDoc.id)
                        .collection('employeeServices')
                        .where('service_id', '==', service_id)
                        .where('is_active', '==', true)
                        .limit(1)
                        .get();

                    if (!empServiceSnapshot.empty) {
                        employeesToCheck.push({ id: empDoc.id, ...empDoc.data() });
                    }
                }
            }

            if (employeesToCheck.length === 0) {
                return res.json({
                    date,
                    business_open: true,
                    service_duration_minutes: serviceDuration,
                    slots: [],
                    message: 'No employees available for this service'
                });
            }

            // Fetch all bookings for these employees on this date
            const bookingsSnapshot = await db.collection('bookings')
                .where('business_id', '==', businessId)
                .where('booking_date', '==', date)
                .where('status', 'in', ['pending', 'confirmed'])
                .get();

            // Build map of booked slots per employee
            // Key: employee_id, Value: Map of slot_time -> booking_count
            const employeeBookings = new Map();

            for (const bookingDoc of bookingsSnapshot.docs) {
                const bookingData = bookingDoc.data();
                const items = bookingData.items || [];

                for (const item of items) {
                    if (!item.employee_id || !item.start_time) continue;

                    if (!employeeBookings.has(item.employee_id)) {
                        employeeBookings.set(item.employee_id, new Map());
                    }

                    // Extract time from start_time (YYYY-MM-DDTHH:mm)
                    const slotTime = item.start_time.split('T')[1];
                    const empSlots = employeeBookings.get(item.employee_id);

                    // Mark all slots covered by this booking as occupied
                    const startMinutes = timeToMinutes(slotTime);
                    const endMinutes = startMinutes + (item.duration_minutes || 30);

                    for (let min = startMinutes; min < endMinutes; min += 30) {
                        const slotKey = `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`;
                        empSlots.set(slotKey, (empSlots.get(slotKey) || 0) + 1);
                    }
                }
            }

            // Generate time slots (30-minute intervals)
            let businessStartMinutes = Math.floor(businessHours.start / 60);
            const businessEndMinutes = Math.floor(businessHours.end / 60);

            // For today: skip past time slots (Uzbekistan GMT+5, 15-min buffer)
            const nowUtc = new Date();
            const uzbekNow = new Date(nowUtc.getTime() + 5 * 60 * 60 * 1000);
            const todayUzb = uzbekNow.toISOString().split('T')[0];

            if (date === todayUzb) {
                const currentMinutes = uzbekNow.getUTCHours() * 60 + uzbekNow.getUTCMinutes() + 15;
                // Round up to next 30-min slot
                const roundedMinutes = Math.ceil(currentMinutes / 30) * 30;
                businessStartMinutes = Math.max(businessStartMinutes, roundedMinutes);
            }

            const slots = [];
            const slotInterval = 30;

            for (let slotMinutes = businessStartMinutes; slotMinutes <= businessEndMinutes - serviceDuration; slotMinutes += slotInterval) {
                const slotTime = `${Math.floor(slotMinutes / 60).toString().padStart(2, '0')}:${(slotMinutes % 60).toString().padStart(2, '0')}`;
                const availableEmployees = [];

                for (const employee of employeesToCheck) {
                    // Check employee working hours
                    const empHours = employee.working_hours?.[dayName];
                    if (empHours && !empHours.is_open) {
                        continue;
                    }

                    if (empHours) {
                        const empStartMinutes = Math.floor(empHours.start / 60);
                        const empEndMinutes = Math.floor(empHours.end / 60);

                        if (slotMinutes < empStartMinutes || slotMinutes + serviceDuration > empEndMinutes) {
                            continue;
                        }
                    }

                    // Check slot capacity
                    const allowedCount = employee.allowed_booking_count_per_slot || 1;
                    const empSlots = employeeBookings.get(employee.id);

                    // Check all slots that this booking would occupy
                    let isAvailable = true;
                    for (let min = slotMinutes; min < slotMinutes + serviceDuration; min += 30) {
                        const checkSlot = `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`;
                        const currentCount = empSlots?.get(checkSlot) || 0;
                        if (currentCount >= allowedCount) {
                            isAvailable = false;
                            break;
                        }
                    }

                    if (isAvailable) {
                        availableEmployees.push(employee.id);
                    }
                }

                if (availableEmployees.length > 0) {
                    slots.push({
                        time: slotTime,
                        available_employees: availableEmployees
                    });
                }
            }

            res.json({
                date,
                business_open: true,
                service_duration_minutes: serviceDuration,
                slots
            });
        } catch (error) {
            console.error('Error fetching available slots:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

/**
 * POST /public/businesses/:businessId/bookings
 * Create a new booking
 */
router.post(
    '/public/businesses/:businessId/bookings',
    bookingCreateLimiter,
    verifySignature,
    authenticate,
    validate(createBookingSchema),
    async (req, res) => {
        try {
            const { businessId } = req.params;
            const {
                customer_name,
                customer_phone,
                customer_telegram_id,
                booking_date,
                notes,
                items
            } = req.validated;

            // Check per-user active booking limit
            const bookingLimit = await checkUserBookingLimit(req.user.id);
            if (bookingLimit) {
                return res.status(429).json({
                    error: `You have reached the maximum of ${bookingLimit.limit} active bookings`,
                    error_code: 'BOOKING_LIMIT_REACHED',
                    active_bookings: bookingLimit.count,
                    limit: bookingLimit.limit
                });
            }

            // Verify business exists
            const businessDoc = await db.collection('businesses').doc(businessId).get();
            if (!businessDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }

            const businessData = businessDoc.data();

            // Verify slots are still available
            for (const item of items) {
                // Get employee
                const employeeDoc = await db.collection('businesses')
                    .doc(businessId)
                    .collection('employees')
                    .doc(item.employee_id)
                    .get();

                if (!employeeDoc.exists) {
                    return res.status(400).json({
                        error: `Employee ${item.employee_id} not found`,
                        error_code: 'EMPLOYEE_NOT_FOUND'
                    });
                }

                const employeeData = employeeDoc.data();
                const allowedCount = employeeData.allowed_booking_count_per_slot || 1;

                // Check existing bookings for this slot
                const slotTime = item.start_time.split('T')[1];
                const existingBookings = await db.collection('bookings')
                    .where('business_id', '==', businessId)
                    .where('booking_date', '==', booking_date)
                    .where('status', 'in', ['pending', 'confirmed'])
                    .get();

                let slotCount = 0;
                for (const bookingDoc of existingBookings.docs) {
                    const bookingData = bookingDoc.data();
                    for (const bookingItem of bookingData.items || []) {
                        if (bookingItem.employee_id === item.employee_id) {
                            const bookingSlotTime = bookingItem.start_time.split('T')[1];
                            // Check if slots overlap
                            const itemStart = timeToMinutes(slotTime);
                            const itemEnd = itemStart + item.duration_minutes;
                            const bookingStart = timeToMinutes(bookingSlotTime);
                            const bookingEnd = bookingStart + (bookingItem.duration_minutes || 30);

                            if (!(itemEnd <= bookingStart || itemStart >= bookingEnd)) {
                                slotCount++;
                            }
                        }
                    }
                }

                if (slotCount >= allowedCount) {
                    return res.status(409).json({
                        error: `Slot ${item.start_time} is no longer available for this employee`,
                        error_code: 'SLOT_NOT_AVAILABLE'
                    });
                }
            }

            // Check for user time conflicts across all businesses
            const firstItemTime = items[0].start_time.split('T')[1];
            const [firstH, firstM] = firstItemTime.split(':').map(Number);
            const newBookingStart = firstH * 3600 + firstM * 60;

            // Calculate end from last item
            const lastItem = items[items.length - 1];
            const lastItemTime = lastItem.start_time.split('T')[1];
            const [lastH, lastM] = lastItemTime.split(':').map(Number);
            const newBookingEnd = lastH * 3600 + lastM * 60 + lastItem.duration_minutes * 60;

            const userBookingsSnapshot = await db.collection('bookings')
                .where('user_id', '==', req.user.id)
                .where('booking_date', '==', booking_date)
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

                if (!(newBookingEnd <= existStart || newBookingStart >= existEnd)) {
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

            // Generate booking ID
            let bookingId;
            let exists = true;
            while (exists) {
                bookingId = crypto.randomBytes(16).toString('hex');
                const existingDoc = await db.collection('bookings').doc(bookingId).get();
                exists = existingDoc.exists;
            }

            // Calculate totals
            const totalPrice = items.reduce((sum, item) => sum + item.price, 0);
            const totalDuration = items.reduce((sum, item) => sum + item.duration_minutes, 0);

            // Prepare booking items with end times
            const bookingItems = items.map((item, index) => ({
                id: crypto.randomBytes(8).toString('hex'),
                service_id: item.service_id,
                service_name: item.service_name,
                employee_id: item.employee_id,
                employee_name: item.employee_name,
                start_time: item.start_time,
                end_time: calculateEndTime(item.start_time, item.duration_minutes),
                price: item.price,
                duration_minutes: item.duration_minutes,
                status: 'confirmed',
                order_index: index
            }));

            const now = new Date();
            const bookingData = {
                business_id: businessId,
                business_name: businessData.business_name,
                user_id: req.user.id,
                customer_name,
                customer_phone,
                customer_telegram_id: customer_telegram_id || null,
                booking_date,
                status: 'confirmed',
                total_price: totalPrice,
                total_duration_minutes: totalDuration,
                notes: notes || '',
                items: bookingItems,
                created_at: now,
                updated_at: now
            };

            await db.collection('bookings').doc(bookingId).set(bookingData);

            // Send Telegram notification to business if enabled
            if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
                try {
                    const firstItem = items[0];
                    const serviceName = typeof firstItem.service_name === 'object'
                        ? firstItem.service_name.uz || firstItem.service_name.ru
                        : firstItem.service_name;

                    await sendBookingNotification(businessData.telegram_bot.chat_id, {
                        serviceName,
                        customerName: customer_name,
                        customerPhone: customer_phone,
                        date: booking_date,
                        time: firstItem.start_time.split('T')[1],
                        employeeName: firstItem.employee_name,
                        totalPrice
                    });
                } catch (telegramError) {
                    console.error('Failed to send Telegram notification:', telegramError);
                    // Don't fail the booking if notification fails
                }
            }

            res.status(201).json({
                id: bookingId,
                ...bookingData,
                created_at: now.toISOString(),
                updated_at: now.toISOString()
            });
        } catch (error) {
            console.error('Error creating booking:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

// ============================================
// USER ENDPOINTS (require authentication)
// ============================================

/**
 * GET /users/me/bookings
 * Get authenticated user's booking history
 */
router.get(
    '/users/me/bookings',
    authenticate,
    validate(userBookingsQuerySchema, 'query'),
    async (req, res) => {
        try {
            const { page, page_size, status, date_from, date_to } = req.validated;

            // Build query
            let query = db.collection('bookings')
                .where('user_id', '==', req.user.id)
                .orderBy('created_at', 'desc');

            // Note: Firestore doesn't support multiple inequality filters on different fields
            // So we filter status in-memory if needed
            const bookingsSnapshot = await query.get();

            let bookings = bookingsSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    created_at: data.created_at?.toDate?.().toISOString() || data.created_at,
                    updated_at: data.updated_at?.toDate?.().toISOString() || data.updated_at
                };
            });

            // Apply filters in memory
            if (status) {
                bookings = bookings.filter(b => b.status === status);
            }

            if (date_from) {
                bookings = bookings.filter(b => b.booking_date >= date_from);
            }

            if (date_to) {
                bookings = bookings.filter(b => b.booking_date <= date_to);
            }

            // Calculate pagination
            const total = bookings.length;
            const totalPages = Math.ceil(total / page_size);
            const startIndex = (page - 1) * page_size;
            const paginatedBookings = bookings.slice(startIndex, startIndex + page_size);

            res.json({
                data: paginatedBookings,
                pagination: {
                    page,
                    page_size,
                    total,
                    total_pages: totalPages,
                    has_next: page < totalPages,
                    has_prev: page > 1
                }
            });
        } catch (error) {
            console.error('Error fetching user bookings:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

/**
 * PATCH /users/me/bookings/:bookingId/cancel
 * Cancel a user's booking
 */
router.patch(
    '/users/me/bookings/:bookingId/cancel',
    authenticate,
    async (req, res) => {
        try {
            const { bookingId } = req.params;

            // Fetch booking
            const bookingDoc = await db.collection('bookings').doc(bookingId).get();

            if (!bookingDoc.exists) {
                return res.status(404).json({
                    error: 'Booking not found',
                    error_code: 'BOOKING_NOT_FOUND'
                });
            }

            const bookingData = bookingDoc.data();

            // Verify ownership
            if (bookingData.user_id !== req.user.id) {
                return res.status(403).json({
                    error: 'Access denied',
                    error_code: 'FORBIDDEN'
                });
            }

            // Check if booking can be cancelled
            if (bookingData.status === 'cancelled') {
                return res.status(400).json({
                    error: 'Booking is already cancelled',
                    error_code: 'ALREADY_CANCELLED'
                });
            }

            if (bookingData.status === 'completed') {
                return res.status(400).json({
                    error: 'Cannot cancel a completed booking',
                    error_code: 'CANNOT_CANCEL_COMPLETED'
                });
            }

            // Update booking status
            const now = new Date();
            await bookingDoc.ref.update({
                status: 'cancelled',
                updated_at: now
            });

            // Send Telegram notification to business
            const businessDoc = await db.collection('businesses').doc(bookingData.business_id).get();
            if (businessDoc.exists) {
                const businessData = businessDoc.data();
                if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
                    try {
                        const firstItem = bookingData.items?.[0];
                        const serviceName = typeof firstItem?.service_name === 'object'
                            ? firstItem.service_name.uz || firstItem.service_name.ru
                            : firstItem?.service_name || 'Service';

                        await sendBookingCancellationNotification(businessData.telegram_bot.chat_id, {
                            serviceName,
                            customerName: bookingData.customer_name,
                            date: bookingData.booking_date,
                            time: firstItem?.start_time?.split('T')[1] || ''
                        });
                    } catch (telegramError) {
                        console.error('Failed to send cancellation notification:', telegramError);
                    }
                }
            }

            res.json({
                id: bookingId,
                ...bookingData,
                status: 'cancelled',
                updated_at: now.toISOString()
            });
        } catch (error) {
            console.error('Error cancelling booking:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

// ============================================
// BUSINESS ENDPOINTS (require business owner or accepted employee auth)
// ============================================

/**
 * GET /businesses/:businessId/bookings
 * Get all bookings for a business
 */
router.get(
    '/businesses/:businessId/bookings',
    authenticate,
    validate(businessBookingsQuerySchema, 'query'),
    async (req, res) => {
        try {
            const { businessId } = req.params;
            const { page, page_size, status, employee_id, date_from, date_to } = req.validated;

            // Verify business access (owner or employee)
            const businessDoc = await db.collection('businesses').doc(businessId).get();
            if (!businessDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }

            const businessData = businessDoc.data();
            const isOwner = businessData.business_owner_id === req.user.id;
            let isEmployee = false;
            let employeeDocId = null;

            if (!isOwner) {
                // Check if user is an accepted employee of this business
                const employeeSnapshot = await db.collection('businesses').doc(businessId)
                    .collection('employees')
                    .where('phone_number', '==', req.user.phone_number)
                    .where('is_accepted', '==', true)
                    .where('is_rejected', '==', false)
                    .limit(1)
                    .get();

                if (!employeeSnapshot.empty) {
                    isEmployee = true;
                    employeeDocId = employeeSnapshot.docs[0].id;
                }
            }

            if (!isOwner && !isEmployee) {
                return res.status(403).json({
                    error: 'Access denied',
                    error_code: 'FORBIDDEN'
                });
            }

            // Fetch bookings
            const bookingsSnapshot = await db.collection('bookings')
                .where('business_id', '==', businessId)
                .orderBy('created_at', 'desc')
                .get();

            let bookings = bookingsSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    created_at: data.created_at?.toDate?.().toISOString() || data.created_at,
                    updated_at: data.updated_at?.toDate?.().toISOString() || data.updated_at
                };
            });

            // Collect unique service IDs and fetch their colors
            const serviceIds = [...new Set(bookings.flatMap(b => (b.items || []).map(i => i.service_id)).filter(Boolean))];
            const serviceColorMap = {};
            if (serviceIds.length > 0) {
                const servicesSnapshot = await db.collection('businesses').doc(businessId).collection('services')
                    .where('__name__', 'in', serviceIds.slice(0, 30))
                    .get();
                servicesSnapshot.docs.forEach(doc => {
                    serviceColorMap[doc.id] = doc.data().color || '#088395';
                });
            }

            // Enrich booking items with service color
            bookings = bookings.map(booking => ({
                ...booking,
                items: (booking.items || []).map(item => ({
                    ...item,
                    service_color: serviceColorMap[item.service_id] || '#088395'
                }))
            }));

            // Apply filters in memory
            if (status) {
                bookings = bookings.filter(b => b.status === status);
            }

            // For employees, force filter to their own bookings only
            const effectiveEmployeeId = isEmployee ? employeeDocId : employee_id;

            if (effectiveEmployeeId) {
                bookings = bookings.filter(b =>
                    b.items?.some(item => item.employee_id === effectiveEmployeeId)
                );
            }

            if (date_from) {
                bookings = bookings.filter(b => b.booking_date >= date_from);
            }

            if (date_to) {
                bookings = bookings.filter(b => b.booking_date <= date_to);
            }

            // Calculate pagination
            const total = bookings.length;
            const totalPages = Math.ceil(total / page_size);
            const startIndex = (page - 1) * page_size;
            const paginatedBookings = bookings.slice(startIndex, startIndex + page_size);

            res.json({
                data: paginatedBookings,
                pagination: {
                    page,
                    page_size,
                    total,
                    total_pages: totalPages,
                    has_next: page < totalPages,
                    has_prev: page > 1
                }
            });
        } catch (error) {
            console.error('Error fetching business bookings:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

/**
 * GET /businesses/:businessId/bookings/:bookingId
 * Get a specific booking by ID
 */
router.get(
    '/businesses/:businessId/bookings/:bookingId',
    authenticate,
    async (req, res) => {
        try {
            const { businessId, bookingId } = req.params;

            // Verify business ownership
            const businessDoc = await db.collection('businesses').doc(businessId).get();
            if (!businessDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }

            const businessData = businessDoc.data();
            if (businessData.business_owner_id !== req.user.id) {
                return res.status(403).json({
                    error: 'Access denied',
                    error_code: 'FORBIDDEN'
                });
            }

            // Fetch booking
            const bookingDoc = await db.collection('bookings').doc(bookingId).get();
            if (!bookingDoc.exists) {
                return res.status(404).json({
                    error: 'Booking not found',
                    error_code: 'BOOKING_NOT_FOUND'
                });
            }

            const bookingData = bookingDoc.data();

            // Verify booking belongs to this business
            if (bookingData.business_id !== businessId) {
                return res.status(403).json({
                    error: 'Booking does not belong to this business',
                    error_code: 'FORBIDDEN'
                });
            }

            res.json({
                id: bookingDoc.id,
                ...bookingData,
                created_at: bookingData.created_at?.toDate?.().toISOString() || bookingData.created_at,
                updated_at: bookingData.updated_at?.toDate?.().toISOString() || bookingData.updated_at
            });
        } catch (error) {
            console.error('Error fetching booking:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

/**
 * PATCH /businesses/:businessId/bookings/:bookingId/status
 * Update booking status (confirm, complete, no_show, cancel)
 */
router.patch(
    '/businesses/:businessId/bookings/:bookingId/status',
    authenticate,
    validate(updateBookingStatusSchema),
    async (req, res) => {
        try {
            const { businessId, bookingId } = req.params;
            const { status } = req.validated;

            // Verify business ownership
            const businessDoc = await db.collection('businesses').doc(businessId).get();
            if (!businessDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }

            const businessData = businessDoc.data();
            if (businessData.business_owner_id !== req.user.id) {
                return res.status(403).json({
                    error: 'Access denied',
                    error_code: 'FORBIDDEN'
                });
            }

            // Fetch booking
            const bookingDoc = await db.collection('bookings').doc(bookingId).get();
            if (!bookingDoc.exists) {
                return res.status(404).json({
                    error: 'Booking not found',
                    error_code: 'BOOKING_NOT_FOUND'
                });
            }

            const bookingData = bookingDoc.data();

            // Verify booking belongs to this business
            if (bookingData.business_id !== businessId) {
                return res.status(403).json({
                    error: 'Booking does not belong to this business',
                    error_code: 'FORBIDDEN'
                });
            }

            // Update status
            const now = new Date();
            await bookingDoc.ref.update({
                status,
                updated_at: now
            });

            // Send notification to customer if they have telegram_id
            if (bookingData.customer_telegram_id) {
                try {
                    const firstItem = bookingData.items?.[0];
                    const serviceName = typeof firstItem?.service_name === 'object'
                        ? firstItem.service_name.uz || firstItem.service_name.ru
                        : firstItem?.service_name || 'Service';

                    await sendBookingStatusUpdateNotification(bookingData.customer_telegram_id, {
                        businessName: businessData.business_name,
                        serviceName,
                        date: bookingData.booking_date,
                        time: firstItem?.start_time?.split('T')[1] || '',
                        status
                    });
                } catch (telegramError) {
                    console.error('Failed to send status update notification:', telegramError);
                }
            }

            res.json({
                id: bookingId,
                ...bookingData,
                status,
                updated_at: now.toISOString()
            });
        } catch (error) {
            console.error('Error updating booking status:', error);
            res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
        }
    }
);

export default router;
