import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { distanceQuerySchema } from '../schemas/distance.js';

const router = Router();

const OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY;

if (!OPENROUTESERVICE_API_KEY) {
    console.warn('WARNING: OPENROUTESERVICE_API_KEY not set in environment variables');
}

/**
 * Calculate road distance between two locations using OpenRouteService Matrix API
 * Query params: user_location (required), business_location (required)
 * Returns: { distance: number, metric: 'km' | 'm' }
 */
router.get('/', validate(distanceQuerySchema, 'query'), async (req, res) => {
    try {
        const { user_location, business_location } = req.validated;

        if (!OPENROUTESERVICE_API_KEY) {
            return res.status(500).json({
                error: 'OpenRouteService API key not configured',
                error_code: 'API_KEY_MISSING'
            });
        }

        // OpenRouteService expects [lng, lat] format
        const locations = [
            [user_location.lng, user_location.lat],
            [business_location.lng, business_location.lat]
        ];

        const response = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
            method: 'POST',
            headers: {
                'Authorization': OPENROUTESERVICE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                locations,
                metrics: ['distance'],
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

        // Extract distance from user (index 0) to business (index 1)
        const distanceInKm = data.distances?.[0]?.[1];

        if (distanceInKm === undefined || distanceInKm === null) {
            return res.status(500).json({
                error: 'Unable to calculate distance between locations',
                error_code: 'DISTANCE_NOT_AVAILABLE'
            });
        }

        // Return in meters if less than 1km, otherwise in kilometers
        if (distanceInKm < 1) {
            // Convert to meters and round to nearest meter
            const distanceInMeters = Math.round(distanceInKm * 1000);
            res.json({ distance: distanceInMeters, metric: 'm' });
        } else {
            // Round to 1 decimal place for km
            const roundedKm = Math.round(distanceInKm * 10) / 10;
            res.json({ distance: roundedKm, metric: 'km' });
        }

    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
