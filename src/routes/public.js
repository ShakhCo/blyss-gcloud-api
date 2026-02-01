import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db/db.js';
import { authenticate } from '../middleware/authenticate.js';

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
                tenant_url: businessData.tenant_url
            },
            services
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

/**
 * Get business details with services by business ID (authenticated users only)
 * Example: GET /public/businesses-auth/abc123xyz/services
 * Requires authentication with user type 'user'
 * Returns business with id field
 */
router.get('/businesses/:businessId/details', authenticate, async (req, res) => {
    try {
        // Only users can access this endpoint
        if (req.user.user_type !== 'user') {
            return res.status(403).json({
                error: 'Only users can access this endpoint',
                error_code: 'FORBIDDEN'
            });
        }

        const { businessId } = req.params;

        // Find business by ID
        const businessDoc = await db.collection('businesses').doc(businessId).get();

        if (!businessDoc.exists) {
            return res.status(404).json({
                error: 'Business not found',
                error_code: 'BUSINESS_NOT_FOUND'
            });
        }

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
                id: businessId,
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

export default router;
