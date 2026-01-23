import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { placeSearchSchema } from '../schemas/places.js';

const router = Router();

// Search places using Google Places Autocomplete API (restricted to Uzbekistan)
router.get('/search', validate(placeSearchSchema, 'query'), async (req, res) => {
    try {
        const { query } = req.validated;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Places API key not configured', error_code: 'API_KEY_MISSING' });
        }

        // Use autocomplete with strict country filter
        const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&components=country:uz&key=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
            return res.status(400).json({
                error: data.error_message || 'Failed to search places',
                error_code: data.status
            });
        }

        // Beauty/wellness types to filter by
        const beautyTypes = ['hair_care', 'health', 'beauty_salon', 'spa'];

        // Format and filter results to only include beauty/wellness places
        const places = (data.predictions || [])
            .filter(place => {
                const types = place.types || [];
                return types.some(type => beautyTypes.includes(type));
            })
            .map(place => ({
                place_id: place.place_id,
                name: place.structured_formatting?.main_text,
                description: place.description,
                secondary_text: place.structured_formatting?.secondary_text,
                types: place.types || [],
                reference: place.reference
            }));

        res.json({
            results: places,
            total: places.length,
            status: data.status
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

// Get place opening hours by place_id (authenticated)
router.get('/:placeId/details', authenticate, async (req, res) => {
    try {
        const { placeId } = req.params;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({
                error: 'Google Places API key not configured',
                error_code: 'API_KEY_MISSING'
            });
        }

        const params = new URLSearchParams({
            place_id: placeId,
            key: apiKey,
            language: 'uz',
            fields: 'opening_hours,international_phone_number,geometry,address_components,formatted_address'
        });

        const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            return res.status(400).json({
                error: data.error_message || 'Failed to get place details',
                error_code: data.status
            });
        }

        const result = data.result;
        const openingHours = result?.opening_hours;

        /** ---------------- ADDRESS PARSING (UZ) ---------------- */
        const getComponent = (type) =>
            result.address_components?.find(c => c.types.includes(type))?.long_name || null;

        let region =
            getComponent('administrative_area_level_1') ||
            getComponent('administrative_area_level_2');

        let city =
            getComponent('locality') ||
            getComponent('administrative_area_level_3') ||
            getComponent('sublocality');

        const street_name = [getComponent('route'), getComponent('street_number')]
            .filter(Boolean)
            .join(' ') || null;

        const country = getComponent('country');

        const display_name = result.formatted_address || null;

        // Special case: Tashkent city
        if (region?.includes('Tashkent') && !city) {
            city = 'Tashkent';
        }

        const address = {
            street_name,
            city,
            region,
            country,
            display_name
        };

        /** ---------------- LOCATION ---------------- */
        const location = {
            lat: result.geometry?.location?.lat || null,
            lng: result.geometry?.location?.lng || null
        };

        /** ---------------- OPENING HOURS ---------------- */
        // Day order: Sunday=0, Monday=1, ..., Saturday=6
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

        // Convert "HHMM" format to seconds from midnight
        const timeToSeconds = (timeStr) => {
            if (!timeStr) return null;
            const hours = parseInt(timeStr.slice(0, 2), 10);
            const minutes = parseInt(timeStr.slice(2), 10);
            return hours * 3600 + minutes * 60;
        };

        // Initialize all days as closed
        const workingHours = {
            monday: { start: 0, end: 86399, is_open: false },
            tuesday: { start: 0, end: 86399, is_open: false },
            wednesday: { start: 0, end: 86399, is_open: false },
            thursday: { start: 0, end: 86399, is_open: false },
            friday: { start: 0, end: 86399, is_open: false },
            saturday: { start: 0, end: 86399, is_open: false },
            sunday: { start: 0, end: 86399, is_open: false }
        };

        // Fill in opening hours from Google Places API
        if (openingHours?.periods) {
            for (const period of openingHours.periods) {
                const dayIndex = period.open.day; // 0=Sunday, 1=Monday, etc.
                const dayName = dayNames[dayIndex];
                const start = timeToSeconds(period.open.time);
                const end = timeToSeconds(period.close?.time);

                workingHours[dayName] = {
                    start,
                    end,
                    is_open: true
                };
            }
        }

        res.json({
            place_id: placeId,
            international_phone_number: result.international_phone_number || null,
            formatted_address: result.formatted_address || null,
            location,
            address,
            working_hours
        });

    } catch (error) {
        res.status(500).json({
            error: error.message,
            error_code: 'INTERNAL_ERROR'
        });
    }
});

// Photo proxy endpoint (hides API key from client)
router.get('/photo/:photoReference', async (req, res) => {
    try {
        const { photoReference } = req.params;
        const maxwidth = req.query.maxwidth || 400;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Places API key not configured', error_code: 'API_KEY_MISSING' });
        }

        const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photoreference=${photoReference}&key=${apiKey}`;

        const response = await fetch(url);

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Failed to fetch photo', error_code: 'PHOTO_FETCH_ERROR' });
        }

        // Forward the image
        res.set('Content-Type', response.headers.get('content-type'));
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
