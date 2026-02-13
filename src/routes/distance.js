import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { distanceQuerySchema } from '../schemas/distance.js';

const router = Router();

const OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY;

if (!OPENROUTESERVICE_API_KEY) {
    console.warn('WARNING: OPENROUTESERVICE_API_KEY not set in environment variables');
}

// Simple in-memory cache for distance calculations
// Key format: "lat1,lng1-lat2,lng2" (rounded to 4 decimal places)
const distanceCache = new Map();
const MAX_CACHE_SIZE = 1000;

/**
 * Generate cache key from two locations
 * Rounds coordinates to 4 decimal places (~11m precision) for better cache hits
 */
function getCacheKey(lat1, lng1, lat2, lng2) {
    const precision = 10000;
    const rLat1 = Math.round(lat1 * precision) / precision;
    const rLng1 = Math.round(lng1 * precision) / precision;
    const rLat2 = Math.round(lat2 * precision) / precision;
    const rLng2 = Math.round(lng2 * precision) / precision;
    return `${rLat1},${rLng1}-${rLat2},${rLng2}`;
}

/**
 * Add item to cache with LRU eviction if cache is full
 */
function setCache(key, value) {
    if (distanceCache.size >= MAX_CACHE_SIZE) {
        // Delete first (oldest) entry
        const firstKey = distanceCache.keys().next().value;
        distanceCache.delete(firstKey);
    }
    distanceCache.set(key, value);
}

/**
 * Middleware to parse nested query parameters like user_location[lat]=41.2995
 * into nested objects { user_location: { lat: 41.2995 } }
 * Stores result in req.parsedQuery for validation middleware to use
 */
function parseNestedQuery(req, res, next) {
    const parsed = {};
    for (const [key, value] of Object.entries(req.query)) {
        const match = key.match(/^(\w+)\[(\w+)\]$/);
        if (match) {
            const [, parent, child] = match;
            if (!parsed[parent]) parsed[parent] = {};
            parsed[parent][child] = value;
        } else if (!parsed[key]) {
            // Only add non-nested params if not already added
            parsed[key] = value;
        }
    }
    // Store parsed query for validation middleware
    req.parsedQuery = { ...req.query, ...parsed };
    next();
}

/**
 * Calculate road distance and travel time between two locations using OpenRouteService Matrix API
 * Query params: user_location (required), business_location (required)
 * Returns: { distance: number, metric: 'km' | 'm', duration: number (minutes) }
 */
router.get('/', parseNestedQuery, validate(distanceQuerySchema, 'query'), async (req, res) => {
    try {
        const { user_location, business_location } = req.validated;

        // Check cache first
        const cacheKey = getCacheKey(user_location.lat, user_location.lng, business_location.lat, business_location.lng);
        const cachedResult = distanceCache.get(cacheKey);

        if (cachedResult) {
            return res.json(cachedResult);
        }

        if (!OPENROUTESERVICE_API_KEY) {
            console.error('OPENROUTESERVICE_API_KEY is not set in environment variables');
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

        // Extract distance and duration from user (index 0) to business (index 1)
        const distanceInKm = data.distances?.[0]?.[1];
        const durationInSeconds = data.durations?.[0]?.[1];

        if (distanceInKm === undefined || distanceInKm === null) {
            return res.status(500).json({
                error: 'Unable to calculate distance between locations',
                error_code: 'DISTANCE_NOT_AVAILABLE'
            });
        }

        // Convert duration to minutes (round up to nearest minute)
        const durationInMinutes = durationInSeconds ? Math.ceil(durationInSeconds / 60) : null;

        // Format response
        let result;
        if (distanceInKm < 1) {
            // Convert to meters and round to nearest meter
            const distanceInMeters = Math.round(distanceInKm * 1000);
            result = { distance: distanceInMeters, metric: 'm', duration: durationInMinutes };
        } else {
            // Round to 1 decimal place for km
            const roundedKm = Math.round(distanceInKm * 10) / 10;
            result = { distance: roundedKm, metric: 'km', duration: durationInMinutes };
        }

        // Cache the result
        setCache(cacheKey, result);

        res.json(result);

    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
