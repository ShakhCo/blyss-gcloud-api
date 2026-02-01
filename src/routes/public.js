import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db/db.js';
import { authenticate, verifySignature } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { nearestBusinessesQuerySchema } from '../schemas/business.js';

const router = Router();

/**
 * Apply rate limiting to all public routes
 */
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
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
            business_type: businessData.business_type,
            location: businessData.location,
            working_hours: businessData.working_hours,
            business_phone_number: businessData.business_phone_number,
            tenant_url: businessData.tenant_url
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * Get services by business slug
 * Alternative endpoint that accepts slug as a path parameter
 * Example: GET /public/businesses/my-salon/services
 */
router.get('/businesses/:slug/services', async (req, res) => {
    try {
        const { slug } = req.params;
        const zoneDomain = process.env.CLOUDFLARE_ZONE_DOMAIN || 'blyss.uz';
        const tenantUrl = `${slug}.${zoneDomain}`;

        // Find business by tenant_url
        const businessesSnapshot = await db.collection('businesses')
            .where('tenant_url', '==', tenantUrl)
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

        res.json({
            business: {
                name: businessData.business_name,
                business_type: businessData.business_type,
                location: businessData.location,
                working_hours: formatWorkingHours(businessData.working_hours),
                business_phone_number: businessData.business_phone_number,
                tenant_url: businessData.tenant_url,
                avatar_url: businessData.avatar_url || null
            },
            services
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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

        // Fetch business and services in parallel
        const [businessDoc, servicesSnapshot] = await Promise.all([
            db.collection('businesses').doc(businessId).get(),
            db.collection('businesses')
                .doc(businessId)
                .collection('services')
                .where('is_active', '==', true)
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
                price: data.price
            };
        });

        res.json({
            business_id: businessId,
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
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
        const { lat, lng, radius = 10, page = 1, page_size = 5 } = req.validated;

        // Fetch all businesses with locations
        const businessesSnapshot = await db.collection('businesses')
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

            if (distance <= radius) {
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
                    name: serviceData.name || { ru: '', uz: '' }
                };
            });

            // Convert to meters if less than 1km
            const distanceValue = business.distance < 1
                ? Math.round(business.distance * 1000)
                : Math.round(business.distance * 100) / 100;
            const distanceMetric = business.distance < 1 ? 'm' : 'km';

            businessesWithDistance.push({
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
