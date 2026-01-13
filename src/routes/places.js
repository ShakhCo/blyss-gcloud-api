import { Router } from 'express';
import { validate } from '../middleware/validate.js';
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

// Get place opening hours by place_id
router.get('/:placeId/details', async (req, res) => {
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
            fields: 'name,opening_hours,photos,international_phone_number,address_components,formatted_address'
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

        // Special case: Toshkent city
        if (region?.includes('Tashkent') && !city) {
            city = 'Tashkent';
        }

        const address = {
            region,
            city,
            street_name
        };

        /** ---------------- OPENING HOURS ---------------- */
        const openingHours = result.opening_hours || null;

        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const formatTime = (time) =>
            time ? `${time.slice(0, 2)}:${time.slice(2)}` : null;

        const schedule = openingHours?.periods?.map(period => ({
            day: period.open.day,
            day_name: dayNames[period.open.day],
            working_hours: {
                start_time: formatTime(period.open.time),
                end_time: formatTime(period.close?.time)
            }
        })) || [];

        /** ---------------- PHOTOS ---------------- */
        const photos = (result.photos || []).map(photo => ({
            height: photo.height,
            width: photo.width,
            photo_reference: photo.photo_reference,
            photo_url: `/places/photo/${photo.photo_reference}`
        }));

        /** ---------------- RESPONSE ---------------- */
        res.json({
            place_id: placeId,
            name: result.name,
            international_phone_number: result.international_phone_number || null,

            address,

            open_now: openingHours?.open_now ?? null,
            weekday_text: openingHours?.weekday_text || [],
            schedule,
            photos
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
