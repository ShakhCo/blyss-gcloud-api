import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { placeSearchSchema } from '../schemas/places.js';

const router = Router();

// Search places using Google Places API (restricted to Uzbekistan, beauty/wellness)
router.get('/search', validate(placeSearchSchema, 'query'), async (req, res) => {
    try {
        const { query } = req.validated;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Places API key not configured', error_code: 'API_KEY_MISSING' });
        }

        // Uzbekistan center coordinates and search parameters
        const uzbekistanLat = 41.377491;
        const uzbekistanLng = 64.585262;
        const radiusMeters = 800000; // 800km to cover all of Uzbekistan

        // Search for beauty/wellness places
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${uzbekistanLat},${uzbekistanLng}&radius=${radiusMeters}&region=uz&type=beauty_salon&key=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
            return res.status(400).json({
                error: data.error_message || 'Failed to search places',
                error_code: data.status
            });
        }

        // Format results with all data
        const places = (data.results || []).map(place => ({
            place_id: place.place_id,
            name: place.name,
            business_status: place.business_status ?? null,
            formatted_address: place.formatted_address,
            geometry: place.geometry,
            icon: place.icon,
            icon_background_color: place.icon_background_color,
            icon_mask_base_uri: place.icon_mask_base_uri,
            opening_hours: place.opening_hours ?? null,
            photos: place.photos?.map(photo => ({
                height: photo.height,
                width: photo.width,
                photo_reference: photo.photo_reference,
                photo_url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photo.photo_reference}&key=${apiKey}`
            })) ?? [],
            rating: place.rating ?? null,
            user_ratings_total: place.user_ratings_total ?? null,
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
router.get('/:placeId/hours', async (req, res) => {
    try {
        const { placeId } = req.params;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Places API key not configured', error_code: 'API_KEY_MISSING' });
        }

        const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&key=${apiKey}&fields=opening_hours,name`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            return res.status(400).json({
                error: data.error_message || 'Failed to get place details',
                error_code: data.status
            });
        }

        const openingHours = data.result?.opening_hours;

        if (!openingHours) {
            return res.status(404).json({
                error: 'Opening hours not available for this place',
                error_code: 'NO_OPENING_HOURS'
            });
        }

        // Day names mapping
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        // Format time from "1000" to "10:00"
        const formatTime = (time) => {
            if (!time) return null;
            return `${time.slice(0, 2)}:${time.slice(2)}`;
        };

        // Format periods into nice structure
        const schedule = openingHours.periods?.map(period => ({
            day: period.open.day,
            day_name: dayNames[period.open.day],
            working_hours: {
                start_time: formatTime(period.open.time),
                end_time: formatTime(period.close?.time)
            }
        })) || [];

        res.json({
            place_id: placeId,
            name: data.result?.name,
            open_now: openingHours.open_now,
            schedule,
            weekday_text: openingHours.weekday_text || []
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
