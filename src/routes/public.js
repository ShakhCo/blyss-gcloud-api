import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/db.js';
import { authenticate, verifySignature } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { nearestBusinessesQuerySchema, publicSendOtpSchema, publicVerifyOtpSchema, publicAvailableSlotsQuerySchema, publicSlotEmployeesQuerySchema, publicCreateBookingSchema, publicRegisterSchema } from '../schemas/business.js';
import { distanceBodySchema } from '../schemas/distance.js';
import { submitReviewSchema } from '../schemas/review.js';
import { sendOtpSms } from '../utils/eskiz.js';
import { generateTokenPair, verifyRefreshToken } from '../utils/jwt.js';
import { checkUserBookingLimit } from '../utils/bookingLimits.js';
import { sendBookingCancellationNotification } from '../utils/telegram.js';
const router = Router();

/**
 * Apply rate limiting to all public routes
 */
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // limit each IP to 300 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    // Trust proxy is set to 1 in server.js (single proxy hop for Cloud Run)
    validate: { trustProxy: false }
});

router.use(limiter);

/**
 * Get business by tenant URL (subdomain)
 * Extracts subdomain from the request hostname
 * Example: {business-name}.blyss.uz -> {business-name}
 */
router.get('/business', async (req, res) => {
    try {
        const host = req.headers.host || '';
        const zoneDomain = process.env.CLOUDFLARE_ZONE_DOMAIN || 'blyss.uz';

        // Extract subdomain from host
        // Examples:
        //   "my-salon.blyss.uz" -> "my-salon"
        //   "localhost:3000" -> null (no subdomain)
        let subdomain = null;

        if (host.includes('.' + zoneDomain)) {
            subdomain = host.split('.' + zoneDomain)[0];
        } else if (host.includes('localhost')) {
            // For local development, check query param
            subdomain = req.query.tenant;
        }

        if (!subdomain) {
            return res.status(400).json({
                error: 'Unable to determine tenant. Use {tenant}.blyss.uz format.',
                error_code: 'INVALID_TENANT'
            });
        }

        // Find business by tenant_url
        const businessesSnapshot = await db.collection('businesses')
            .where('tenant_url', '==', `${subdomain}.${zoneDomain}`)
            .limit(1)
            .get();

        if (businessesSnapshot.empty) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const businessDoc = businessesSnapshot.docs[0];
        const businessData = businessDoc.data();

        res.json({
            business_name: businessData.business_name,
            bio: businessData.bio || '',
            business_type: businessData.business_type,
            location: businessData.location,
            working_hours: businessData.working_hours,
            business_phone_number: businessData.business_phone_number,
            tenant_url: businessData.tenant_url
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * Get services for a business by tenant URL
 * Public endpoint for tenant websites to fetch active services
 */
router.get('/business/services', async (req, res) => {
    try {
        const host = req.headers.host || '';
        const zoneDomain = process.env.CLOUDFLARE_ZONE_DOMAIN || 'blyss.uz';

        // Extract subdomain from host
        let subdomain = null;

        if (host.includes('.' + zoneDomain)) {
            subdomain = host.split('.' + zoneDomain)[0];
        } else if (host.includes('localhost')) {
            // For local development, check query param
            subdomain = req.query.tenant;
        }

        if (!subdomain) {
            return res.status(400).json({
                error: 'Unable to determine tenant. Use {tenant}.blyss.uz format.',
                error_code: 'INVALID_TENANT'
            });
        }

        // Find business by tenant_url
        const businessesSnapshot = await db.collection('businesses')
            .where('tenant_url', '==', `${subdomain}.${zoneDomain}`)
            .limit(1)
            .get();

        if (businessesSnapshot.empty) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

        const businessDoc = businessesSnapshot.docs[0];
        const businessId = businessDoc.id;
        const businessData = businessDoc.data();

        // Get active services for this business
        const servicesSnapshot = await db.collection('businesses')
            .doc(businessId)
            .collection('services')
            .where('is_active', '==', true)
            .get();

        const services = servicesSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name,
                description: data.description || null,
                price: data.price,
                duration_minutes: data.duration_minutes
            };
        });

        res.json({
            business: {
                name: businessData.business_name,
                business_type: businessData.business_type,
                location: businessData.location,
                working_hours: businessData.working_hours,
                business_phone_number: businessData.business_phone_number,
                tenant_url: businessData.tenant_url
            },
            services
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * Get services and employees by business slug
 * Alternative endpoint that accepts slug as a path parameter
 * Example: GET /public/businesses/my-salon/services
 */
router.get('/businesses/:slug/services', verifySignature, async (req, res) => {
    try {
        const { slug } = req.params;
        const zoneDomain = process.env.CLOUDFLARE_ZONE_DOMAIN || 'blyss.uz';
        const tenantUrl = `${slug}.${zoneDomain}`;

        // Find business by tenant_url first, then fallback to document ID
        let businessDoc;
        let businessId;

        const businessesSnapshot = await db.collection('businesses')
            .where('tenant_url', '==', tenantUrl)
            .limit(1)
            .get();

        if (!businessesSnapshot.empty) {
            businessDoc = businessesSnapshot.docs[0];
            businessId = businessDoc.id;
        } else {
            // Fallback: try by document ID
            const byIdDoc = await db.collection('businesses').doc(slug).get();
            if (!byIdDoc.exists) {
                return res.status(404).json({
                    error: 'Business not found',
                    error_code: 'BUSINESS_NOT_FOUND'
                });
            }
            businessDoc = byIdDoc;
            businessId = byIdDoc.id;
        }

        const businessData = businessDoc.data();

        // Get active services, accepted employees, and photos in parallel
        const [servicesSnapshot, employeesSnapshot, photosSnapshot] = await Promise.all([
            db.collection('businesses')
                .doc(businessId)
                .collection('services')
                .where('is_active', '==', true)
                .get(),
            db.collection('businesses')
                .doc(businessId)
                .collection('employees')
                .where('is_accepted', '==', true)
                .get(),
            db.collection('businesses')
                .doc(businessId)
                .collection('photos')
                .orderBy('order', 'asc')
                .get()
        ]);

        // Build services map for employee services lookup
        const servicesMap = new Map();
        const services = servicesSnapshot.docs.map(doc => {
            const data = doc.data();
            servicesMap.set(doc.id, data);
            return {
                id: doc.id,
                name: data.name,
                description: data.description || null,
                price: data.price,
                duration_minutes: data.duration_minutes
            };
        });

        // Collect business_owner_ids from employees
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

        // Fetch employee services and build employees array
        const employees = await Promise.all(employeesSnapshot.docs.map(async (doc) => {
            const data = doc.data();

            // Get name from business_owners (phone_number excluded from public API)
            let first_name = null;
            let last_name = null;
            if (data.business_owner_id && businessOwnersMap.has(data.business_owner_id)) {
                const ownerData = businessOwnersMap.get(data.business_owner_id);
                first_name = ownerData.first_name || null;
                last_name = ownerData.last_name || null;
            }

            // Fetch employee services
            const employeeServicesSnapshot = await db.collection('businesses')
                .doc(businessId)
                .collection('employees')
                .doc(doc.id)
                .collection('employeeServices')
                .where('is_active', '==', true)
                .get();

            const employeeServices = employeeServicesSnapshot.docs.map(serviceDoc => {
                const serviceData = serviceDoc.data();
                const businessService = servicesMap.get(serviceData.service_id);
                return {
                    id: serviceDoc.id,
                    service_id: serviceData.service_id,
                    name: businessService?.name || null,
                    price: serviceData.price,
                    duration_minutes: serviceData.duration_minutes
                };
            });

            return {
                id: doc.id,
                first_name,
                last_name,
                position: data.position ?? '',
                availability_type: data.availability_type ?? 'flexible',
                working_hours: data.working_hours ?? null,
                is_open_now: data.is_open_now ?? false,
                services: employeeServices
            };
        }));

        // Format working_hours - use default structure if null or undefined
        const formatWorkingHours = (hours) => {
            const defaultHours = {
                monday: { start: 0, end: 86399, is_open: false },
                tuesday: { start: 0, end: 86399, is_open: false },
                wednesday: { start: 0, end: 86399, is_open: false },
                thursday: { start: 0, end: 86399, is_open: false },
                friday: { start: 0, end: 86399, is_open: false },
                saturday: { start: 0, end: 86399, is_open: false },
                sunday: { start: 0, end: 86399, is_open: false }
            };
            if (!hours) return defaultHours;
            return { ...defaultHours, ...hours };
        };

        // Calculate distance if user location is provided
        let distance = null;
        const userLat = parseFloat(req.query.lat);
        const userLng = parseFloat(req.query.lng);
        const businessLocation = businessData.location;

        if (!isNaN(userLat) && !isNaN(userLng) && businessLocation?.lat && businessLocation?.lng) {
            const cacheKey = getCacheKey(userLat, userLng, businessLocation.lat, businessLocation.lng);
            const cachedResult = distanceCache.get(cacheKey);

            if (cachedResult) {
                distance = cachedResult;
            } else if (OPENROUTESERVICE_API_KEY) {
                try {
                    const orsResponse = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
                        method: 'POST',
                        headers: {
                            'Authorization': OPENROUTESERVICE_API_KEY,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            locations: [
                                [userLng, userLat],
                                [businessLocation.lng, businessLocation.lat]
                            ],
                            metrics: ['distance', 'duration'],
                            units: 'km'
                        })
                    });

                    if (orsResponse.ok) {
                        const orsData = await orsResponse.json();
                        const distanceInKm = orsData.distances?.[0]?.[1];
                        const durationInSeconds = orsData.durations?.[0]?.[1];

                        if (distanceInKm != null) {
                            const durationInMinutes = durationInSeconds ? Math.ceil(durationInSeconds / 60) : null;
                            if (distanceInKm < 1) {
                                distance = { distance: Math.round(distanceInKm * 1000), metric: 'm', duration: durationInMinutes };
                            } else {
                                distance = { distance: Math.round(distanceInKm * 10) / 10, metric: 'km', duration: durationInMinutes };
                            }
                            setCache(cacheKey, distance);
                        }
                    }
                } catch (distanceError) {
                    console.error('Distance calculation failed:', distanceError);
                }
            }
        }

        res.json({
            business: {
                id: businessId,
                name: businessData.business_name,
                bio: businessData.bio || '',
                business_type: businessData.business_type,
                location: businessData.location,
                working_hours: formatWorkingHours(businessData.working_hours),
                business_phone_number: businessData.business_phone_number,
                tenant_url: businessData.tenant_url,
                avatar_url: businessData.avatar_url || null,
                cover_url: businessData.cover_url || null,
                primary_color: businessData.primary_color || null,
            },
            photos: photosSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })),
            distance,
            services,
            employees
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * Get business details with services by business ID
 * Example: GET /public/businesses/abc123xyz/details
 * Public endpoint - only requires signature verification
 */
router.get('/businesses/:businessId/details', verifySignature, async (req, res) => {
    try {
        const { businessId } = req.params;

        // Fetch business, services, and photos in parallel
        const [businessDoc, servicesSnapshot, photosSnapshot] = await Promise.all([
            db.collection('businesses').doc(businessId).get(),
            db.collection('businesses')
                .doc(businessId)
                .collection('services')
                .where('is_active', '==', true)
                .get(),
            db.collection('businesses')
                .doc(businessId)
                .collection('photos')
                .orderBy('order', 'asc')
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

        const services = servicesSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name || { ru: '', uz: '' },
                description: data.description || { ru: '', uz: '' },
                price: data.price,
                duration_minutes: data.duration_minutes
            };
        });

        const photos = photosSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({
            business_id: businessId,
            business_name: businessData.business_name,
            bio: businessData.bio || '',
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
            services,
            photos
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
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
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lng1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lng2 - Longitude of point 2
 * @returns {number} - Distance in kilometers
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Get nearest businesses based on user's location with pagination
 * Query params: lat (required), lng (required), radius (optional, default 10km), page (optional, default 1), page_size (optional, default 5)
 * Public endpoint - no authentication required
 */
router.get('/businesses/nearest', verifySignature, validate(nearestBusinessesQuerySchema, 'query'), async (req, res) => {
    try {
        const { lat, lng, radius, page = 1, page_size = 5 } = req.validated;

        // Fetch only verified businesses
        const businessesSnapshot = await db.collection('businesses')
            .where('business_status', '==', 'verified')
            .get();

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

        // Step 1: Filter businesses by distance (no DB calls yet)
        const businessesInRadius = [];
        for (const doc of businessesSnapshot.docs) {
            const business = { id: doc.id, ...doc.data() };

            // Skip if location is missing
            if (!business.location || !business.location.lat || !business.location.lng) {
                continue;
            }

            const distance = calculateDistance(lat, lng, business.location.lat, business.location.lng);

            if (!radius || distance <= radius) {
                businessesInRadius.push({ ...business, distance });
            }
        }

        // Sort by distance first
        businessesInRadius.sort((a, b) => a.distance - b.distance);

        // Step 2: Fetch services for all businesses in parallel
        const servicesPromises = businessesInRadius.map(business =>
            db.collection('businesses')
                .doc(business.id)
                .collection('services')
                .where('is_active', '==', true)
                .get()
        );

        const servicesSnapshots = await Promise.all(servicesPromises);

        // Step 3: Combine businesses with their services, filter out those with no services
        const businessesWithDistance = [];
        for (let i = 0; i < businessesInRadius.length; i++) {
            const business = businessesInRadius[i];
            const servicesSnapshot = servicesSnapshots[i];

            // Skip businesses with no services
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

            // Convert to meters if less than 1km
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

        // Calculate pagination
        const total = businessesWithDistance.length;
        const total_pages = Math.ceil(total / page_size);
        const start_index = (page - 1) * page_size;
        const end_index = start_index + page_size;

        // Get paginated results
        const paginatedBusinesses = businessesWithDistance.slice(start_index, end_index);

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
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Simple in-memory cache for distance calculations
const distanceCache = new Map();
const MAX_CACHE_SIZE = 1000;
const OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY;

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

/**
 * POST /public/get-distance
 * Calculate road distance and travel time between two locations
 * Body: { from: { lat, lng }, to: { lat, lng } }
 * Returns: { distance: number, metric: 'km' | 'm', duration: number (minutes) }
 */
router.post('/get-distance', verifySignature, validate(distanceBodySchema), async (req, res) => {
    try {
        const { from, to } = req.validated;

        const cacheKey = getCacheKey(from.lat, from.lng, to.lat, to.lng);
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
            [from.lng, from.lat],
            [to.lng, to.lat]
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
        console.error('Error in POST /public/get-distance:', error);
        res.status(500).json({
            error: 'Internal server error',
            error_code: 'INTERNAL_ERROR'
        });
    }
});

// ─── Rate limiters for new public endpoints ───

const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many OTP requests, please try again later', error_code: 'RATE_LIMITED' },
    validate: { trustProxy: false }
});

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
 */
function secondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// ─── Public OTP Endpoints ───

/**
 * POST /public/send-otp
 * Send OTP to phone number for public website user verification
 * Tries SMS first, falls back to Telegram if user has telegram_id
 */
router.post('/send-otp', verifySignature, otpLimiter, validate(publicSendOtpSchema), async (req, res) => {
    try {
        const { phone_number } = req.validated;

        // Check rate limit - 60 seconds between requests per phone number
        const recentOtpSnapshot = await db.collection('otps')
            .where('phone_number', '==', phone_number)
            .orderBy('created_at', 'desc')
            .limit(1)
            .get();

        if (!recentOtpSnapshot.empty) {
            const lastOtp = recentOtpSnapshot.docs[0].data();
            const elapsed = Date.now() - lastOtp.created_at.toDate().getTime();
            if (elapsed < 60000) {
                const waitTime = Math.ceil((60000 - elapsed) / 1000);
                return res.status(429).json({
                    error: `Please wait ${waitTime} seconds before requesting another code`,
                    error_code: 'RATE_LIMITED',
                    wait_seconds: waitTime
                });
            }
        }

        // Generate 5-digit OTP
        const otpCode = crypto.randomInt(10000, 100000).toString();

        // Send OTP via SMS + Telegram (handled internally by sendOtpSms)
        const result = await sendOtpSms(phone_number, otpCode, 'user');

        if (!result.success) {
            return res.status(503).json({
                error: 'Failed to deliver OTP. Please try again later.',
                error_code: 'OTP_DELIVERY_FAILED'
            });
        }

        // Hash and store OTP
        const otpHash = await bcrypt.hash(otpCode, 10);
        await db.collection('otps').add({
            phone_number,
            otp_code: otpHash,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 5 * 60 * 1000),
            used: false,
            user_type: 'user'
        });

        res.json({
            message: 'OTP sent successfully',
            delivery_method: result.delivery_method
        });
    } catch (error) {
        console.error('Error in POST /public/send-otp:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /public/verify-otp
 * Verify OTP and return JWT tokens for public website auth
 * If user doesn't exist, returns needs_registration: true with otp_id
 */
router.post('/verify-otp', verifySignature, validate(publicVerifyOtpSchema), async (req, res) => {
    try {
        const { phone_number, otp_code } = req.validated;

        // Find matching OTP
        const otpSnapshot = await db.collection('otps')
            .where('phone_number', '==', phone_number)
            .where('used', '==', false)
            .orderBy('created_at', 'desc')
            .limit(1)
            .get();

        if (otpSnapshot.empty) {
            return res.status(400).json({
                error: 'Invalid OTP',
                error_code: 'INVALID_OTP'
            });
        }

        const otpDoc = otpSnapshot.docs[0];
        const otpData = otpDoc.data();

        // Check attempt limit (max 5 tries per OTP)
        const attempts = otpData.attempts || 0;
        if (attempts >= 5) {
            // Invalidate the OTP
            await otpDoc.ref.update({ used: true });
            return res.status(429).json({
                error: 'Too many failed attempts. Please request a new code.',
                error_code: 'OTP_MAX_ATTEMPTS'
            });
        }

        // Check if expired
        if (otpData.expires_at.toDate() < new Date()) {
            return res.status(400).json({
                error: 'OTP has expired',
                error_code: 'OTP_EXPIRED'
            });
        }

        // Verify OTP code (supports both bcrypt hash and legacy plaintext)
        const storedCode = otpData.otp_code;
        const inputCode = String(otp_code);
        const isBcryptHash = storedCode.startsWith('$2');
        const isMatch = isBcryptHash
            ? await bcrypt.compare(inputCode, storedCode)
            : storedCode === inputCode;

        if (!isMatch) {
            // Increment attempt counter
            await otpDoc.ref.update({ attempts: attempts + 1 });
            return res.status(400).json({
                error: 'Invalid OTP code',
                error_code: 'INVALID_OTP'
            });
        }

        // Check if user exists by phone_number
        const usersSnapshot = await db.collection('users')
            .where('phone_number', '==', phone_number)
            .limit(1)
            .get();

        if (usersSnapshot.empty) {
            // Mark OTP as verified but NOT used (registration will mark as used)
            await otpDoc.ref.update({ verified: true, verified_at: new Date() });

            return res.json({
                success: true,
                needs_registration: true,
                otp_id: otpDoc.id,
                phone_number
            });
        }

        // Existing user - mark OTP as used and return tokens
        await otpDoc.ref.update({ used: true });

        const userData = usersSnapshot.docs[0].data();
        const userId = usersSnapshot.docs[0].id;

        await usersSnapshot.docs[0].ref.update({
            is_verified: true,
            updated_at: new Date()
        });

        // Generate JWT pair
        const { accessToken, refreshToken } = generateTokenPair({
            user_id: userId,
            user_type: 'user'
        });

        res.json({
            success: true,
            needs_registration: false,
            access_token: accessToken,
            refresh_token: refreshToken,
            user_id: userId,
            phone_number,
            first_name: userData.first_name || '',
            last_name: userData.last_name || ''
        });
    } catch (error) {
        console.error('Error in POST /public/verify-otp:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /public/register
 * Register a new web user after OTP verification
 */
router.post('/register', verifySignature, validate(publicRegisterSchema), async (req, res) => {
    try {
        const { otp_id, phone_number, first_name, last_name } = req.validated;

        // Verify OTP exists and is verified but not used
        const otpDoc = await db.collection('otps').doc(otp_id).get();
        if (!otpDoc.exists) {
            return res.status(400).json({
                error: 'Invalid OTP reference',
                error_code: 'INVALID_OTP'
            });
        }

        const otpData = otpDoc.data();
        if (!otpData.verified || otpData.used) {
            return res.status(400).json({
                error: 'OTP not verified or already used',
                error_code: 'OTP_INVALID_STATE'
            });
        }

        if (otpData.phone_number !== phone_number) {
            return res.status(400).json({
                error: 'Phone number mismatch',
                error_code: 'PHONE_MISMATCH'
            });
        }

        // Check expiry
        if (otpData.expires_at.toDate() < new Date()) {
            return res.status(400).json({
                error: 'OTP has expired',
                error_code: 'OTP_EXPIRED'
            });
        }

        // Check phone not already registered
        const existingUser = await db.collection('users')
            .where('phone_number', '==', phone_number)
            .limit(1)
            .get();

        if (!existingUser.empty) {
            return res.status(409).json({
                error: 'Phone number already registered',
                error_code: 'PHONE_EXISTS'
            });
        }

        // Mark OTP as used
        await otpDoc.ref.update({ used: true });

        // Create user with auto-generated ID
        const now = new Date();
        const newUserRef = db.collection('users').doc();
        await newUserRef.set({
            phone_number,
            first_name,
            last_name: last_name || '',
            is_verified: true,
            created_at: now,
            updated_at: now
        });

        const userId = newUserRef.id;

        // Generate JWT pair
        const { accessToken, refreshToken } = generateTokenPair({
            user_id: userId,
            user_type: 'user'
        });

        res.status(201).json({
            success: true,
            access_token: accessToken,
            refresh_token: refreshToken,
            user_id: userId,
            phone_number,
            first_name,
            last_name: last_name || ''
        });
    } catch (error) {
        console.error('Error in POST /public/register:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /public/refresh-token
 * Refresh access token using refresh token
 */
router.post('/refresh-token', verifySignature, async (req, res) => {
    try {
        const refreshTokenValue = req.body?.refresh_token;
        if (!refreshTokenValue) {
            return res.status(401).json({
                error: 'Refresh token required',
                error_code: 'NO_REFRESH_TOKEN'
            });
        }

        const decoded = verifyRefreshToken(refreshTokenValue);
        if (!decoded) {
            return res.status(401).json({
                error: 'Invalid or expired refresh token',
                error_code: 'INVALID_REFRESH_TOKEN'
            });
        }

        const userDoc = await db.collection('users').doc(decoded.user_id).get();
        if (!userDoc.exists) {
            return res.status(401).json({
                error: 'User not found',
                error_code: 'USER_NOT_FOUND'
            });
        }

        const { accessToken, refreshToken } = generateTokenPair({
            user_id: userDoc.id,
            user_type: 'user'
        });

        res.json({
            access_token: accessToken,
            refresh_token: refreshToken
        });
    } catch (error) {
        console.error('Error in POST /public/refresh-token:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * GET /public/me
 * Get current authenticated user's profile
 */
router.get('/me', verifySignature, authenticate, async (req, res) => {
    res.json({
        user_id: req.user.id,
        phone_number: req.user.phone_number || '',
        first_name: req.user.first_name || '',
        last_name: req.user.last_name || '',
    });
});

/**
 * GET /public/my-bookings
 * Get authenticated user's bookings
 * Query: ?business_id=optional (filter by business)
 */
router.get('/my-bookings', verifySignature, authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const businessId = req.query.business_id;

        let query = db.collection('bookings')
            .where('user_id', '==', userId)
            .orderBy('created_at', 'desc')
            .limit(50);

        if (businessId) {
            query = db.collection('bookings')
                .where('user_id', '==', userId)
                .where('business_id', '==', businessId)
                .orderBy('created_at', 'desc')
                .limit(50);
        }

        const bookingsSnapshot = await query.get();

        const bookings = bookingsSnapshot.docs.map(doc => {
            const data = doc.data();
            // Resolve multilingual business_name
            let businessName = data.business_name;
            if (typeof businessName === 'object' && businessName !== null) {
                businessName = businessName.ru || businessName.uz || '';
            }
            return {
                id: doc.id,
                business_id: data.business_id,
                business_name: businessName || '',
                booking_date: data.booking_date,
                status: data.status,
                total_price: data.total_price || 0,
                total_duration_minutes: data.total_duration_minutes || 0,
                items: (data.items || []).map(item => {
                    // Resolve multilingual service_name to string
                    let serviceName = item.service_name;
                    if (typeof serviceName === 'object' && serviceName !== null) {
                        serviceName = serviceName.ru || serviceName.uz || '';
                    }

                    // Convert ISO time strings (e.g. "2026-02-13T10:00") to seconds from midnight
                    let startTime = item.start_time;
                    let endTime = item.end_time;
                    if (typeof startTime === 'string' && startTime.includes('T')) {
                        const [h, m] = startTime.split('T')[1].split(':').map(Number);
                        startTime = h * 3600 + (m || 0) * 60;
                    }
                    if (typeof endTime === 'string' && endTime.includes('T')) {
                        const [h, m] = endTime.split('T')[1].split(':').map(Number);
                        endTime = h * 3600 + (m || 0) * 60;
                    }

                    return {
                        service_name: serviceName || '',
                        employee_name: item.employee_name || '',
                        start_time: startTime,
                        end_time: endTime,
                        price: item.price || 0,
                        duration_minutes: item.duration_minutes || 0,
                        status: item.status || 'pending'
                    };
                }),
                created_at: data.created_at?.toDate?.()?.toISOString() || null
            };
        });

        res.json({ bookings });
    } catch (error) {
        console.error('Error in GET /public/my-bookings:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * PATCH /public/my-bookings/:bookingId/cancel
 * Cancel a booking (authenticated user, must own the booking)
 */
router.patch('/my-bookings/:bookingId/cancel', verifySignature, authenticate, async (req, res) => {
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

        // Update booking status and cancel all items
        const now = new Date();
        const updatedItems = (bookingData.items || []).map(item => ({
            ...item,
            status: 'cancelled'
        }));
        await bookingDoc.ref.update({
            status: 'cancelled',
            items: updatedItems,
            updated_at: now
        });

        // Prepare notification details
        const firstItem = bookingData.items?.[0];
        const serviceName = typeof firstItem?.service_name === 'object'
            ? firstItem.service_name.uz || firstItem.service_name.ru
            : firstItem?.service_name || 'Service';
        const notificationDetails = {
            serviceName,
            customerName: bookingData.customer_name,
            date: bookingData.booking_date,
            time: firstItem?.start_time?.split('T')[1] || ''
        };

        // Send Telegram notifications
        const businessDoc = await db.collection('businesses').doc(bookingData.business_id).get();
        if (businessDoc.exists) {
            const businessData = businessDoc.data();

            // 1. Notify business bot channel
            if (businessData.telegram_bot?.is_active && businessData.telegram_bot?.chat_id) {
                try {
                    await sendBookingCancellationNotification(businessData.telegram_bot.chat_id, notificationDetails);
                } catch (telegramError) {
                    console.error('Failed to send cancellation notification to bot:', telegramError);
                }
            }

            // 2. Notify business owner via personal Telegram
            try {
                const ownerDoc = await db.collection('users').doc(businessData.business_owner_id).get();
                if (ownerDoc.exists && ownerDoc.data().telegram_id) {
                    await sendBookingCancellationNotification(ownerDoc.data().telegram_id, notificationDetails);
                }
            } catch (ownerError) {
                console.error('Failed to send cancellation notification to owner:', ownerError);
            }

            // 3. Notify assigned employees via personal Telegram
            const employeeIds = [...new Set(bookingData.items?.map(item => item.employee_id).filter(Boolean) || [])];
            for (const employeeId of employeeIds) {
                try {
                    const employeeDoc = await db.collection('businesses').doc(bookingData.business_id)
                        .collection('employees').doc(employeeId).get();
                    if (!employeeDoc.exists) continue;

                    const phoneNumber = employeeDoc.data().phone_number;
                    if (!phoneNumber) continue;

                    const usersSnapshot = await db.collection('users')
                        .where('phone_number', '==', phoneNumber)
                        .limit(1)
                        .get();

                    if (!usersSnapshot.empty && usersSnapshot.docs[0].data().telegram_id) {
                        await sendBookingCancellationNotification(usersSnapshot.docs[0].data().telegram_id, notificationDetails);
                    }
                } catch (empError) {
                    console.error(`Failed to send cancellation notification to employee ${employeeId}:`, empError);
                }
            }
        }

        res.json({
            id: bookingId,
            status: 'cancelled',
            updated_at: now.toISOString()
        });
    } catch (error) {
        console.error('Error in PATCH /public/my-bookings/:bookingId/cancel:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * PATCH /public/update-profile
 * Update authenticated user's name
 */
router.patch('/update-profile', verifySignature, authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const { first_name, last_name } = req.body;

        const updates = { updated_at: new Date() };
        if (first_name !== undefined) updates.first_name = first_name;
        if (last_name !== undefined) updates.last_name = last_name;

        await db.collection('users').doc(userId).update(updates);

        res.json({ success: true });
    } catch (error) {
        console.error('Error in PATCH /public/update-profile:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// ─── Public Slot/Employee Endpoints ───

/**
 * GET /public/businesses/:businessId/available-slots-v2
 * Returns available start times for a service chain (public website version)
 */
router.get('/businesses/:businessId/available-slots-v2', verifySignature, validate(publicAvailableSlotsQuerySchema, 'query'), async (req, res) => {
    try {
        const { businessId } = req.params;
        const { date, service_ids, employee_id } = req.validated;

        // 1. Get business and validate it exists
        const businessDoc = await db.collection('businesses').doc(businessId).get();
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
            .doc(businessId)
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
            .doc(businessId)
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
                .doc(businessId)
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
                    availability_type: empData.availability_type || 'flexible',
                    is_open_now: empData.is_open_now || false,
                    allowed_booking_count_per_slot: empData.allowed_booking_count_per_slot || 1,
                    duration_minutes: empServiceData.duration_minutes
                });
            }
        }

        // Filter to specific employee if requested
        const filteredEmployees = employee_id
            ? employeesWithFirstService.filter(e => e.id === employee_id)
            : employeesWithFirstService;

        if (filteredEmployees.length === 0) {
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
            .where('business_id', '==', businessId)
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

            for (const employee of filteredEmployees) {
                const slotEnd = slotStart + employee.duration_minutes * 60;

                // Flexible employees: only available today when is_open_now is true
                if (employee.availability_type === 'flexible') {
                    if (date !== todayUzb || !employee.is_open_now) continue;
                    if (slotEnd > businessHours.end) continue;
                } else {
                    const empHours = employee.working_hours?.[dayName];
                    if (empHours && !empHours.is_open) continue;
                    if (empHours && (slotStart < empHours.start || slotEnd > empHours.end)) continue;
                    if (slotEnd > businessHours.end) continue;
                }

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
        console.error('Error in GET /public/businesses/:businessId/available-slots-v2:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * GET /public/businesses/:businessId/slot-employees
 * Returns available employees for each service at a specific start time (public website version)
 */
router.get('/businesses/:businessId/slot-employees', verifySignature, validate(publicSlotEmployeesQuerySchema, 'query'), async (req, res) => {
    try {
        const { businessId } = req.params;
        const { date, service_ids, start_time, employee_id } = req.validated;

        // 1. Get business and validate
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

        // Compute today in Uzbekistan timezone (GMT+5)
        const nowUtc = new Date();
        const uzbekNow = new Date(nowUtc.getTime() + 5 * 60 * 60 * 1000);
        const todayUzb = uzbekNow.toISOString().split('T')[0];

        // 2. Get all employees
        const employeesSnapshot = await db.collection('businesses')
            .doc(businessId)
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
                .doc(businessId)
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
                availability_type: empData.availability_type || 'flexible',
                is_open_now: empData.is_open_now || false,
                allowed_booking_count_per_slot: empData.allowed_booking_count_per_slot || 1,
                services
            });
        }

        // 3. Get all bookings for that date
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
                .doc(businessId)
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
                if (employee_id && empId !== employee_id) continue;
                if (!employee.services.has(serviceId)) continue;

                const empService = employee.services.get(serviceId);
                const slotEnd = currentStartTime + empService.duration_minutes * 60;

                // Flexible employees: only available today when is_open_now is true
                if (employee.availability_type === 'flexible') {
                    if (date !== todayUzb || !employee.is_open_now) continue;
                    // Business is already validated as open; only check business hour bounds
                    if (slotEnd > businessHours.end) continue;
                } else {
                    const empHours = employee.working_hours?.[dayName];
                    if (empHours && !empHours.is_open) continue;
                    if (empHours && (currentStartTime < empHours.start || slotEnd > empHours.end)) continue;
                    if (slotEnd > businessHours.end) continue;
                }

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
        console.error('Error in GET /public/businesses/:businessId/slot-employees:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// ─── Public Booking Endpoint ───

/**
 * POST /public/businesses/:businessId/bookings-v2
 * Create a new booking from the public website (requires JWT auth)
 */
router.post('/businesses/:businessId/bookings-v2', verifySignature, authenticate, bookingCreateLimiter, validate(publicCreateBookingSchema), async (req, res) => {
    try {
        const { businessId } = req.params;
        const { date, start_time, services, notes } = req.validated;
        const user_id = req.user.id;

        // Validate booking date is not in the past (Uzbekistan GMT+5)
        const nowUtc = new Date();
        const uzbekToday = new Date(nowUtc.getTime() + 5 * 60 * 60 * 1000).toISOString().split('T')[0];
        if (date < uzbekToday) {
            return res.status(400).json({
                error: 'Cannot book for a past date',
                error_code: 'PAST_DATE'
            });
        }

        // 1. Get user data
        const userDoc = await db.collection('users').doc(user_id).get();
        if (!userDoc.exists) {
            return res.status(404).json({
                error: 'User not found',
                error_code: 'USER_NOT_FOUND'
            });
        }
        const userData = userDoc.data();

        // Verify user has phone number
        if (!userData.phone_number) {
            return res.status(400).json({
                error: 'Phone number is required to make a booking',
                error_code: 'PHONE_NUMBER_REQUIRED'
            });
        }

        // Check per-user active booking limit
        const bookingLimit = await checkUserBookingLimit(user_id);
        if (bookingLimit) {
            return res.status(429).json({
                error: `You have reached the maximum of ${bookingLimit.limit} active bookings`,
                error_code: 'BOOKING_LIMIT_REACHED',
                active_bookings: bookingLimit.count,
                limit: bookingLimit.limit
            });
        }

        // 2. Verify business exists and get working hours
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
                availability_type: empData.availability_type || 'flexible',
                is_open_now: empData.is_open_now || false,
                allowed_booking_count_per_slot: empData.allowed_booking_count_per_slot || 1,
                services: empServices
            });
        }

        // 4. Pre-fetch service data (doesn't race — can stay outside transaction)
        const serviceDataMap = new Map();
        for (const { service_id } of services) {
            if (serviceDataMap.has(service_id)) continue;
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
            serviceDataMap.set(service_id, serviceData);
        }

        // Pre-validate employee assignments (static data, doesn't race)
        for (const { service_id, employee_id } of services) {
            if (!employee_id) continue;
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
        }

        const bookingId = crypto.randomBytes(16).toString('hex');

        // 5. Transaction: atomic availability check + booking write
        let bookingPayload;
        let bookingItems;
        let totalPrice;
        let totalDuration;

        try {
            await db.runTransaction(async (transaction) => {
                // Read existing bookings within the transaction
                const bookingsSnapshot = await transaction.get(
                    db.collection('bookings')
                        .where('business_id', '==', businessId)
                        .where('booking_date', '==', date)
                        .where('status', 'in', ['pending', 'confirmed'])
                );

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

                // Build booking items chain
                bookingItems = [];
                let currentTime = start_time;
                totalPrice = 0;
                totalDuration = 0;

                for (let i = 0; i < services.length; i++) {
                    const { service_id, employee_id } = services[i];
                    const serviceData = serviceDataMap.get(service_id);

                    let selectedEmployee = null;
                    let selectedEmpService = null;

                    if (employee_id) {
                        selectedEmployee = employeeMap.get(employee_id);
                        selectedEmpService = selectedEmployee.services.get(service_id);
                    } else {
                        for (const [empId, emp] of employeeMap) {
                            if (!emp.services.has(service_id)) continue;

                            const empService = emp.services.get(service_id);
                            const slotEnd = currentTime + empService.duration_minutes * 60;

                            if (emp.availability_type === 'flexible') {
                                if (date !== uzbekToday || !emp.is_open_now) continue;
                                if (slotEnd > businessHours.end) continue;
                            } else {
                                const empHours = emp.working_hours?.[dayName];
                                if (empHours && !empHours.is_open) continue;
                                if (empHours && (currentTime < empHours.start || slotEnd > empHours.end)) continue;
                                if (slotEnd > businessHours.end) continue;
                            }

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
                            const err = new Error('NO_EMPLOYEE_AVAILABLE');
                            err.details = { service_id, time: secondsToTime(currentTime) };
                            throw err;
                        }
                    }

                    // Validate selected employee availability
                    const slotEnd = currentTime + selectedEmpService.duration_minutes * 60;

                    if (selectedEmployee.availability_type === 'flexible') {
                        // Flexible employees: must be open now and booking must be for today
                        if (date !== uzbekToday || !selectedEmployee.is_open_now) {
                            const err = new Error('EMPLOYEE_NOT_WORKING');
                            err.details = { employee_id: selectedEmployee.id };
                            throw err;
                        }
                        if (slotEnd > businessHours.end) {
                            throw new Error('EXCEEDS_BUSINESS_HOURS');
                        }
                    } else {
                        const empHours = selectedEmployee.working_hours?.[dayName];
                        if (empHours && !empHours.is_open) {
                            const err = new Error('EMPLOYEE_NOT_WORKING');
                            err.details = { employee_id: selectedEmployee.id };
                            throw err;
                        }
                        if (empHours && (currentTime < empHours.start || slotEnd > empHours.end)) {
                            const err = new Error('EMPLOYEE_NOT_AVAILABLE');
                            err.details = { employee_id: selectedEmployee.id, time: secondsToTime(currentTime) };
                            throw err;
                        }
                        if (slotEnd > businessHours.end) {
                            throw new Error('EXCEEDS_BUSINESS_HOURS');
                        }
                    }

                    const empBookings = employeeBookings.get(selectedEmployee.id) || [];
                    let bookingCount = 0;
                    for (const booking of empBookings) {
                        if (!(slotEnd <= booking.start || currentTime >= booking.end)) {
                            bookingCount++;
                        }
                    }

                    if (bookingCount >= selectedEmployee.allowed_booking_count_per_slot) {
                        const err = new Error('SLOT_NOT_AVAILABLE');
                        err.details = { employee_id: selectedEmployee.id, time: secondsToTime(currentTime) };
                        throw err;
                    }

                    // Add to employee bookings map (for subsequent services in chain)
                    if (!employeeBookings.has(selectedEmployee.id)) {
                        employeeBookings.set(selectedEmployee.id, []);
                    }
                    employeeBookings.get(selectedEmployee.id).push({ start: currentTime, end: slotEnd });

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

                // Check user booking conflicts
                const bookingEndTime = currentTime;
                const userBookingsSnapshot = await transaction.get(
                    db.collection('bookings')
                        .where('user_id', '==', user_id)
                        .where('booking_date', '==', date)
                        .where('status', 'in', ['pending', 'confirmed'])
                );

                for (const existingBookingDoc of userBookingsSnapshot.docs) {
                    const existingBooking = existingBookingDoc.data();
                    const existingItems = existingBooking.items || [];
                    if (existingItems.length === 0) continue;

                    const firstItem = existingItems[0];
                    const lastItemExist = existingItems[existingItems.length - 1];

                    const existingStartTime = firstItem.start_time.split('T')[1];
                    const [startHours, startMinutes] = existingStartTime.split(':').map(Number);
                    const existingStart = startHours * 3600 + startMinutes * 60;

                    const existingEndTime = lastItemExist.end_time.split('T')[1];
                    const [endHours, endMinutes] = existingEndTime.split(':').map(Number);
                    const existingEnd = endHours * 3600 + endMinutes * 60;

                    const hasOverlap = !(bookingEndTime <= existingStart || start_time >= existingEnd);

                    if (hasOverlap) {
                        const err = new Error('USER_TIME_CONFLICT');
                        err.details = {
                            id: existingBookingDoc.id,
                            business_name: existingBooking.business_name,
                            start_time: firstItem.start_time,
                            end_time: lastItemExist.end_time
                        };
                        throw err;
                    }
                }

                // Write booking atomically
                const now = new Date();
                const customerName = [userData.first_name, userData.last_name].filter(Boolean).join(' ') || 'Website User';

                bookingPayload = {
                    business_id: businessId,
                    business_name: businessData.business_name,
                    user_id,
                    customer_name: customerName,
                    customer_phone: userData.phone_number || '',
                    booking_date: date,
                    status: 'confirmed',
                    total_price: totalPrice,
                    total_duration_minutes: totalDuration,
                    notes: notes || '',
                    items: bookingItems,
                    created_at: now,
                    updated_at: now
                };

                transaction.set(db.collection('bookings').doc(bookingId), bookingPayload);
            });
        } catch (txError) {
            if (txError.message === 'SLOT_NOT_AVAILABLE') {
                return res.status(409).json({
                    error: `Employee ${txError.details.employee_id} is fully booked at ${txError.details.time}`,
                    error_code: 'SLOT_NOT_AVAILABLE'
                });
            }
            if (txError.message === 'NO_EMPLOYEE_AVAILABLE') {
                return res.status(409).json({
                    error: `No available employee for service ${txError.details.service_id} at ${txError.details.time}`,
                    error_code: 'NO_EMPLOYEE_AVAILABLE'
                });
            }
            if (txError.message === 'EMPLOYEE_NOT_WORKING') {
                return res.status(409).json({
                    error: `Employee ${txError.details.employee_id} is not working on this day`,
                    error_code: 'EMPLOYEE_NOT_WORKING'
                });
            }
            if (txError.message === 'EMPLOYEE_NOT_AVAILABLE') {
                return res.status(409).json({
                    error: `Employee ${txError.details.employee_id} is not available at ${txError.details.time}`,
                    error_code: 'EMPLOYEE_NOT_AVAILABLE'
                });
            }
            if (txError.message === 'EXCEEDS_BUSINESS_HOURS') {
                return res.status(409).json({
                    error: 'Booking exceeds business hours',
                    error_code: 'EXCEEDS_BUSINESS_HOURS'
                });
            }
            if (txError.message === 'USER_TIME_CONFLICT') {
                return res.status(409).json({
                    error: 'You already have a booking during this time',
                    error_code: 'USER_TIME_CONFLICT',
                    conflicting_booking: txError.details
                });
            }
            throw txError;
        }

        res.status(201).json({
            id: bookingId,
            ...bookingPayload,
            created_at: bookingPayload.created_at.toISOString(),
            updated_at: bookingPayload.updated_at.toISOString()
        });
    } catch (error) {
        console.error('Error in POST /public/businesses/:businessId/bookings-v2:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// ─── Review Endpoints (token-based, no auth) ───

/**
 * GET /public/reviews/:token
 * Fetch review data by token. No authentication required.
 * Returns 404 if not found, 410 if expired (14 days).
 */
router.get('/reviews/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const reviewDoc = await db.collection('reviews').doc(token).get();
        if (!reviewDoc.exists) {
            return res.status(404).json({ error: 'Review not found', error_code: 'NOT_FOUND' });
        }

        const review = reviewDoc.data();

        // Check 14-day expiry
        const createdAt = review.created_at instanceof Date ? review.created_at : review.created_at.toDate();
        const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation > 14) {
            return res.status(410).json({ error: 'Review link has expired', error_code: 'EXPIRED' });
        }

        res.json({
            token,
            business_name: review.business_name,
            customer_name: review.customer_name,
            booking_date: review.booking_date,
            items: review.items.map(item => ({
                booking_item_id: item.booking_item_id,
                service_name: item.service_name,
                employee_name: item.employee_name,
                start_time: item.start_time,
                price: item.price,
                rating: item.rating
            })),
            status: review.status,
            comment: review.comment
        });
    } catch (error) {
        console.error('Error in GET /public/reviews/:token:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * POST /public/reviews/:token
 * Submit ratings for each service item + optional comment.
 * All item IDs must match the review document.
 * Updates business review_stats atomically.
 */
router.post('/reviews/:token', validate(submitReviewSchema), async (req, res) => {
    try {
        const { token } = req.params;
        const { ratings, comment } = req.validated;

        const reviewRef = db.collection('reviews').doc(token);
        const reviewDoc = await reviewRef.get();

        if (!reviewDoc.exists) {
            return res.status(404).json({ error: 'Review not found', error_code: 'NOT_FOUND' });
        }

        const review = reviewDoc.data();

        // Check if already submitted
        if (review.status === 'submitted') {
            return res.status(409).json({ error: 'Review already submitted', error_code: 'ALREADY_SUBMITTED' });
        }

        // Check 14-day expiry
        const createdAt = review.created_at instanceof Date ? review.created_at : review.created_at.toDate();
        const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation > 14) {
            return res.status(410).json({ error: 'Review link has expired', error_code: 'EXPIRED' });
        }

        // Validate all item IDs match
        const reviewItemIds = new Set(review.items.map(i => i.booking_item_id));
        const submittedItemIds = new Set(ratings.map(r => r.booking_item_id));

        if (reviewItemIds.size !== submittedItemIds.size) {
            return res.status(400).json({
                error: 'Must rate all services',
                error_code: 'INCOMPLETE_RATINGS'
            });
        }
        for (const id of submittedItemIds) {
            if (!reviewItemIds.has(id)) {
                return res.status(400).json({
                    error: `Unknown booking_item_id: ${id}`,
                    error_code: 'INVALID_ITEM_ID'
                });
            }
        }

        // Build rating lookup
        const ratingMap = new Map(ratings.map(r => [r.booking_item_id, r.rating]));

        // Update items with ratings
        const updatedItems = review.items.map(item => ({
            ...item,
            rating: ratingMap.get(item.booking_item_id)
        }));

        // Calculate stats for business update
        const allRatings = ratings.map(r => r.rating);
        const ratingSum = allRatings.reduce((sum, r) => sum + r, 0);
        const ratingCount = allRatings.length;

        // Atomic transaction: update review + business stats
        await db.runTransaction(async (transaction) => {
            // Update review doc
            transaction.update(reviewRef, {
                items: updatedItems,
                status: 'submitted',
                comment: comment || '',
                submitted_at: new Date()
            });

            // Update business review_stats
            const businessRef = db.collection('businesses').doc(review.business_id);
            const businessDoc = await transaction.get(businessRef);

            if (businessDoc.exists) {
                const business = businessDoc.data();
                const stats = business.review_stats || {
                    average_rating: 0,
                    total_reviews: 0,
                    rating_distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
                };

                const newTotal = stats.total_reviews + ratingCount;
                const newAvg = ((stats.average_rating * stats.total_reviews) + ratingSum) / newTotal;
                const newDistribution = { ...stats.rating_distribution };
                for (const r of allRatings) {
                    newDistribution[r] = (newDistribution[r] || 0) + 1;
                }

                transaction.update(businessRef, {
                    review_stats: {
                        average_rating: Math.round(newAvg * 100) / 100,
                        total_reviews: newTotal,
                        rating_distribution: newDistribution
                    }
                });
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error in POST /public/reviews/:token:', error);
        res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
