import { Router } from 'express';
import { telegramAuth } from '../middleware/telegramAuth.js';
import { validate } from '../middleware/validate.js';
import crypto from 'crypto';
import { nearestBusinessesQuerySchema, distanceQuerySchema, telegramAvailableSlotsQuerySchema, telegramSlotEmployeesQuerySchema, telegramCreateBookingSchemaV2 } from '../schemas/business.js';
import { sendBookingNotification } from '../utils/telegram.js';
import { db } from '../db/db.js';

const router = Router();

const OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY;

// Simple in-memory cache for distance calculations
const distanceCache = new Map();
const MAX_CACHE_SIZE = 1000;

function getCacheKey(lat1, lng1, lat2, lng2) {
    const precision = 10000;
    const rLat1 = Math.round(lat1 * precision) / precision;
    const rLng1 = Math.round(lng1 * precision) / precision;
    const rLat2 = Math.round(lat2 * precision) / precision;
    const rLng2 = Math.round(lng2 * precision) / precision;
    return `${rLat1},${rLng1}-${rLat2},${rLng2}`;
}

function setCache(key, value) {
    if (distanceCache.size >= MAX_CACHE_SIZE) {
        const firstKey = distanceCache.keys().next().value;
        distanceCache.delete(firstKey);
    }
    distanceCache.set(key, value);
}

// Apply Telegram auth middleware to all routes
router.use(telegramAuth);

/**
 * GET /telegram/me
 * Returns the current authenticated Telegram user from init data
 * Registers user if not exists
 */
