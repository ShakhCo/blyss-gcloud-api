import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { placeSearchSchema } from '../schemas/places.js';

const router = Router();

// Search places using Google Places API
router.get('/search', validate(placeSearchSchema, 'query'), async (req, res) => {
    try {
        const { query } = req.validated;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Places API key not configured', error_code: 'API_KEY_MISSING' });
        }

        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
            return res.status(400).json({
                error: data.error_message || 'Failed to search places',
                error_code: data.status
            });
        }

        // Format results
        const places = (data.results || []).map(place => ({
            place_id: place.place_id,
            name: place.name,
            address: place.formatted_address,
            location: {
                lat: place.geometry?.location?.lat,
                lng: place.geometry?.location?.lng
            },
            rating: place.rating ?? null,
            user_ratings_total: place.user_ratings_total ?? null,
            types: place.types || [],
            open_now: place.opening_hours?.open_now ?? null,
            photo_url: place.photos?.[0]?.photo_reference
                ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${place.photos[0].photo_reference}&key=${apiKey}`
                : null
        }));

        res.json({
            results: places,
            total: places.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
