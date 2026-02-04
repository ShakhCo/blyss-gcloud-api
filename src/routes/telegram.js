import { Router } from 'express';
import { telegramAuth } from '../middleware/telegramAuth.js';
import { validate } from '../middleware/validate.js';
import { nearestBusinessesQuerySchema, distanceQuerySchema, telegramAvailableSlotsQuerySchema } from '../schemas/business.js';
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
 */
router.get('/me', (req, res) => {
    res.json(req.telegramUser);
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
 * Returns all time slots for a business day with available employees and their services
 * Query params: business_id, date (YYYY-MM-DD)
 */
router.get('/available-slots', validate(telegramAvailableSlotsQuerySchema, 'query'), async (req, res) => {
    try {
        const { business_id, date } = req.validated;

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
                time_slots: [],
                message: 'Business is closed on this day'
            });
        }

        // 3. Get all accepted employees with their services
        const employeesSnapshot = await db.collection('businesses')
            .doc(business_id)
            .collection('employees')
            .where('is_accepted', '==', true)
            .get();

        if (employeesSnapshot.empty) {
            return res.json({
                time_slots: [],
                message: 'No employees available'
            });
        }

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

        // Build employee data with their services
        const employees = [];
        await Promise.all(employeesSnapshot.docs.map(async (empDoc) => {
            const empData = empDoc.data();

            // Get employee name from business_owners
            let first_name = null;
            let last_name = null;
            if (empData.business_owner_id && businessOwnersMap.has(empData.business_owner_id)) {
                const ownerData = businessOwnersMap.get(empData.business_owner_id);
                first_name = ownerData.first_name || null;
                last_name = ownerData.last_name || null;
            }

            // Get employee services
            const employeeServicesSnapshot = await db.collection('businesses')
                .doc(business_id)
                .collection('employees')
                .doc(empDoc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            if (employeeServicesSnapshot.empty) {
                return; // Skip employees without services
            }

            // Get service details for each employee service
            const services = [];
            for (const serviceDoc of employeeServicesSnapshot.docs) {
                const serviceData = serviceDoc.data();

                // Fetch the parent service to get name and description
                const parentServiceDoc = await db.collection('businesses')
                    .doc(business_id)
                    .collection('services')
                    .doc(serviceData.service_id)
                    .get();

                if (parentServiceDoc.exists) {
                    const parentData = parentServiceDoc.data();
                    services.push({
                        service_id: serviceData.service_id,
                        name: parentData.name || { uz: '', ru: '' },
                        description: parentData.description || { uz: '', ru: '' },
                        duration_minutes: serviceData.duration_minutes,
                        price: serviceData.price
                    });
                }
            }

            if (services.length > 0) {
                employees.push({
                    id: empDoc.id,
                    first_name,
                    last_name,
                    working_hours: empData.working_hours || null,
                    allowed_booking_count_per_slot: empData.allowed_booking_count_per_slot || 1,
                    services
                });
            }
        }));

        if (employees.length === 0) {
            return res.json({
                time_slots: [],
                message: 'No employees with active services available'
            });
        }

        // 4. Get all bookings for that date (pending/confirmed)
        const bookingsSnapshot = await db.collection('bookings')
            .where('business_id', '==', business_id)
            .where('booking_date', '==', date)
            .where('status', 'in', ['pending', 'confirmed'])
            .get();

        // Build map of booked slots per employee
        const employeeBookings = new Map();
        for (const bookingDoc of bookingsSnapshot.docs) {
            const bookingData = bookingDoc.data();
            const items = bookingData.items || [];

            for (const item of items) {
                if (!item.employee_id || !item.start_time) continue;

                if (!employeeBookings.has(item.employee_id)) {
                    employeeBookings.set(item.employee_id, []);
                }

                // Store booking time range in seconds from midnight
                const timePart = item.start_time.split('T')[1];
                const [hours, minutes] = timePart.split(':').map(Number);
                const startSeconds = hours * 3600 + minutes * 60;
                const endSeconds = startSeconds + (item.duration_minutes || 30) * 60;

                employeeBookings.get(item.employee_id).push({
                    start: startSeconds,
                    end: endSeconds
                });
            }
        }

        // 5. Generate 15-minute slots from business open to close
        const slotInterval = 900; // 15 minutes in seconds
        const timeSlots = [];

        for (let slotStart = businessHours.start; slotStart < businessHours.end; slotStart += slotInterval) {
            const slotEnd = slotStart + slotInterval;
            const availableEmployees = [];

            // 6. For each slot, check which employees are available
            for (const employee of employees) {
                // Check employee working hours for this day
                const empHours = employee.working_hours?.[dayName];
                if (empHours && !empHours.is_open) {
                    continue; // Employee not working this day
                }

                // Check if slot is within employee's working hours
                if (empHours) {
                    if (slotStart < empHours.start || slotEnd > empHours.end) {
                        continue; // Slot outside employee's hours
                    }
                }

                // Check if employee is booked during this slot
                const empBookings = employeeBookings.get(employee.id) || [];
                const allowedCount = employee.allowed_booking_count_per_slot;

                // Count overlapping bookings
                let bookingCount = 0;
                for (const booking of empBookings) {
                    // Check if booking overlaps with this slot
                    if (!(slotEnd <= booking.start || slotStart >= booking.end)) {
                        bookingCount++;
                    }
                }

                if (bookingCount < allowedCount) {
                    availableEmployees.push({
                        employee_id: employee.id,
                        first_name: employee.first_name,
                        last_name: employee.last_name,
                        services: employee.services
                    });
                }
            }

            // Only include slot if at least one employee is available
            if (availableEmployees.length > 0) {
                timeSlots.push({
                    start: slotStart,
                    end: slotEnd,
                    available_employees: availableEmployees
                });
            }
        }

        res.json({
            time_slots: timeSlots
        });
    } catch (error) {
        console.error('Error in /telegram/available-slots:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

export default router;