router.get('/me', async (req, res) => {
    try {
        const telegramUser = req.telegramUser;
        const odamUzUserId = String(telegramUser.id);

        // Check if user exists
        const userDoc = await db.collection('users').doc(odamUzUserId).get();

        if (!userDoc.exists) {
            // Register new user
            const now = new Date();
            const newUser = {
                telegram_id: telegramUser.id,
                first_name: telegramUser.first_name || '',
                last_name: telegramUser.last_name || '',
                username: telegramUser.username || '',
                phone_number: null,
                is_verified: false,
                created_at: now,
                updated_at: now
            };

            await db.collection('users').doc(odamUzUserId).set(newUser);

            return res.json({
                ...telegramUser,
                user_id: odamUzUserId
            });
        }

        res.json({
            ...telegramUser,
            user_id: odamUzUserId
        });
    } catch (error) {
        console.error('Error in /telegram/me:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * Convert degrees to radians
 */
function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * GET /telegram/nearest-businesses
 * Returns nearest businesses based on user's location with pagination
 * Query params: lat, lng, radius (default 1000km), page (default 1), page_size (default 5)
 */
router.get('/nearest-businesses', validate(nearestBusinessesQuerySchema, 'query'), async (req, res) => {
    try {
        const { lat, lng, radius = 1000, page = 1, page_size = 5 } = req.validated;

        const businessesSnapshot = await db.collection('businesses').get();

        if (businessesSnapshot.empty) {
            return res.json({
                data: [],
                pagination: {
                    page: 1,
                    page_size,
                    total: 0,
                    total_pages: 0
                }
            });
        }

        // Filter businesses by distance
        const businessesInRadius = [];
        for (const doc of businessesSnapshot.docs) {
            const business = { id: doc.id, ...doc.data() };

            if (!business.location || !business.location.lat || !business.location.lng) {
                continue;
            }

            const distance = calculateDistance(lat, lng, business.location.lat, business.location.lng);

            if (distance <= radius) {
                businessesInRadius.push({ ...business, distance });
            }
        }

        // Sort by distance
        businessesInRadius.sort((a, b) => a.distance - b.distance);

        // Fetch services for all businesses in parallel
        const servicesSnapshots = await Promise.all(
            businessesInRadius.map(business =>
                db.collection('businesses')
                    .doc(business.id)
                    .collection('services')
                    .where('is_active', '==', true)
                    .get()
            )
        );

        // Combine businesses with services, filter out those with no services
        const businessesWithDistance = [];
        for (let i = 0; i < businessesInRadius.length; i++) {
            const business = businessesInRadius[i];
            const servicesSnapshot = servicesSnapshots[i];

            if (servicesSnapshot.empty) {
                continue;
            }

            const services = servicesSnapshot.docs.map(serviceDoc => {
                const serviceData = serviceDoc.data();
                return {
                    name: serviceData.name || { ru: '', uz: '' },
                    duration_minutes: serviceData.duration_minutes || 0
                };
            });

            const distanceValue = business.distance < 1
                ? Math.round(business.distance * 1000)
                : Math.round(business.distance * 100) / 100;
            const distanceMetric = business.distance < 1 ? 'm' : 'km';

            businessesWithDistance.push({
                business_id: business.id,
                business_name: business.business_name,
                location: {
                    lat: business.location.lat,
                    lng: business.location.lng,
                    display_address: business.location.display_address || '',
                    country: business.location.country || '',
                    region: business.location.region || '',
                    city: business.location.city || '',
                    street_name: business.location.street_name || ''
                },
                services,
                distance: distanceValue,
                distance_metric: distanceMetric,
                avatar_url: business.avatar_url || '',
                business_type: business.business_type,
                working_hours: business.working_hours
            });
        }

        // Pagination
        const total = businessesWithDistance.length;
        const total_pages = Math.ceil(total / page_size);
        const start_index = (page - 1) * page_size;
        const paginatedBusinesses = businessesWithDistance.slice(start_index, start_index + page_size);

        res.json({
            data: paginatedBusinesses,
            pagination: {
                page,
                page_size,
                total,
                total_pages,
                has_next: page < total_pages,
                has_prev: page > 1
            }
        });
    } catch (error) {
        console.error('Error in /telegram/nearest-businesses:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * GET /telegram/business-details?business_id=xxx
 * Returns business details with services and employees for each service
 */
router.get('/business-details', async (req, res) => {
    try {
        const { business_id } = req.query;

        if (!business_id) {
            return res.status(400).json({
                error: 'business_id is required',
                error_code: 'MISSING_BUSINESS_ID'
            });
        }

        const [businessDoc, servicesSnapshot, employeesSnapshot] = await Promise.all([
            db.collection('businesses').doc(business_id).get(),
            db.collection('businesses')
                .doc(business_id)
                .collection('services')
                .where('is_active', '==', true)
                .get(),
            db.collection('businesses')
                .doc(business_id)
                .collection('employees')
                .where('is_accepted', '==', true)
                .get()
        ]);

        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const businessData = businessDoc.data();
        const location = businessData.location || {};

        // Get business owner IDs to fetch names
        const businessOwnerIds = new Set();
        employeesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.business_owner_id) {
                businessOwnerIds.add(data.business_owner_id);
            }
        });

        // Fetch business owners data
        const businessOwnersMap = new Map();
        if (businessOwnerIds.size > 0) {
            const ownerPromises = Array.from(businessOwnerIds).map(async (ownerId) => {
                const ownerDoc = await db.collection('business_owners').doc(ownerId).get();
                if (ownerDoc.exists) {
                    businessOwnersMap.set(ownerId, ownerDoc.data());
                }
            });
            await Promise.all(ownerPromises);
        }

        // Fetch employee services for all employees
        const employeeServicesMap = new Map(); // service_id -> [employees]
        await Promise.all(employeesSnapshot.docs.map(async (empDoc) => {
            const empData = empDoc.data();
            const employeeServicesSnapshot = await db.collection('businesses')
                .doc(business_id)
                .collection('employees')
                .doc(empDoc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            // Get employee name from business_owners
            let first_name = null;
            let last_name = null;
            if (empData.business_owner_id && businessOwnersMap.has(empData.business_owner_id)) {
                const ownerData = businessOwnersMap.get(empData.business_owner_id);
                first_name = ownerData.first_name || null;
                last_name = ownerData.last_name || null;
            }

            employeeServicesSnapshot.docs.forEach(serviceDoc => {
                const serviceData = serviceDoc.data();
                const serviceId = serviceData.service_id;

                if (!employeeServicesMap.has(serviceId)) {
                    employeeServicesMap.set(serviceId, []);
                }

                employeeServicesMap.get(serviceId).push({
                    id: empDoc.id,
                    first_name,
                    last_name,
                    position: empData.position || '',
                    price: serviceData.price,
                    duration_minutes: serviceData.duration_minutes
                });
            });
        }));

        // Build services with employees
        const services = servicesSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name || { ru: '', uz: '' },
                description: data.description || { ru: '', uz: '' },
                price: data.price,
                duration_minutes: data.duration_minutes,
                employees: employeeServicesMap.get(doc.id) || []
            };
        });

        res.json({
            business_id,
            business_name: businessData.business_name,
            business_location: {
                city: location.city || '',
                country: location.country || '',
                street_name: location.street_name || '',
                display_address: location.display_address || '',
                lat: location.lat || 0,
                lng: location.lng || 0
            },
            avatar_url: businessData.avatar_url || '',
            business_type: businessData.business_type,
            working_hours: businessData.working_hours,
            business_phone_number: businessData.business_phone_number || '',
            tenant_url: businessData.tenant_url || '',
            services
        });
    } catch (error) {
        console.error('Error in /telegram/business-details:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * GET /telegram/get-distance
 * Calculate road distance and travel time between user and business locations
 * Query params: user_lat, user_lng, business_lat, business_lng
 * Returns: { distance: number, metric: 'km' | 'm', duration: number (minutes) }
 */
router.get('/get-distance', validate(distanceQuerySchema, 'query'), async (req, res) => {
    try {
        const { user_lat, user_lng, business_lat, business_lng } = req.validated;

        // Check cache first
        const cacheKey = getCacheKey(user_lat, user_lng, business_lat, business_lng);
        const cachedResult = distanceCache.get(cacheKey);

        if (cachedResult) {
            return res.json(cachedResult);
        }

        if (!OPENROUTESERVICE_API_KEY) {
            return res.status(500).json({
                error: 'OpenRouteService API key not configured',
                error_code: 'API_KEY_MISSING'
            });
        }

        // OpenRouteService expects [lng, lat] format
        const locations = [
            [user_lng, user_lat],
            [business_lng, business_lat]
        ];

        const response = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
            method: 'POST',
            headers: {
                'Authorization': OPENROUTESERVICE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                locations,
                metrics: ['distance', 'duration'],
                units: 'km'
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return res.status(response.status).json({
                error: errorData.error?.message || 'Failed to calculate distance',
                error_code: 'DISTANCE_CALCULATION_FAILED'
            });
        }

        const data = await response.json();

        const distanceInKm = data.distances?.[0]?.[1];
        const durationInSeconds = data.durations?.[0]?.[1];

        if (distanceInKm === undefined || distanceInKm === null) {
            return res.status(500).json({
                error: 'Unable to calculate distance between locations',
                error_code: 'DISTANCE_NOT_AVAILABLE'
            });
        }

        const durationInMinutes = durationInSeconds ? Math.ceil(durationInSeconds / 60) : null;

        let result;
        if (distanceInKm < 1) {
            const distanceInMeters = Math.round(distanceInKm * 1000);
            result = { distance: distanceInMeters, metric: 'm', duration: durationInMinutes };
        } else {
            const roundedKm = Math.round(distanceInKm * 10) / 10;
            result = { distance: roundedKm, metric: 'km', duration: durationInMinutes };
        }

        setCache(cacheKey, result);

        res.json(result);
    } catch (error) {
        console.error('Error in /telegram/get-distance:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

// Day name mapping for working hours lookup
const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * GET /telegram/available-slots
 * Returns available start times for a service chain
 * Query params: business_id, date (YYYY-MM-DD), service_ids (comma-separated)
 */
router.get('/available-slots', validate(telegramAvailableSlotsQuerySchema, 'query'), async (req, res) => {
    try {
        const { business_id, date, service_ids } = req.validated;

        // 1. Get business and validate it exists
        const businessDoc = await db.collection('businesses').doc(business_id).get();
        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const businessData = businessDoc.data();

        // 2. Get day's working hours
        const dateObj = new Date(date);
        const dayIndex = dateObj.getDay();
        const dayName = dayNames[dayIndex];
        const businessHours = businessData.working_hours?.[dayName];

        if (!businessHours || !businessHours.is_open) {
            return res.json({
                first_service: null,
                total_services: service_ids.length,
                available_start_times: [],
                message: 'Business is closed on this day'
            });
        }

        // 3. Get first service details
        const firstServiceId = service_ids[0];
        const firstServiceDoc = await db.collection('businesses')
            .doc(business_id)
            .collection('services')
            .doc(firstServiceId)
            .get();

        if (!firstServiceDoc.exists) {
            return res.status(400).json({
                error: `Service ${firstServiceId} not found`,
                error_code: 'SERVICE_NOT_FOUND'
            });
        }

        const firstServiceData = firstServiceDoc.data();
        if (!firstServiceData.is_active) {
            return res.status(400).json({
                error: `Service ${firstServiceId} is not active`,
                error_code: 'SERVICE_NOT_ACTIVE'
            });
        }

        // 4. Get employees who offer the first service
        const employeesSnapshot = await db.collection('businesses')
            .doc(business_id)
            .collection('employees')
            .where('is_accepted', '==', true)
            .get();

        if (employeesSnapshot.empty) {
            return res.json({
                first_service: {
                    id: firstServiceId,
                    name: firstServiceData.name || { uz: '', ru: '' },
                    original_price: firstServiceData.price,
                    original_duration: firstServiceData.duration_minutes
                },
                total_services: service_ids.length,
                available_start_times: [],
                message: 'No employees available'
            });
        }

        // Build list of employees who offer the first service
        const employeesWithFirstService = [];
        for (const empDoc of employeesSnapshot.docs) {
            const empData = empDoc.data();

            const empServiceSnapshot = await db.collection('businesses')
                .doc(business_id)
                .collection('employees')
                .doc(empDoc.id)
                .collection('employeeServices')
                .where('service_id', '==', firstServiceId)
                .where('is_active', '==', true)
                .limit(1)
                .get();

            if (!empServiceSnapshot.empty) {
                const empServiceData = empServiceSnapshot.docs[0].data();
                employeesWithFirstService.push({
                    id: empDoc.id,
                    working_hours: empData.working_hours || null,
                    allowed_booking_count_per_slot: empData.allowed_booking_count_per_slot || 1,
                    duration_minutes: empServiceData.duration_minutes
                });
            }
        }

        if (employeesWithFirstService.length === 0) {
            return res.json({
                first_service: {
                    id: firstServiceId,
                    name: firstServiceData.name || { uz: '', ru: '' },
                    original_price: firstServiceData.price,
                    original_duration: firstServiceData.duration_minutes
                },
                total_services: service_ids.length,
                available_start_times: [],
                message: 'No employees offer this service'
            });
        }

        // 5. Get all bookings for that date
        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', business_id)
            .where('booking_date', '==', date)
            .where('status', 'in', ['pending', 'confirmed'])
            .get();

        const employeeBookings = new Map();
        for (const bookingDoc of bookingsSnapshot.docs) {
            const bookingData = bookingDoc.data();
            for (const item of bookingData.items || []) {
                if (!item.employee_id || !item.start_time) continue;

                if (!employeeBookings.has(item.employee_id)) {
                    employeeBookings.set(item.employee_id, []);
                }

                const timePart = item.start_time.split('T')[1];
                const [hours, minutes] = timePart.split(':').map(Number);
                const startSeconds = hours * 3600 + minutes * 60;
                const endSeconds = startSeconds + (item.duration_minutes || 30) * 60;

                employeeBookings.get(item.employee_id).push({ start: startSeconds, end: endSeconds });
            }
        }

        // 6. Generate available start times
        const slotInterval = 900; // 15 minutes
        const availableStartTimes = [];

        // Calculate minimum start time if date is today (Uzbekistan time GMT+5)
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const uzbekNow = new Date(utcNow + (5 * 3600000));
        const todayUzb = uzbekNow.toISOString().split('T')[0];

        let minSlotStart = businessHours.start;
        if (date === todayUzb) {
            const currentSeconds = uzbekNow.getHours() * 3600 + uzbekNow.getMinutes() * 60 + uzbekNow.getSeconds();
            const bufferSeconds = 900;
            minSlotStart = Math.max(businessHours.start, currentSeconds + bufferSeconds);
            minSlotStart = Math.ceil(minSlotStart / slotInterval) * slotInterval;
        }

        for (let slotStart = minSlotStart; slotStart < businessHours.end; slotStart += slotInterval) {
            let hasAvailableEmployee = false;

            for (const employee of employeesWithFirstService) {
                const empHours = employee.working_hours?.[dayName];
                if (empHours && !empHours.is_open) continue;

                const slotEnd = slotStart + employee.duration_minutes * 60;

                if (empHours && (slotStart < empHours.start || slotEnd > empHours.end)) continue;
                if (slotEnd > businessHours.end) continue;

                const empBookings = employeeBookings.get(employee.id) || [];
                let bookingCount = 0;
                for (const booking of empBookings) {
                    if (!(slotEnd <= booking.start || slotStart >= booking.end)) {
                        bookingCount++;
                    }
                }

                if (bookingCount < employee.allowed_booking_count_per_slot) {
                    hasAvailableEmployee = true;
                    break;
                }
            }

            if (hasAvailableEmployee) {
                availableStartTimes.push(slotStart);
            }
        }

        res.json({
            first_service: {
                id: firstServiceId,
                name: firstServiceData.name || { uz: '', ru: '' },
                original_price: firstServiceData.price,
                original_duration: firstServiceData.duration_minutes
            },
            total_services: service_ids.length,
            available_start_times: availableStartTimes
        });
    } catch (error) {
        console.error('Error in /telegram/available-slots:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * GET /telegram/slot-employees
 * Returns available employees for each service in the chain at a specific start time
 * Query params: business_id, date (YYYY-MM-DD), service_ids (comma-separated), start_time (seconds)
 */
router.get('/slot-employees', validate(telegramSlotEmployeesQuerySchema, 'query'), async (req, res) => {
    try {
        const { business_id, date, service_ids, start_time } = req.validated;

        // 1. Get business and validate
        const businessDoc = await db.collection('businesses').doc(business_id).get();
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

        // 2. Get all employees
        const employeesSnapshot = await db.collection('businesses')
            .doc(business_id)
            .collection('employees')
            .where('is_accepted', '==', true)
            .get();

        // Get business owner names
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

        // Build employee map with their services
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
                .doc(business_id)
                .collection('employees')
                .doc(empDoc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            const services = new Map();
            for (const svcDoc of empServicesSnapshot.docs) {
                const svcData = svcDoc.data();
                services.set(svcData.service_id, {
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
                services
            });
        }

        // 3. Get all bookings for that date
        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', business_id)
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
                const startSeconds = hours * 3600 + minutes * 60;
                const endSeconds = startSeconds + (item.duration_minutes || 30) * 60;

                employeeBookings.get(item.employee_id).push({ start: startSeconds, end: endSeconds });
            }
        }

        // 4. Build service chain with available employees
        const servicesResult = [];
        let currentStartTime = start_time;

        for (const serviceId of service_ids) {
            const serviceDoc = await db.collection('businesses')
                .doc(business_id)
                .collection('services')
                .doc(serviceId)
                .get();

            if (!serviceDoc.exists) {
                servicesResult.push({
                    service_id: serviceId,
                    name: { uz: '', ru: '' },
                    start_time: currentStartTime,
                    employees: [],
                    unavailable: true,
                    reason: 'service_not_found'
                });
                currentStartTime += 1800;
                continue;
            }

            const serviceData = serviceDoc.data();
            if (!serviceData.is_active) {
                servicesResult.push({
                    service_id: serviceId,
                    name: serviceData.name || { uz: '', ru: '' },
                    start_time: currentStartTime,
                    employees: [],
                    unavailable: true,
                    reason: 'service_not_active'
                });
                currentStartTime += 1800;
                continue;
            }

            const availableEmployees = [];
            let shortestDuration = Infinity;

            for (const [empId, employee] of employeeMap) {
                if (!employee.services.has(serviceId)) continue;

                const empService = employee.services.get(serviceId);
                const slotEnd = currentStartTime + empService.duration_minutes * 60;

                const empHours = employee.working_hours?.[dayName];
                if (empHours && !empHours.is_open) continue;
                if (empHours && (currentStartTime < empHours.start || slotEnd > empHours.end)) continue;
                if (slotEnd > businessHours.end) continue;

                const empBookings = employeeBookings.get(empId) || [];
                let bookingCount = 0;
                for (const booking of empBookings) {
                    if (!(slotEnd <= booking.start || currentStartTime >= booking.end)) {
                        bookingCount++;
                    }
                }

                if (bookingCount < employee.allowed_booking_count_per_slot) {
                    availableEmployees.push({
                        id: empId,
                        first_name: employee.first_name,
                        last_name: employee.last_name,
                        price: empService.price,
                        duration_minutes: empService.duration_minutes
                    });

                    if (empService.duration_minutes < shortestDuration) {
                        shortestDuration = empService.duration_minutes;
                    }
                }
            }

            if (availableEmployees.length === 0) {
                const reason = currentStartTime >= businessHours.end
                    ? 'exceeds_business_hours'
                    : 'no_employees_available';

                servicesResult.push({
                    service_id: serviceId,
                    name: serviceData.name || { uz: '', ru: '' },
                    start_time: currentStartTime,
                    employees: [],
                    unavailable: true,
                    reason
                });
                currentStartTime += (serviceData.duration_minutes || 30) * 60;
            } else {
                servicesResult.push({
                    service_id: serviceId,
                    name: serviceData.name || { uz: '', ru: '' },
                    start_time: currentStartTime,
                    employees: availableEmployees
                });
                currentStartTime += shortestDuration * 60;
            }
        }

        res.json({ services: servicesResult });
    } catch (error) {
        console.error('Error in /telegram/slot-employees:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * Convert seconds from midnight to HH:mm format
 */
function secondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * POST /telegram/bookings
 * Create a new booking from Telegram mini app (v2 - simplified payload)
 */
router.post('/bookings', validate(telegramCreateBookingSchemaV2), async (req, res) => {
    try {
        const { user_id, business_id, date, start_time, services, notes } = req.validated;
        const telegramUser = req.telegramUser;

        // 1. Validate user exists
        const userDoc = await db.collection('users').doc(user_id).get();
        if (!userDoc.exists) {
            return res.status(404).json({
                error: 'User not found',
                error_code: 'USER_NOT_FOUND'
            });
        }
        const userData = userDoc.data();

        // 2. Verify business exists and get working hours
        const businessDoc = await db.collection('businesses').doc(business_id).get();
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

        // 3. Get all employees with their services
        const employeesSnapshot = await db.collection('businesses')
            .doc(business_id)
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
                .doc(business_id)
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

        // 4. Get existing bookings
        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', business_id)
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
                .doc(business_id)
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

            // Add to employee bookings map (for subsequent services)
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
        const customerName = [userData.first_name, userData.last_name].filter(Boolean).join(' ')
            || [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ')
            || 'Telegram User';

        const bookingPayload = {
            business_id,
            business_name: businessData.business_name,
            user_id,
            customer_name: customerName,
            customer_phone: userData.phone_number || '',
            customer_telegram_id: telegramUser.id,
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

        // 8. Send Telegram notification
        if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
            try {
                const firstItem = bookingItems[0];
                const serviceName = typeof firstItem.service_name === 'object'
                    ? firstItem.service_name.uz || firstItem.service_name.ru
                    : firstItem.service_name;

                await sendBookingNotification(businessData.telegram_bot.chat_id, {
                    serviceName,
                    customerName: bookingPayload.customer_name,
                    customerPhone: bookingPayload.customer_phone || 'N/A',
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
        console.error('Error in /telegram/bookings:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

export default router;
